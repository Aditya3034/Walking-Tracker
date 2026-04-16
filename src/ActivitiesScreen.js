import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  ScrollView,
  Modal,
  TouchableOpacity,
  DeviceEventEmitter,
} from 'react-native';
import Svg, { Polyline, Rect, Circle, Path } from 'react-native-svg';

function ChevronLeft({ size = 16, color = '#0f172a' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M15 18l-6-6 6-6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function ChevronRight({ size = 16, color = '#0f172a' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M9 18l6-6-6-6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');

const CAL_PAD  = 14;
const COL_GAP  = 5;
const ROW_GAP  = 5;
const COLS     = 7;
const CELL_W   = Math.floor((width - CAL_PAD * 2 - COL_GAP * (COLS - 1)) / COLS);
const CELL_H   = Math.round(CELL_W * 1.38) - 2;
const CELL_R   = Math.round(CELL_W * 0.36); // pill radius

const SESSION_W = width - 80;
const SESSION_H = 160;

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

const C = {
  bg:      '#ffffff',
  card:    '#ffffff',
  text:    '#0f172a',
  text2:   '#475569',
  text3:   '#94a3b8',
  border:  '#e2e8f0',
  active:  '#0f172a',
  trace:   '#f1f5f9',
};

/* ---------------- HELPERS ---------------- */

function getSessionSegmentsXY(session) {
  if (session.segments && session.segments.length > 0) {
    return session.segments.map(seg =>
      (seg || []).map(p => ({ x: p.longitude, y: -p.latitude }))
    );
  }
  return [(session.route || []).map(p => ({ x: p.longitude, y: -p.latitude }))];
}

function normalizeSegmentsSquare(segments, w, h, paddingX = 7, paddingY = paddingX) {
  const allXY = segments.flat();
  if (allXY.length < 2) return segments.map(() => []);
  const xs = allXY.map(p => p.x);
  const ys = allXY.map(p => p.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const scale = Math.min(
    (w - paddingX * 2) / (maxX - minX || 1),
    (h - paddingY * 2) / (maxY - minY || 1),
  );
  const ox = (w - (maxX - minX) * scale) / 2;
  const oy = (h - (maxY - minY) * scale) / 2;
  return segments.map(seg =>
    seg.map(p => ({
      x: ox + (p.x - minX) * scale,
      y: oy + (p.y - minY) * scale,
    }))
  );
}

function normalizeSegmentsRect(segments, w, h, padding = 16) {
  const allXY = segments.flat();
  if (allXY.length < 2) return segments.map(() => []);
  const xs = allXY.map(p => p.x);
  const ys = allXY.map(p => p.y);
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const scale = Math.min((w - padding * 2) / (maxX - minX || 1), (h - padding * 2) / (maxY - minY || 1));
  const ox = (w - (maxX - minX) * scale) / 2;
  const oy = (h - (maxY - minY) * scale) / 2;
  return segments.map(seg =>
    seg.map(p => ({
      x: ox + (p.x - minX) * scale,
      y: oy + (p.y - minY) * scale,
    }))
  );
}

function haversineDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const R = 6371000;
    const φ1 = points[i-1].latitude * Math.PI / 180;
    const φ2 = points[i].latitude   * Math.PI / 180;
    const Δφ = (points[i].latitude  - points[i-1].latitude)  * Math.PI / 180;
    const Δλ = (points[i].longitude - points[i-1].longitude) * Math.PI / 180;
    const a = Math.sin(Δφ/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)**2;
    total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }
  return total;
}

function calcSessionDistance(session) {
  const segs = (session.segments && session.segments.length > 0)
    ? session.segments : [session.route || []];
  return segs.reduce((sum, seg) => sum + haversineDistance(seg), 0);
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('default', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- DAY CELL ---------------- */
function DayCell({ day, active, faded, segments, traceColor = '#EE5514', onPress }) {
  const segs = normalizeSegmentsSquare(segments, CELL_W, CELL_H, 9, 18);
  const hasTrace = segs.flat().length >= 2;

  return (
    <TouchableOpacity
      style={[cs.cell, active && cs.cellActive, faded && cs.cellFaded]}
      onPress={active ? onPress : undefined}
      activeOpacity={active ? 0.75 : 1}
    >
      {/* Date number — rendered first so trace sits on top */}
      <Text style={[cs.dayNum, active ? cs.dayNumActive : faded ? cs.dayNumFaded : cs.dayNumInactive]}>
        {String(day).padStart(2, '0')}
      </Text>

      {/* Route trace overlaid on top */}
      {hasTrace && (
        <Svg width={CELL_W} height={CELL_H} style={StyleSheet.absoluteFill} pointerEvents="none">
          {segs.map((seg, i) => {
            if (seg.length < 2) return null;
            return (
              <Polyline
                key={i}
                points={seg.map(p => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={traceColor}
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}
        </Svg>
      )}
    </TouchableOpacity>
  );
}

/* ---------------- SESSION CARD ---------------- */
function SessionCard({ session, index }) {
  const segsXY = getSessionSegmentsXY(session);
  const norm   = normalizeSegmentsRect(segsXY, SESSION_W, SESSION_H);
  const dist   = calcSessionDistance(session);

  return (
    <View style={ss.card}>
      <Svg width={SESSION_W} height={SESSION_H}>
        <Rect x="0" y="0" width={SESSION_W} height={SESSION_H} rx="14" fill="#f1f5f9" />
        {norm.map((seg, i) => {
          if (seg.length < 2) return null;
          return (
            <Polyline
              key={i}
              points={seg.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={C.text}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </Svg>
      <View style={ss.meta}>
        <View style={ss.left}>
          <View style={ss.badge}>
            <Text style={ss.badgeText}>{index + 1}</Text>
          </View>
          <Text style={ss.steps}>{session.steps.toLocaleString()} steps</Text>
          {dist > 0 && <Text style={ss.dist}>{formatDistance(dist)}</Text>}
        </View>
        {session.timestamp ? <Text style={ss.time}>{formatTime(session.timestamp)}</Text> : null}
      </View>
    </View>
  );
}

/* ---------------- MAIN ---------------- */
export default function ActivitiesScreen({ isActive = false }) {
  const now = new Date();
  const [viewYear,  setViewYear]  = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [activities, setActivities] = useState({});
  const [selectedDate, setSelectedDate] = useState(null);
  const [petColor, setPetColor] = useState('#EE5514');

  useEffect(() => {
    AsyncStorage.getItem('petColor').then(val => {
      if (val && val !== '#f1f5f9' && val !== '#ffffff') setPetColor(val);
    }).catch(() => {});

    const sub = DeviceEventEmitter.addListener('petColorChange', color => setPetColor(color));
    return () => sub.remove();
  }, []);

  const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();

  const monthLabel = new Date(viewYear, viewMonth, 1)
    .toLocaleString('default', { month: 'long', year: 'numeric' })
    .toUpperCase();

  const goToPrev = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const goToNext = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const loadData = async () => {
    try {
      const stored = await AsyncStorage.getItem('activities');
      if (stored) setActivities(JSON.parse(stored));
    } catch (e) {}
  };

  useEffect(() => { loadData(); }, []);
  useEffect(() => {
    if (!isActive) return;
    loadData();
    const iv = setInterval(loadData, 2000);
    return () => clearInterval(iv);
  }, [isActive]);

  /* Build calendar grid — leading/trailing overflow days included */
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();   // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();

  const cells = [];

  // Leading overflow (prev month)
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ day: prevMonthDays - i, dateStr: null, overflow: true });
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    cells.push({ day: d, dateStr, overflow: false });
  }
  // Trailing overflow (next month)
  const trailing = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= trailing; i++) {
    cells.push({ day: i, dateStr: null, overflow: true });
  }

  const activeDaysCount = cells.filter(c => c.dateStr && activities[c.dateStr]).length;

  /* Selected day data */
  const selectedSessions = selectedDate && activities[selectedDate]
    ? (Array.isArray(activities[selectedDate]) ? activities[selectedDate] : [activities[selectedDate]])
    : [];
  const totalSteps    = selectedSessions.reduce((s, x) => s + (x.steps || 0), 0);
  const totalDistance = selectedSessions.reduce((s, x) => s + calcSessionDistance(x), 0);

  return (
    <>
      <ScrollView
        style={{ flex: 1, backgroundColor: C.bg }}
        contentContainerStyle={{ paddingHorizontal: CAL_PAD, paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Month header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.navBtn} onPress={goToPrev} activeOpacity={0.6}>
            <ChevronLeft size={16} color="#0f172a" />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.monthLabel}>{monthLabel}</Text>
            <Text style={styles.monthSub}>
              {activeDaysCount > 0 ? `${activeDaysCount} active day${activeDaysCount !== 1 ? 's' : ''}` : 'No active days'}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.navBtn, isCurrentMonth && { opacity: 0.25 }]}
            onPress={goToNext}
            disabled={isCurrentMonth}
            activeOpacity={0.6}
          >
            <ChevronRight size={16} color="#0f172a" />
          </TouchableOpacity>
        </View>

        {/* Day-of-week header */}
        <View style={styles.dowRow}>
          {DOW.map((d, i) => (
            <Text key={i} style={styles.dowLabel}>{d}</Text>
          ))}
        </View>

        {/* Calendar grid */}
        <View style={styles.grid}>
          {cells.map((cell, idx) => {
            let segments = [[]];
            let hasActivity = false;

            if (cell.dateStr && activities[cell.dateStr]) {
              hasActivity = true;
              let sessions = activities[cell.dateStr];
              if (!Array.isArray(sessions)) sessions = [sessions];
              const biggest = sessions.reduce((best, s) =>
                calcSessionDistance(s) > calcSessionDistance(best) ? s : best
              , sessions[0]);
              segments = getSessionSegmentsXY(biggest);
            }

            return (
              <DayCell
                key={idx}
                day={cell.day}
                active={hasActivity}
                faded={cell.overflow}
                segments={segments}
                traceColor={petColor}
                onPress={() => setSelectedDate(cell.dateStr)}
              />
            );
          })}
        </View>
      </ScrollView>

      {/* Day detail sheet */}
      <Modal
        visible={!!selectedDate}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setSelectedDate(null)}
      >
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <View style={styles.sheetHeader}>
              <View>
                <Text style={styles.sheetTitle}>{selectedDate ? formatDate(selectedDate) : ''}</Text>
                {totalSteps > 0 && (
                  <Text style={styles.sheetSub}>
                    {totalSteps.toLocaleString()} steps
                    {totalDistance > 0 ? ` · ${formatDistance(totalDistance)}` : ''}
                    {` · ${selectedSessions.length} session${selectedSessions.length !== 1 ? 's' : ''}`}
                  </Text>
                )}
              </View>
              <TouchableOpacity style={styles.closeBtn} onPress={() => setSelectedDate(null)}>
                <Text style={styles.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }} showsVerticalScrollIndicator={false}>
              {selectedSessions.length === 0 ? (
                <View style={{ alignItems: 'center', paddingVertical: 48, gap: 12 }}>
                  <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: C.border }} />
                  <Text style={{ fontSize: 14, color: C.text3, fontWeight: '500' }}>No sessions recorded</Text>
                </View>
              ) : (
                selectedSessions.map((session, i) => (
                  <SessionCard key={i} session={session} index={i} />
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

/* ---------------- STYLES ---------------- */

const cs = StyleSheet.create({
  cell: {
    width: CELL_W,
    height: CELL_H,
    borderRadius: 50,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: '#000000',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellActive: {
    backgroundColor: '#000000',
    borderColor: '#000000',
  },
  cellFaded: {
    borderColor: '#DBDBDB',
    opacity: 0.45,
  },
  dayNum: {
    fontSize: 24,
    fontWeight: '400',
    lineHeight: 20,
  },
  dayNumActive: {
    color: '#4D4D4D',
  },
  dayNumInactive: {
    color: '#000000',
  },
  dayNumFaded: {
    color: '#DBDBDB',
  },
});

const ss = StyleSheet.create({
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: C.border,
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.card,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  left:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { width: 22, height: 22, borderRadius: 11, backgroundColor: '#2563eb', alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 11, fontWeight: '800', color: '#fff' },
  steps: { fontSize: 15, fontWeight: '700', color: C.text },
  dist:  { fontSize: 12, fontWeight: '500', color: C.text3, marginLeft: 4 },
  time:  { fontSize: 12, color: C.text3, fontWeight: '500' },
});

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 20,
    paddingBottom: 16,
  },
  headerCenter: { alignItems: 'center', flex: 1 },
  monthLabel: { fontSize: 16, fontWeight: '800', color: C.text},
  monthSub:   { fontSize: 11, fontWeight: '600', color: C.text3, marginTop: 2 },
  navBtn: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: C.card, borderWidth: 1, borderColor: '#000000',
    alignItems: 'center', justifyContent: 'center',
  },
  navText: { fontSize: 16, color: C.text, fontWeight: '500', includeFontPadding: false, lineHeight: 16 },

  dowRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 18,
    marginTop: 30,
    paddingHorizontal: 1,
  },
  dowLabel: {
    width: CELL_W,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '500',
    color: '#757575',
    textTransform: 'uppercase',
  },

  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: COL_GAP,
    rowGap: ROW_GAP,
  },

  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '88%',
    paddingBottom: 36,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: 'center',
    marginTop: 12, marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800', color: C.text },
  sheetSub:   { fontSize: 12, color: C.text3, fontWeight: '500', marginTop: 3 },
  closeBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: C.bg, borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center', marginTop: 2,
  },
  closeBtnText: { fontSize: 12, color: C.text2, fontWeight: '700' },
});
