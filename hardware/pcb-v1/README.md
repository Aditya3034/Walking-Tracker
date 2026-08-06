# softwear.pet — PCB v1 design

First custom PCB for the pet badge prototype. **Modular design** — XIAO + TP4056 + OLED plug into pin sockets on a custom carrier board. Lets you swap modules and reduces design risk.

This is the **carrier board** between you and a wearable form factor. Production-grade integrated PCB is v2.

---

## Board specification

| | |
|---|---|
| **Dimensions** | 40 mm × 30 mm (rectangular) |
| **Layers** | 2-layer FR-4, 1.6 mm thick |
| **Color** | Black solder mask (looks better on a wearable) |
| **Finish** | HASL (cheap) or ENIG (gold pads — premium feel, +₹200) |
| **Min trace width** | 0.2 mm (well within JLCPCB's free tier capability) |
| **Min via diameter** | 0.4 mm |
| **Mounting holes** | 4× M2 (2 mm) at corners, 3 mm from edges |
| **Estimated cost** | ~₹400 for 5 boards + ₹500-700 shipping from JLCPCB |

---

## Components on the PCB

| Ref | Component | Footprint | JLCPCB part / equivalent |
|---|---|---|---|
| **U1** | XIAO ESP32-C3 module | 2× 1×7 pin socket headers, 2.54 mm pitch, 11 mm apart | C2685001 (female header) |
| **U2** | TP4056 USB-C module with protection | 1× 1×4 pin socket header + 1× 1×2 pin socket header | Manual headers |
| **U3** | SSD1306 OLED 128×64 module | 1× 1×4 pin socket header, 2.54 mm pitch | C5180953 (female header) |
| **J1** | Battery JST connector | JST-PH 2-pin, 2.0 mm pitch, through-hole | C158012 |
| **SW1** | Reset button | Tactile switch 6×6 mm through-hole (optional) | C318884 |
| **D1** | Power LED (optional) | 0805 SMD red LED + 1 kΩ 0805 SMD resistor | C84256 (LED) + C17513 (1kΩ) |

**Total parts to solder:** 5 (pin sockets + JST + button + LED). All through-hole except the optional LED.

---

## Schematic (text form)

```
USB-C charger
    │
    ▼
┌─────────────────────┐
│  TP4056 module      │
│  USB-C input        │
│                     │
│  ┌──┐               │
│  │B+├──────────────┐│
│  └──┘              ││
│  ┌──┐              ││
│  │B-├─────────────┐││
│  └──┘             │││
│                   │││
│  ┌────┐           │││
│  │OUT+├──────┐    │││
│  └────┘      │    │││
│  ┌────┐      │    │││
│  │OUT-├─────┐│    │││
│  └────┘     ││    │││
└─────────────││────│││
              ││    │││ JST battery connector (J1)
              ││    │└┴──► LiPo + (red)
              ││    └───► LiPo - (black)
              ││
              ▼▼
        ┌───────────────────────┐
        │  XIAO ESP32-C3 (U1)   │
        │                       │
        │  VUSB ← OUT+          │
        │  GND  ← OUT-          │
        │  3V3 ─┐               │
        │  D4   │               │
        │  D5   │               │
        │  RST ──┐              │
        │       ││              │
        └───────│┼──────────────┘
                ││
                │└── SW1 (other side to GND) — reset button
                │
                ▼
        ┌──────────────────────┐
        │  SSD1306 OLED (U3)   │
        │                      │
        │  VCC ← XIAO 3V3      │
        │  GND ← XIAO GND      │
        │  SDA ← XIAO D4       │
        │  SCL ← XIAO D5       │
        └──────────────────────┘

Power LED (optional):
  XIAO 3V3 ─► 1 kΩ resistor ─► LED anode
  LED cathode ─► XIAO GND
```

---

## Nets (every connection enumerated)

When you draw the schematic in EasyEDA, these are the exact connections to make:

| Net name | Connects to | Purpose |
|---|---|---|
| **GND** | XIAO GND + TP4056 OUT- + TP4056 B- + JST pin 2 + OLED GND + SW1 pin 2 + LED cathode | Ground rail |
| **VBAT** | TP4056 B+ + JST pin 1 | Battery + (LiPo) |
| **VBUS** | TP4056 OUT+ + XIAO VUSB | 3.5-4.2V power to XIAO from battery (or 5V from USB charging) |
| **+3V3** | XIAO 3V3 + OLED VCC + LED + resistor | Clean 3.3V supplied by XIAO's onboard LDO |
| **SDA** | XIAO D4 (GPIO 6) + OLED SDA | I²C data |
| **SCL** | XIAO D5 (GPIO 7) + OLED SCL | I²C clock |
| **RST** | XIAO RST pad + SW1 pin 1 | Reset button (push to ground = reset) |

All other XIAO pins (D0, D1, D2, D3, D6-D10) → leave as test points / unconnected on this v1. Future v2 adds BMA400, TTP223, etc. via these.

---

## Recommended PCB layout (40 × 30 mm)

```
            ╔══════════════════════════════════════╗
            ║  ○ (M2 mount hole)    (M2)○         ║ ← 30 mm tall
            ║                                      ║
            ║   ┌─────────────────────────────┐    ║
            ║   │  XIAO ESP32-C3 (U1)         │    ║
            ║   │  USB-C facing right edge ───┼─►  ║
            ║   │  (so user can charge XIAO    │    ║
            ║   │   directly if needed)        │    ║
            ║   └─────────────────────────────┘    ║
            ║                                      ║
            ║   ┌──────────────┐  ┌─────────────┐  ║
            ║   │  TP4056 (U2) │  │ OLED (U3)   │  ║
            ║   │  USB-C ───►  │  │             │  ║
            ║   │              │  │             │  ║
            ║   └──────────────┘  └─────────────┘  ║
            ║                                      ║
            ║      [J1: JST]    [SW1: RST]         ║
            ║                                      ║
            ║  ○ (M2)              (M2)○          ║
            ╚══════════════════════════════════════╝
                          ↑
                         40 mm wide
```

**Layout notes:**

1. **OLED on the front (visible side)** — when soldered the OLED display faces up
2. **TP4056 USB-C port faces the side** of the board so you can plug the charger in from the edge
3. **JST connector + reset button on the bottom edge** — accessible but out of the way
4. **Mounting holes at corners** — for screwing into a 3D-printed case
5. **Keep XIAO antenna corner free of copper/components** — the BLE antenna is on one side; copper near it kills range

---

## EasyEDA + JLCPCB workflow (step by step)

You'll need to do these in EasyEDA's GUI (I can't click for you, but I'll narrate every step):

### 1. Account + project setup (15 min)

1. Go to **easyeda.com** → sign up (free)
2. Use the **STD edition** (not Pro) — it's the simpler one and integrates with JLCPCB
3. Create new project: "softwear-pet-v1"
4. Click "Create New Schematic"

### 2. Schematic — draw the circuit (1-2 hours)

In EasyEDA's schematic editor:

1. Search the Library panel (left side) for these symbols + place them:
   - "Header-Female 1x7 2.54mm" → place 2 (for XIAO)
   - "Header-Female 1x4 2.54mm" → place 1 (for OLED)
   - "Header-Female 1x4 2.54mm" → place 1 (for TP4056 power side)
   - "Header-Female 1x2 2.54mm" → place 1 (for TP4056 battery side, if your module has separate B+/B- pins)
   - "JST PH 2-Pin" → place 1 (J1)
   - "Switch Tactile" → place 1 (SW1)
   - (Optional) LED + 1k resistor + 0805 footprint pair

2. **Wire them up** following the Nets table above. Each net = a green line in the schematic.

3. **Add a Net Label to each named net** (GND, VBAT, VBUS, +3V3, SDA, SCL, RST) — makes the schematic readable.

4. **Run Design Rule Check** (DRC) — fix any errors before moving on.

### 3. Convert schematic to PCB (5 min)

Click **Design → Convert to PCB**. EasyEDA generates a blank board with all footprints scattered. Now you arrange them.

### 4. PCB layout (2-4 hours)

1. **Set board outline** — draw a 40 × 30 mm rectangle in the Board Outline layer
2. **Place mounting holes** — 4× M2 holes at corners, 3 mm from edge
3. **Arrange components** following the layout sketch above:
   - XIAO at top, USB facing right
   - TP4056 bottom-left, USB facing left
   - OLED bottom-right
   - JST + button at bottom edge
4. **Auto-route** (Route → Auto Router) — accept the default settings. EasyEDA's auto-router handles this simple board fine
5. **Inspect the result** — look for any unrouted nets (red lines) → manually route them
6. **Run DRC again** — fix any spacing / clearance errors

### 5. Export Gerber files (5 min)

Click **Fabrication → Generate Fabrication Files (Gerber)** → download the ZIP. This is what JLCPCB needs.

### 6. Order from JLCPCB (15 min)

1. Go to **jlcpcb.com** → drag-drop the Gerber ZIP
2. JLCPCB auto-detects dimensions, layers, finish
3. **Settings:**
   - PCB Quantity: 5 (minimum)
   - PCB Color: Black
   - Surface Finish: HASL (free) or ENIG (+₹200)
   - All other defaults
4. **Total cost preview:** ~₹400 PCB + ₹500-700 shipping (DHL Express to India is ~3 days; cheaper post is 2-3 weeks)
5. Pay → wait → receive boards

### 7. Solder + test

When boards arrive:
- Solder pin sockets first (XIAO holders, OLED holder, TP4056 holders)
- Solder JST connector
- Solder reset button
- (Optional) Solder LED + resistor
- Plug in XIAO, OLED, TP4056 modules
- Plug battery into JST
- Power on — pet eyes should appear on OLED

---

## Parts shopping list (separately from PCB)

What to order from Robocraze / Robu.in alongside the JLCPCB order:

| Part | Quantity per board | Total cost (5 boards) |
|---|---|---|
| Female pin headers, 1×7 2.54 mm | 2 | ₹100 (pack of 20) |
| Female pin headers, 1×4 2.54 mm | 2 | ₹50 (pack of 20) |
| Female pin headers, 1×2 2.54 mm | 1 | ₹30 (pack of 20) |
| JST PH 2.0 connector (2-pin, board) | 1 | ₹50 (pack of 10) |
| JST PH 2.0 cable with battery wires | 1 | already with battery |
| Tactile switch 6×6mm | 1 | ₹40 (pack of 10) |
| 1 kΩ 0805 SMD resistor (optional) | 1 | ₹30 (pack of 100) |
| 0805 SMD red LED (optional) | 1 | ₹50 (pack of 10) |

**Subtotal for parts:** ~₹350 for 5 boards' worth.

---

## Timeline

| Step | Time |
|---|---|
| EasyEDA learning + setup | 1-2 hours |
| Schematic | 1-2 hours |
| PCB layout | 2-4 hours |
| Order at JLCPCB | 15 min |
| Wait for shipping | 7-14 days (DHL Express) or 14-21 days (regular post) |
| Solder + test | 1-2 hours per board |

**Realistic timeline: 2-3 weeks from "start designing" to "wearable in hand."**

---

## What I'll help you with

Once you start in EasyEDA:

- I can review your schematic before you move to PCB layout — paste a screenshot, I'll spot issues
- I can review the PCB layout before you order — same workflow
- I can help debug any DRC errors
- I can guide through JLCPCB ordering options

What I can't do directly:
- Click the EasyEDA buttons for you
- Generate Gerber files from text
- Order from JLCPCB on your behalf

But this design doc is enough that **you have every connection specified, every part number listed, and every dimension fixed.** Translating it into EasyEDA is mechanical work that I can guide step-by-step.

---

## After v1 works — what v2 changes

When you're ready for the second board:

- Add footprints for BMA400 (bare chip, LGA-12)
- Add MAX30102 (bare chip, OLPN-14)
- Add TTP223 (bare chip, SOT-23-6)
- Add boost converter (MT3608) for clean power
- Drop to a smaller, more wearable shape (~35 × 25 mm)
- Optional: replace XIAO module with bare ESP32-C3 chip (smaller still, requires SMT)
- Magnetic pogo connector footprint (for back plate, if pursuing HR)

That's the production-grade version. v1 here gets you a working prototype to validate the assembly + firmware integration first.
