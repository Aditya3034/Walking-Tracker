import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  ScrollView,
  Modal,
  TouchableOpacity,
} from 'react-native';
import Svg, { Polyline, Rect, Circle } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { width } = Dimensions.get('window');

const COLS = 4;
const GRID_PAD = 12;
const GAP = 8;
const BOX_WIDTH = (width - GRID_PAD * 2 - GAP * (COLS - 1)) / COLS;
const BOX_HEIGHT = BOX_WIDTH + 18;
const SESSION_W = width - 80;
const SESSION_H = 160;

const C = {
  bg:       '#f8fafc',
  card:     '#ffffff',
  primary:  '#2563eb',
  success:  '#16a34a',
  text:     '#0f172a',
  text2:    '#475569',
  text3:    '#94a3b8',
  border:   '#e2e8f0',
  green:    '#f0fdf4',
  greenBorder: '#bbf7d0',
  activeBg: '#f0fdf4',
};

/* ---------------- SEGMENT HELPERS ---------------- */

function getSessionSegmentsXY(session) {
  if (session.segments && session.segments.length > 0) {
    return session.segments.map(seg =>
      (seg || []).map(p => ({ x: p.longitude, y: -p.latitude }))
    );
  }
  return [(session.route || []).map(p => ({ x: p.longitude, y: -p.latitude }))];
}

function normalizeSegmentsSquare(segments, size, padding = 6) {
  const allXY = segments.flat();
  if (allXY.length < 2) return segments.map(() => []);

  const xs = allXY.map(p => p.x);
  const ys = allXY.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const scale = Math.min(
    (size - padding * 2) / (maxX - minX || 1),
    (size - padding * 2) / (maxY - minY || 1)
  );

  return segments.map(seg =>
    seg.map(p => ({
      x: padding + (p.x - minX) * scale,
      y: padding + 14 + (p.y - minY) * scale,
    }))
  );
}

function normalizeSegmentsRect(segments, w, h, padding = 16) {
  const allXY = segments.flat();
  if (allXY.length < 2) return segments.map(() => []);

  const xs = allXY.map(p => p.x);
  const ys = allXY.map(p => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const routeW = maxX - minX || 1;
  const routeH = maxY - minY || 1;
  const scale = Math.min((w - padding * 2) / routeW, (h - padding * 2) / routeH);
  const offsetX = (w - routeW * scale) / 2;
  const offsetY = (h - routeH * scale) / 2;

  return segments.map(seg =>
    seg.map(p => ({
      x: offsetX + (p.x - minX) * scale,
      y: offsetY + (p.y - minY) * scale,
    }))
  );
}

function haversineDistance(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const R = 6371000;
    const φ1 = points[i - 1].latitude * Math.PI / 180;
    const φ2 = points[i].latitude * Math.PI / 180;
    const Δφ = (points[i].latitude - points[i - 1].latitude) * Math.PI / 180;
    const Δλ = (points[i].longitude - points[i - 1].longitude) * Math.PI / 180;
    const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

function calcSessionDistance(session) {
  const segs = (session.segments && session.segments.length > 0)
    ? session.segments
    : [session.route || []];
  return segs.reduce((sum, seg) => sum + haversineDistance(seg), 0);
}

function formatDistance(metres) {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('default', { month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/* ---------------- DAY BOX ---------------- */
function DayBox({ day, segments, steps, faded, onPress }) {
  const normalizedSegs = normalizeSegmentsSquare(segments, BOX_WIDTH);
  const allPoints = normalizedSegs.flat();

  const stepLabel = steps >= 1000
    ? `${(steps / 1000).toFixed(1)}k`
    : steps > 0 ? String(steps) : null;

  const hasData = steps > 0 || allPoints.length > 0;

  return (
    <TouchableOpacity
      style={[styles.box, faded && styles.boxFaded, hasData && styles.boxActive]}
      onPress={hasData ? onPress : undefined}
      activeOpacity={hasData ? 0.7 : 1}
    >
      <Svg width={BOX_WIDTH} height={BOX_HEIGHT} style={StyleSheet.absoluteFill}>
        <Rect
          x="0" y="0"
          width={BOX_WIDTH} height={BOX_HEIGHT}
          rx="12"
          fill={hasData ? C.activeBg : C.card}
        />
        {normalizedSegs.map((seg, i) => {
          if (seg.length < 2) return null;
          return (
            <Polyline
              key={i}
              points={seg.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none"
              stroke={C.success}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </Svg>

      {/* Day number top-left */}
      <Text style={[styles.dayNum, hasData && styles.dayNumActive]}>{day}</Text>

      {/* Step count bottom */}
      {stepLabel && (
        <View style={styles.stepBadge}>
          <Text style={styles.stepBadgeText}>{stepLabel}</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

/* ---------------- SESSION CARD (inside modal) ---------------- */
function SessionCard({ session, index }) {
  const segsXY = getSessionSegmentsXY(session);
  const normalizedSegs = normalizeSegmentsRect(segsXY, SESSION_W, SESSION_H);
  const distance = calcSessionDistance(session);

  return (
    <View style={styles.sessionCard}>
      <Svg width={SESSION_W} height={SESSION_H}>
        <Rect x="0" y="0" width={SESSION_W} height={SESSION_H} rx="14" fill="#f8fafc" />
        {normalizedSegs.map((seg, i) => {
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

      <View style={styles.sessionMeta}>
        <View style={styles.sessionLeft}>
          <View style={styles.sessionIndexBadge}>
            <Text style={styles.sessionIndexText}>{index + 1}</Text>
          </View>
          <Text style={styles.sessionSteps}>{session.steps.toLocaleString()} steps</Text>
          {distance > 0 && (
            <Text style={styles.sessionDistance}>{formatDistance(distance)}</Text>
          )}
        </View>
        {session.timestamp ? (
          <Text style={styles.sessionTime}>{formatTime(session.timestamp)}</Text>
        ) : null}
      </View>
    </View>
  );
}


/* ---------------- MAIN ---------------- */
export default function ActivitiesScreen({ isActive = false }) {
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth()); // 0-indexed
  const [activities, setActivities] = useState({});
  const [days, setDays] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);

  const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();

  const monthLabel = new Date(viewYear, viewMonth, 1)
    .toLocaleString('default', { month: 'long', year: 'numeric' });

  const goToPrevMonth = () => {
    if (viewMonth === 0) {
      setViewYear(y => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth(m => m - 1);
    }
  };

  const goToNextMonth = () => {
    if (viewMonth === 11) {
      setViewYear(y => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth(m => m + 1);
    }
  };

  const loadData = async () => {
    try {
      const stored = await AsyncStorage.getItem('activities');
      if (stored) setActivities(JSON.parse(stored));
    } catch (e) {
      console.log('Load failed', e);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!isActive) return;
    loadData();
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, [isActive]);

  useEffect(() => {
    const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
    let arr = [];

    for (let i = 1; i <= totalDays; i++) {
      const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      arr.push({ day: i, dateStr, faded: false });
    }

    const remainder = arr.length % 4;
    if (remainder !== 0) {
      for (let i = 1; i <= 4 - remainder; i++) {
        arr.push({ day: i, dateStr: null, faded: true });
      }
    }

    setDays(arr);
  }, [viewYear, viewMonth]);

  const selectedSessions = selectedDate && activities[selectedDate]
    ? (Array.isArray(activities[selectedDate])
        ? activities[selectedDate]
        : [activities[selectedDate]])
    : [];

  const totalStepsForDay = selectedSessions.reduce((sum, s) => sum + (s.steps || 0), 0);
  const totalDistanceForDay = selectedSessions.reduce((sum, s) => sum + calcSessionDistance(s), 0);

  return (
    <>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        {/* Month header */}
        <View style={styles.headerRow}>
          <TouchableOpacity onPress={goToPrevMonth} style={styles.navBtn} activeOpacity={0.6}>
            <Text style={styles.navBtnText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.monthHeader}>{monthLabel}</Text>
            <Text style={styles.monthSub}>
              {days.filter(d => d.dateStr && activities[d.dateStr]).length} active days
            </Text>
          </View>
          <TouchableOpacity
            onPress={goToNextMonth}
            style={[styles.navBtn, isCurrentMonth && styles.navBtnDisabled]}
            disabled={isCurrentMonth}
            activeOpacity={0.6}
          >
            <Text style={[styles.navBtnText, isCurrentMonth && styles.navBtnTextDisabled]}>›</Text>
          </TouchableOpacity>
        </View>

        {/* Grid */}
        <View style={styles.grid}>
          {days.map((item, index) => {
            let thumbnailSegments = [[]];
            let totalSteps = 0;

            if (item.dateStr && activities[item.dateStr]) {
              let sessions = activities[item.dateStr];
              if (!Array.isArray(sessions)) sessions = [sessions];

              totalSteps = sessions.reduce((sum, s) => sum + (s.steps || 0), 0);

              const biggest = sessions.reduce((best, s) =>
                (s.route || []).length > (best.route || []).length ? s : best
              , sessions[0]);

              thumbnailSegments = getSessionSegmentsXY(biggest);
            }

            return (
              <DayBox
                key={index}
                day={item.day}
                segments={thumbnailSegments}
                steps={totalSteps}
                faded={item.faded}
                onPress={() => setSelectedDate(item.dateStr)}
              />
            );
          })}
        </View>
      </ScrollView>

      {/* Day detail modal */}
      <Modal
        visible={!!selectedDate}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedDate(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            {/* Handle bar */}
            <View style={styles.modalHandle} />

            {/* Header */}
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>
                  {selectedDate ? formatDate(selectedDate) : ''}
                </Text>
                {totalStepsForDay > 0 && (
                  <Text style={styles.modalSubtitle}>
                    {totalStepsForDay.toLocaleString()} steps
                    {totalDistanceForDay > 0 ? ` · ${formatDistance(totalDistanceForDay)}` : ''}
                    {` · ${selectedSessions.length} session${selectedSessions.length !== 1 ? 's' : ''}`}
                  </Text>
                )}
              </View>
              <TouchableOpacity onPress={() => setSelectedDate(null)} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView
              contentContainerStyle={styles.modalScroll}
              showsVerticalScrollIndicator={false}
            >
              {selectedSessions.length === 0 ? (
                <View style={styles.emptyModal}>
                  <View style={styles.emptyDot} />
                  <Text style={styles.noSessions}>No sessions recorded</Text>
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
const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
    backgroundColor: C.bg,
  },
  container: {
    paddingHorizontal: GRID_PAD,
    paddingBottom: 32,
  },

  /* ---- Header ---- */
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 20,
    paddingBottom: 4,
    paddingHorizontal: 2,
  },
  headerCenter: {
    alignItems: 'center',
    flex: 1,
  },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navBtnDisabled: {
    opacity: 0.3,
  },
  navBtnText: {
    fontSize: 22,
    color: C.text,
    lineHeight: 26,
    fontWeight: '300',
  },
  navBtnTextDisabled: {
    color: C.text3,
  },
  monthHeader: {
    fontSize: 20,
    fontWeight: '800',
    color: C.text,
    letterSpacing: -0.5,
  },
  monthSub: {
    fontSize: 12,
    fontWeight: '600',
    color: C.text3,
    letterSpacing: 0.5,
    paddingBottom: 3,
  },

  /* ---- Grid ---- */
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GAP,
  },

  /* ---- Day Box ---- */
  box: {
    width: BOX_WIDTH,
    height: BOX_HEIGHT,
    borderRadius: 12,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    overflow: 'hidden',
    justifyContent: 'space-between',
  },
  boxActive: {
    borderColor: C.greenBorder,
    backgroundColor: C.activeBg,
  },
  boxFaded: {
    opacity: 0.25,
  },
  dayNum: {
    position: 'absolute',
    top: 6,
    left: 7,
    fontSize: 10,
    fontWeight: '700',
    color: C.text3,
  },
  dayNumActive: {
    color: C.success,
  },
  stepBadge: {
    position: 'absolute',
    bottom: 5,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  stepBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: C.success,
    letterSpacing: 0.3,
  },

  /* ---- Modal ---- */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.5)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: C.card,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '88%',
    paddingBottom: 36,
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 4,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: C.text,
    letterSpacing: -0.3,
  },
  modalSubtitle: {
    fontSize: 12,
    color: C.text3,
    fontWeight: '500',
    marginTop: 3,
    letterSpacing: 0.3,
  },
  closeBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  closeBtnText: {
    fontSize: 12,
    color: C.text2,
    fontWeight: '700',
  },
  modalScroll: {
    padding: 20,
    gap: 14,
  },

  /* ---- Empty modal ---- */
  emptyModal: {
    alignItems: 'center',
    paddingVertical: 48,
    gap: 12,
  },
  emptyDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.border,
  },
  noSessions: {
    fontSize: 14,
    color: C.text3,
    fontWeight: '500',
  },

  /* ---- Session card ---- */
  sessionCard: {
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.border,
  },
  sessionMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: C.card,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  sessionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sessionIndexBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: C.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionIndexText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#fff',
  },
  sessionSteps: {
    fontSize: 15,
    fontWeight: '700',
    color: C.text,
  },
  sessionDistance: {
    fontSize: 12,
    fontWeight: '500',
    color: C.text3,
    marginLeft: 4,
  },
  sessionTime: {
    fontSize: 12,
    color: C.text3,
    fontWeight: '500',
  },
});
