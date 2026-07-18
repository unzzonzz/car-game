"use strict";

/* =============================================================================
 *  shared.js — 결정론 고정틱 시뮬레이션 코어 (넷코드 v4)
 * -----------------------------------------------------------------------------
 *  클라이언트(game.js 앞에 번들)와 서버(require) 가 "완전히 같은 코드"로
 *  차 물리를 적분한다. 규칙(NETCODE.md §5):
 *   - 순수 함수만 : Date/performance/Math.random/전역 게임상태 접근 금지.
 *   - 부작용 금지 : SFX/셰이크 등은 이벤트 목록으로 반환(호출자가 소비).
 *   - 시간은 전부 "틱"(60Hz). 만료류(무적/입력락/스턴)는 만료 틱 필드.
 *   - 틱 종료 시 상태를 스냅샷 격자로 양자화 → 클라/서버가 같은 격자 위에서
 *     비교되고, 엔진별 초월함수 ulp 차이가 반올림에 흡수돼 사실상 비트 동일.
 *
 *  서빙 : 서버가 shared.js + game.js 를 한 IIFE 로 묶어 /game.js 로 내려준다.
 *  (const SIM 이 IIFE 스코프에 갇혀 콘솔에 노출되지 않음. --dev-raw 도 이어붙임)
 * ========================================================================== */

const SIM = (() => {

/* =============================================================================
 *  단위 / 틱
 * ========================================================================== */
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const DT = 1 / TICK_RATE;               // 1틱 적분 시간(s)
const PIXELS_PER_METER = 8;
const KMH_TO_PXS = (1 / 3.6) * PIXELS_PER_METER;
const A2I = 32767 / Math.PI;            // 각도 <-> int16 격자

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/* =============================================================================
 *  입력 비트 (MSG_INPUT.buttons / 스냅샷 buttons 공용)
 * ========================================================================== */
const BTN = { W: 1, SPACE: 2, A: 4, D: 8, S: 16, PUNCH: 32, RESTART: 64 };

/* =============================================================================
 *  차 스펙 — 유일한 차종. 기존 game.js CAR 스펙과 동일 수치.
 * ========================================================================== */
const CAR_SPEC = {
  maxSpeed: 1200,          // km/h
  acceleration: 165,       // px/s^2 (트랙션 한계)
  brakePower: 230,
  reverseSpeed: 50,        // km/h
  reverseAccel: 90,
  grip: 13.0,              // 1/s
  driftGrip: 1.2,
  brakeDriftSpeed: 110,    // km/h
  steering: 3.0,           // rad/s
  highSpeedSteer: 0.40,
  driftSteerBoost: 1.7,
  weight: 1500,
  airResistance: 7.0e-5,
  rollingResistance: 0.012,
  length: 38,
  width: 18,
};
// 엔진 출력 역산 : power/vmax = air*vmax^2 + roll*vmax
const VMAX = CAR_SPEC.maxSpeed * KMH_TO_PXS;
CAR_SPEC.enginePower =
  CAR_SPEC.airResistance * VMAX * VMAX * VMAX +
  CAR_SPEC.rollingResistance * VMAX * VMAX;

// 히트박스 = 시각 차체 (game.js drawCar 1.15배 반영)
const CAR_HL = (CAR_SPEC.length + 10) * 0.575;   // 27.6
const CAR_HW = (CAR_SPEC.length + 10) * 0.2751;  // 13.2

const OFFTRACK_DRAG = 2.4;      // 트랙 이탈 지수 감쇠(1/s)
const OFFTRACK_RAMP = 12;       // 경계 램프 폭(px) — 이진 분기 연속화(보정 플래핑 방지)

/* ---- 이진 분기 연속화 상수 (NETCODE.md §5) ---- */
const DRIFT_ENTER_LL = 34;      // 드리프트 진입 |ll| (기존 단일 30 → 히스테리시스)
const DRIFT_EXIT_LL = 26;       // 드리프트 해제 |ll|
const DRIFT_BOOST_RAMP = 1 / 3; // driftSteerBoost 램프(틱당) — 약 3틱에 완충

/* ---- 외부 속도 채널(ev) : 충돌/넉백 전용, lf 캡 면제 ---- */
const EV_TAU = 0.6;             // 지수 감쇠 시정수(s)
const EV_STOP = 24;             // 이하 속력이면 0 으로 (기존 스모 kv 와 동일)
const SPIN_TAU = 0.5;           // 임팩트 스핀 감쇠(s) — 기존 스모 spinV 와 동일

/* ---- 충돌 응답 (NETCODE.md §5) ---- */
const COL_E_LOW = 0.25;         // 반발계수(저속)
const COL_E_HIGH = 0.05;        // 반발계수(고속)
const COL_E_V0 = 150;           // 이하 접근속도 반발 0 (슬롭)
const COL_E_V1 = 600;           // 저속 반발 구간 끝
const COL_E_V2 = 2000;          // 고속 반발 구간 시작
const COL_DV_CAP = 800;         // 충돌당 delta-v 상한(px/s)
const COL_MU = 0.15;            // 접선 마찰
const COL_YAW_MAX = 2.5;        // 요 토크 상한(rad/s) @ vrel 2000
const COL_YAW_V0 = 300;         // 이하 vrel 요 토크 0
const IMPACT_SLIDE_DV = 120;    // 이 이상 피격 시 임팩트 슬라이드 발동
const IMPACT_SLIDE_TICKS = 12;  // 저그립 창(틱) — 약 200ms
const IMPACT_SLIDE_GRIP = 3.0;  // 창 동안 그립 상한(1/s)
const SUBSTEP_LEN = 13;         // CCD 서브스텝 길이(px) ~= 반폭
const SUBSTEP_MAX = 6;          // 서브스텝 상한

/* =============================================================================
 *  월드 치수 (렌더 무관 데이터만 — 클라 WORLD 는 여기에 렌더 정보를 더한다)
 * ========================================================================== */
const WORLD_DIMS = {
  a1: { w: 10000, h: 6000 }, a2: { w: 10000, h: 6000 }, a3: { w: 10000, h: 6000 },
  racing: { w: 10000, h: 6000 }, hard: { w: 10000, h: 6000 }, serp: { w: 10000, h: 6000 },
  c1: { w: 10000, h: 6000 }, c2: { w: 10000, h: 6000 }, c3: { w: 10000, h: 6000 },
  d1: { w: 10000, h: 6000 },
  retro1: { w: 10000, h: 6000 }, retro2: { w: 18000, h: 11500 },
  pro: { w: 10000, h: 6000 },
  lobby: { w: 3600, h: 3600 },
  test: { w: 6000, h: 3400 },
  soccer: { w: 1800, h: 3000 },
  boss: { w: 3400, h: 2600 },
  plaza: { w: 2800, h: 2000 },
  sumo: { w: 5000, h: 5000 },
};

/* ---- 스모 ---- */
const SUMO = {
  cx: 2500, cy: 2500, ringR: 1050,
  speedScale: 2 / 3,
  punchCdTicks: 180,             // 3s
  reach: 130, front: 30,
  extendTicks: 7, holdTicks: 6, retractTicks: 12, // 120/90/200ms 상당
  outTicks: 60,                  // 링 밖 1s 후 사망
  knock: 2300,                   // 넉백 발사 속도(px/s)
  hitR: 46,                      // 글러브 히트 반경(+차 반길이)
  lockTicks: 39,                 // 넉백 입력락 650ms 상당
};

/* ---- 광장 장애물 (원형 충돌체) ---- */
const PLAZA_FOUNTAINS = [[460, 460], [2340, 460], [460, 1540], [2340, 1540]];
const PLAZA_STALLS = [[800, 240], [2000, 240], [800, 1760], [2000, 1760]];
const PLAZA_TREES = [[320, 700], [320, 1000], [320, 1300], [2480, 700], [2480, 1000], [2480, 1300], [960, 200], [1840, 200], [960, 1800], [1840, 1800]];
const PLAZA_BENCHES = [[480, 820], [480, 1180], [2320, 820], [2320, 1180]];
const PLAZA_LAMPS = [[230, 460], [230, 1000], [230, 1540], [2570, 460], [2570, 1000], [2570, 1540]];
const PLAZA_OBSTACLES = [
  { x: 1400, y: 1000, r: 486 },
  ...PLAZA_FOUNTAINS.map(([x, y]) => ({ x, y, r: 82 })),
  ...PLAZA_STALLS.map(([x, y]) => ({ x, y, r: 56 })),
  ...PLAZA_TREES.map(([x, y]) => ({ x, y, r: 46 })),
  ...PLAZA_BENCHES.map(([x, y]) => ({ x, y, r: 30 })),
  ...PLAZA_LAMPS.map(([x, y]) => ({ x, y, r: 16 })),
];

/* ---- 보스 아레나 기둥 (콜로세움 타원 링 8개) ---- */
const BOSS_PILLARS = [
  { x: 2633, y: 1591, r: 84 }, { x: 2087, y: 2002, r: 84 },
  { x: 1314, y: 2002, r: 84 }, { x: 767, y: 1591, r: 84 },
  { x: 767, y: 1009, r: 84 }, { x: 1314, y: 598, r: 84 },
  { x: 2087, y: 598, r: 84 }, { x: 2633, y: 1009, r: 84 },
];

/* ---- 광장 스폰 ---- */
const PLAZA_SPAWNS = [[1400, 240], [1400, 1760], [640, 1000], [2160, 1000]];

/* =============================================================================
 *  트랙 지오메트리 — 전 코스의 센터라인/폭/시작점 (렌더 Path2D 는 클라가 생성)
 * ========================================================================== */
function makeTrack(opts) {
  const N = 260, raw = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const R = opts.R(a);
    raw.push({ x: Math.cos(a) * R * opts.stretch, y: Math.sin(a) * R });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const inset = opts.halfWidth + opts.kerb + 120;
  const scale = Math.min((opts.w - 2 * inset) / (maxX - minX), (opts.h - 2 * inset) / (maxY - minY));
  const offX = (opts.w - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (opts.h - (maxY - minY) * scale) / 2 - minY * scale;
  const centerline = raw.map(p => ({ x: p.x * scale + offX, y: p.y * scale + offY }));
  const a0 = centerline[0], a1 = centerline[1];
  const start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
  return { halfWidth: opts.halfWidth, kerb: opts.kerb, centerline, start };
}

function catmullRom(p0, p1, p2, p3, t, tension) {
  const t2 = t * t, t3 = t2 * t;
  const m1x = (p2.x - p0.x) * tension, m1y = (p2.y - p0.y) * tension;
  const m2x = (p3.x - p1.x) * tension, m2y = (p3.y - p1.y) * tension;
  return {
    x: (2 * t3 - 3 * t2 + 1) * p1.x + (t3 - 2 * t2 + t) * m1x + (-2 * t3 + 3 * t2) * p2.x + (t3 - t2) * m2x,
    y: (2 * t3 - 3 * t2 + 1) * p1.y + (t3 - 2 * t2 + t) * m1y + (-2 * t3 + 3 * t2) * p2.y + (t3 - t2) * m2y,
  };
}

function makeHardTrack(points, opts) {
  let centerline = [];
  const n = points.length;
  const samplesPerSegment = opts.samplesPerSegment || 24;
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n], p1 = points[i];
    const p2 = points[(i + 1) % n], p3 = points[(i + 2) % n];
    for (let s = 0; s < samplesPerSegment; s++) {
      centerline.push(catmullRom(p0, p1, p2, p3, s / samplesPerSegment, opts.tension));
    }
  }
  const startOffset = ((opts.startPointIndex || 0) * samplesPerSegment) % centerline.length;
  if (startOffset) centerline = centerline.slice(startOffset).concat(centerline.slice(0, startOffset));
  const a0 = centerline[0], a1 = centerline[1];
  const start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
  return { halfWidth: opts.halfWidth, kerb: opts.kerb, centerline, start };
}

function chaikinClosed(pts, iterations) {
  let cur = pts;
  for (let k = 0; k < iterations; k++) {
    const out = [], n = cur.length;
    for (let i = 0; i < n; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    cur = out;
  }
  return cur;
}

function makeStadiumTrack() {
  const cx = 3000, cy = 1700, A = 1500, R = 800, hw = 220, SEG = 44;
  const pts = [];
  for (let i = 0; i < SEG; i++) pts.push({ x: cx - A + (2 * A) * (i / SEG), y: cy + R });
  for (let i = 0; i < SEG; i++) {
    const th = (Math.PI / 2) - Math.PI * (i / SEG);
    pts.push({ x: cx + A + R * Math.cos(th), y: cy + R * Math.sin(th) });
  }
  for (let i = 0; i < SEG; i++) pts.push({ x: cx + A - (2 * A) * (i / SEG), y: cy - R });
  for (let i = 0; i < SEG; i++) {
    const th = (3 * Math.PI / 2) - Math.PI * (i / SEG);
    pts.push({ x: cx - A + R * Math.cos(th), y: cy + R * Math.sin(th) });
  }
  const a0 = pts[0], a1 = pts[1];
  const start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
  return { halfWidth: hw, kerb: 0, centerline: pts, start };
}

/* ---- 코스 레시피 (game.js 원본 그대로) ---- */
const A_BASE = { w: 10000, h: 6000, halfWidth: 230, kerb: 26, stretch: 1.7 };
const B_BASE = { w: 10000, h: 6000, halfWidth: 112, kerb: 16, stretch: 1.6 };
const C_BASE = { w: 10000, h: 6000, halfWidth: 75, kerb: 12, stretch: 1.6 };
const RECIPES = {
  a1: { ...A_BASE, R: a => 1 + 0.16 * Math.sin(2 * a + 0.5) + 0.11 * Math.sin(3 * a + 1.8) },
  a2: { ...A_BASE, R: a => 1 + 0.19 * Math.sin(2 * a + 2.2) + 0.10 * Math.sin(3 * a + 0.4) + 0.08 * Math.sin(4 * a + 1.5) },
  a3: { ...A_BASE, R: a => 1 + 0.13 * Math.sin(2 * a + 1.0) + 0.14 * Math.sin(3 * a + 2.5) + 0.07 * Math.sin(5 * a + 0.8) },
  racing: { ...B_BASE, R: a => 1 + 0.20 * Math.sin(2 * a + 0.4) + 0.16 * Math.sin(3 * a + 1.7) + 0.10 * Math.sin(4 * a + 0.9) },
  hard: { ...B_BASE, R: a => 1 + 0.13 * Math.sin(2 * a + 1.1) + 0.14 * Math.sin(4 * a + 0.3) + 0.10 * Math.sin(5 * a + 2.1) + 0.06 * Math.sin(7 * a + 1.4) },
  serp: { ...B_BASE, R: a => 1 + 0.27 * Math.sin(2 * a + 2.4) + 0.14 * Math.sin(3 * a + 0.6) + 0.10 * Math.sin(5 * a + 1.9) },
  c1: { ...C_BASE, R: a => 1 + 0.15 * Math.sin(2 * a + 0.7) + 0.17 * Math.sin(4 * a + 1.9) + 0.12 * Math.sin(5 * a + 0.5) + 0.07 * Math.sin(8 * a + 2.3) },
  c2: { ...C_BASE, R: a => 1 + 0.14 * Math.sin(2 * a + 1.4) + 0.22 * Math.sin(3 * a + 0.2) + 0.16 * Math.sin(6 * a + 1.7) + 0.10 * Math.sin(9 * a + 0.6) },
  c3: { ...C_BASE, R: a => 1 + 0.17 * Math.sin(3 * a + 2.6) + 0.15 * Math.sin(4 * a + 0.9) + 0.13 * Math.sin(6 * a + 1.3) + 0.08 * Math.sin(7 * a + 2.1) },
  retro1: {
    w: 10000, h: 6000, halfWidth: 230, kerb: 26, stretch: 1.7,
    R: a => 1 + 0.16 * Math.sin(2 * a + 0.6) + 0.30 * Math.sin(3 * a + 0.4) + 0.18 * Math.sin(5 * a + 1.3) + 0.10 * Math.sin(7 * a + 0.2),
  },
};

const HARD_POINTS = [
  { x: 1300, y: 1400 }, { x: 3300, y: 1400 }, { x: 5700, y: 1400 }, { x: 7200, y: 1500 },
  { x: 8350, y: 2050 }, { x: 8900, y: 3150 }, { x: 8200, y: 4300 }, { x: 6450, y: 4450 },
  { x: 5400, y: 4950 }, { x: 6600, y: 5650 }, { x: 8300, y: 5350 }, { x: 9500, y: 5000 },
  { x: 10800, y: 3700 }, { x: 10300, y: 5400 }, { x: 11100, y: 5150 }, { x: 12400, y: 6350 },
  { x: 13800, y: 6200 }, { x: 15050, y: 7400 }, { x: 16200, y: 9000 }, { x: 14500, y: 10350 },
  { x: 12000, y: 10650 }, { x: 9200, y: 10150 }, { x: 6900, y: 9250 }, { x: 5000, y: 9850 },
  { x: 3550, y: 10600 }, { x: 2250, y: 9700 }, { x: 3850, y: 8750 }, { x: 2250, y: 7800 },
  { x: 1150, y: 6650 }, { x: 2400, y: 5350 }, { x: 1400, y: 4050 }, { x: 2450, y: 2750 },
];

const D1_POINTS = [
  { x: 3890, y: 5577 }, { x: 3338, y: 5250 }, { x: 2704, y: 5147 }, { x: 2130, y: 5423 }, { x: 1406, y: 5216 }, { x: 1070, y: 4745 },
  { x: 1434, y: 4231 }, { x: 1961, y: 4347 }, { x: 2397, y: 4181 }, { x: 2513, y: 3751 }, { x: 2130, y: 3403 }, { x: 1559, y: 3146 },
  { x: 1283, y: 2418 }, { x: 1669, y: 1863 }, { x: 1472, y: 1330 }, { x: 941, y: 1151 }, { x: 678, y: 731 }, { x: 797, y: 395 },
  { x: 1158, y: 480 }, { x: 1359, y: 207 }, { x: 2074, y: 207 }, { x: 2444, y: 505 }, { x: 2513, y: 988 }, { x: 2983, y: 1255 },
  { x: 3469, y: 1038 }, { x: 3840, y: 1361 }, { x: 3890, y: 1822 }, { x: 4558, y: 2164 }, { x: 5216, y: 2070 }, { x: 5405, y: 1609 },
  { x: 5216, y: 1022 }, { x: 5539, y: 580 }, { x: 6032, y: 317 }, { x: 6593, y: 242 }, { x: 7214, y: 213 }, { x: 7675, y: 242 },
  { x: 8183, y: 358 }, { x: 8475, y: 756 }, { x: 8359, y: 1367 }, { x: 7829, y: 1684 }, { x: 7117, y: 1863 }, { x: 6763, y: 2079 },
  { x: 6593, y: 2418 }, { x: 6763, y: 2697 }, { x: 7214, y: 2857 }, { x: 7675, y: 2697 }, { x: 7741, y: 2261 }, { x: 8071, y: 1957 },
  { x: 8544, y: 1957 }, { x: 8986, y: 2164 }, { x: 9140, y: 2697 }, { x: 9030, y: 3136 }, { x: 8698, y: 3403 }, { x: 8601, y: 3751 },
  { x: 8735, y: 4102 }, { x: 9062, y: 4303 }, { x: 9322, y: 4673 }, { x: 9322, y: 5301 }, { x: 8855, y: 5705 }, { x: 7804, y: 5793 },
  { x: 6518, y: 5746 }, { x: 5963, y: 5423 }, { x: 5963, y: 4736 }, { x: 5583, y: 4347 }, { x: 5085, y: 4485 }, { x: 4774, y: 5034 },
  { x: 4432, y: 5423 },
];

// 커스텀(프로) 방 코스 목록 — 서버 NAMED_COURSES 인덱스와 짝
const PRO_COURSE_KEYS = ["a1", "a2", "a3", "racing", "hard", "serp", "c1", "c2", "c3"];

// 전 트랙 1회 생성 (클라 init/서버 부팅에서 호출, 결과 캐시)
let trackCache = null;
function buildTracks() {
  if (trackCache) return trackCache;
  const t = {};
  for (const k of ["a1", "a2", "a3", "racing", "hard", "serp", "c1", "c2", "c3", "retro1"]) {
    t[k] = makeTrack(RECIPES[k]);
  }
  t.d1 = makeHardTrack(chaikinClosed(D1_POINTS, 2), {
    halfWidth: 75, kerb: 12, samplesPerSegment: 4, startPointIndex: 236, tension: 0.38,
  });
  t.retro2 = makeHardTrack(HARD_POINTS, {
    halfWidth: 112, kerb: 16, samplesPerSegment: 28, startPointIndex: 1, tension: 0.34,
  });
  t.test = makeStadiumTrack();
  t.pro = [];
  for (let i = 0; i < PRO_COURSE_KEYS.length; i++) t.pro.push(makeTrack(RECIPES[PRO_COURSE_KEYS[i]]));
  trackCache = t;
  return t;
}

/* =============================================================================
 *  트랙 쿼리 — 세그먼트 힌트 캐시 (D-1 은 1072 세그먼트 : 힌트가 성능의 핵심)
 * -----------------------------------------------------------------------------
 *  s.trackHint(세그먼트 인덱스)는 "시뮬 상태의 일부"다 : 예측 히스토리에 저장되고
 *  스폰/텔레포트 시 -1 로 리셋된다(스테일 힌트가 다른 통로에 붙는 발산 방지).
 *  탐색은 점진 확장 : 힌트 ±8 → ±40 → 전체 1회.
 * ========================================================================== */
function segDistSq(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1) : 0;
  const cx = a.x + t * dx, cy = a.y + t * dy;
  const ex = x - cx, ey = y - cy;
  return { d2: ex * ex + ey * ey, t };
}

// 반환 { dist, phase, seg } — dist = 센터라인까지 거리, phase = 0~1 진행도.
//  hintObj 는 { seg } 형태(차 상태의 trackHint 를 넘겨 갱신).
function trackQuery(track, x, y, hintSeg) {
  const pts = track.centerline, n = pts.length;
  let best = -1, bestD2 = Infinity, bestT = 0;
  const scan = (from, to) => {
    for (let k = from; k < to; k++) {
      const i = ((k % n) + n) % n;
      const r = segDistSq(x, y, pts[i], pts[(i + 1) % n]);
      if (r.d2 < bestD2) { bestD2 = r.d2; best = i; bestT = r.t; }
    }
  };
  if (hintSeg >= 0 && hintSeg < n) {
    scan(hintSeg - 8, hintSeg + 9);
    // 힌트 근방 결과가 트랙 폭의 3배 밖이면 신뢰 불가 → 확장
    const w3 = track.halfWidth * 3;
    if (bestD2 > w3 * w3) {
      scan(hintSeg - 40, hintSeg - 8);
      scan(hintSeg + 9, hintSeg + 41);
      if (bestD2 > w3 * w3) { best = -1; bestD2 = Infinity; scan(0, n); }
    }
  } else {
    scan(0, n);
  }
  return { dist: Math.sqrt(bestD2), phase: (best + bestT) / n, seg: best };
}

/* =============================================================================
 *  차 상태
 * ========================================================================== */
function makeCarState(x, y, angle) {
  return {
    x: x || 0, y: y || 0, angle: angle || 0,
    vx: 0, vy: 0, lf: 0, ll: 0,
    steerInput: 0, throttle: 0, braking: 0, reversing: 0,
    drifting: false, driftBoostT: 0,
    evx: 0, evy: 0, spinV: 0,          // 외부 속도/스핀 채널 (충돌·넉백)
    invulnUntilTick: 0, lockUntilTick: 0, stunUntilTick: 0,
    punchReadyTick: 0, respawnReadyTick: 0,
    impactSlideUntilTick: 0,
    contactTick: -1,                    // 최근 충돌 해석 틱 (스냅샷 contact 비트)
    trackHint: -1,
  };
}

// 월드 속도 -> 차체 성분 재계산 (외부에서 vx/vy/angle 을 바꾼 뒤 반드시 호출)
function decompose(s) {
  const cos = Math.cos(s.angle), sin = Math.sin(s.angle);
  s.lf = s.vx * cos + s.vy * sin;
  s.ll = -s.vx * sin + s.vy * cos;
}

// 순간이동(스폰/출발선) : 위치·자세 설정 + 운동 전부 리셋 + 힌트 리셋
function teleport(s, x, y, angle) {
  s.x = x; s.y = y; s.angle = angle;
  s.vx = 0; s.vy = 0; s.lf = 0; s.ll = 0; s.steerInput = 0;
  s.evx = 0; s.evy = 0; s.spinV = 0;
  s.drifting = false; s.driftBoostT = 0;
  s.trackHint = -1; s.contactTick = -1;
}

/* 스냅샷 -> 시뮬 상태 주입 (조정 / 상대 리베이스 / 키프레임 공용 단일 헬퍼) */
function applyServerState(s, snap) {
  s.x = snap.x; s.y = snap.y; s.angle = snap.angle;
  s.vx = snap.vx; s.vy = snap.vy;
  if (snap.evx !== undefined) { s.evx = snap.evx; s.evy = snap.evy; }
  if (snap.spinV !== undefined) s.spinV = snap.spinV;
  if (snap.steer !== undefined) s.steerInput = snap.steer;
  if (snap.drifting !== undefined) {
    s.drifting = !!snap.drifting;
    s.driftBoostT = s.drifting ? 1 : 0;
  }
  if (snap.invulnTicks !== undefined && snap.tick !== undefined) s.invulnUntilTick = snap.tick + snap.invulnTicks;
  if (snap.lockTicks !== undefined && snap.tick !== undefined) s.lockUntilTick = snap.tick + snap.lockTicks;
  if (snap.stunTicks !== undefined && snap.tick !== undefined) s.stunUntilTick = snap.tick + snap.stunTicks;
  s.trackHint = -1;
  decompose(s);
}

/* 틱 종료 격자 양자화 — 스냅샷 인코딩과 같은 격자 (결정론의 핵심) */
function quantize(s) {
  s.x = Math.round(s.x * 4) / 4;
  s.y = Math.round(s.y * 4) / 4;
  s.vx = Math.round(s.vx * 8) / 8;
  s.vy = Math.round(s.vy * 8) / 8;
  s.evx = Math.round(s.evx * 8) / 8;
  s.evy = Math.round(s.evy * 8) / 8;
  s.spinV = Math.round(s.spinV * 8) / 8;
  s.angle = Math.round(normAngle(s.angle) * A2I) / A2I;
  s.steerInput = Math.round(s.steerInput * 127) / 127;
  decompose(s);
}

/* =============================================================================
 *  1틱 적분 — stepCar(s, buttons, env, dtScale, events)
 * -----------------------------------------------------------------------------
 *  env = {
 *    tick,                    // 현재 틱 (만료 판정)
 *    world: { w, h },         // 월드 경계 (noBounds 면 무시)
 *    track,                   // 트랙(없으면 null) — 노면 감속
 *    obstacles,               // 원형 장애물 배열(없으면 null)
 *    speedScale,              // 모드 속도 배율 (스모 2/3)
 *    noBounds,                // 스모 : 경계 없음
 *    freeze,                  // 완전 정지 (프로 대기/보스 사망 등)
 *  }
 *  dtScale : CCD 서브스텝 분수(1/n). 램프/감쇠는 지수형이라 분할 불변.
 *  events : 배열이면 { k, ... } 푸시 (wall / obstacle). 렌더 서브스텝은 null.
 * ========================================================================== */
function stepCar(s, buttons, env, dtScale, events) {
  const dt = DT * (dtScale || 1);
  const tick = env.tick;
  const scale = env.speedScale || 1;

  /* 1) 입력 -> 연속 입력값 */
  if (env.freeze) {
    s.throttle = 0; s.braking = 0; s.reversing = 0; s.steerInput = 0;
    s.vx = 0; s.vy = 0; s.lf = 0; s.ll = 0;
  } else if (tick < s.lockUntilTick) {
    // 하드 락(넉백 비행) : 조작 잠금 + 주행 속도 제거 — ev 로만 미끄러진다
    s.throttle = 0; s.braking = 0; s.reversing = 0; s.steerInput = 0;
    s.vx = 0; s.vy = 0; s.lf = 0; s.ll = 0;
  } else if (tick < s.stunUntilTick) {
    // 소프트 스턴(보스) : 입력만 잠금 — 관성 유지
    s.throttle = 0; s.braking = 0; s.reversing = 0;
  } else {
    s.throttle = (buttons & BTN.W) ? 1 : 0;
    s.braking = (buttons & BTN.SPACE) ? 1 : 0;
    s.reversing = (buttons & BTN.S) ? 1 : 0;
    const target = ((buttons & BTN.D) ? 1 : 0) - ((buttons & BTN.A) ? 1 : 0);
    // 조향 램프 — 지수형(서브스텝 불변). 6.0/s = 9000/weight(1500kg)
    s.steerInput += (target - s.steerInput) * (1 - Math.exp(-6.0 * dt));
  }

  /* 2) 조향 (heading 만 회전) */
  const speed = Math.hypot(s.vx, s.vy);
  const vmax = CAR_SPEC.maxSpeed * KMH_TO_PXS;
  {
    const speedRatio = clamp(speed / vmax, 0, 1);
    const lowSpeedGate = clamp(speed / (25 * KMH_TO_PXS), 0, 1);
    let authority = CAR_SPEC.highSpeedSteer * speedRatio + (1 - speedRatio); // lerp(1, hs, ratio)
    const trail = s.braking > 0 && s.braking < 0.8 && speed > 90 * KMH_TO_PXS && Math.abs(s.steerInput) > 0.15;
    if (trail) authority *= 1.18;
    // 드리프트 부스트 : 이진 스텝 대신 driftBoostT(0..1, 3틱 램프) — 직전 틱 grip 결과
    authority *= 1 + (CAR_SPEC.driftSteerBoost - 1) * s.driftBoostT;
    s.angle += CAR_SPEC.steering * s.steerInput * authority * lowSpeedGate * dt;
  }

  /* (분해) */
  decompose(s);

  /* 3) 엔진 */
  if (s.throttle > 0) {
    const v = Math.max(s.lf, 1);
    const driveAccel = Math.min(CAR_SPEC.enginePower / v, CAR_SPEC.acceleration);
    s.lf += driveAccel * s.throttle * dt * scale;
  }

  /* 4) 브레이크 */
  if (s.braking > 0 && s.lf !== 0) {
    const decel = CAR_SPEC.brakePower * s.braking * dt;
    if (s.lf > 0) s.lf = Math.max(0, s.lf - decel);
    else s.lf = Math.min(0, s.lf + decel);
  }

  /* 4-b) 후진 */
  if (s.reversing > 0 && s.throttle <= 0) {
    if (s.lf > 0) s.lf = Math.max(0, s.lf - CAR_SPEC.brakePower * dt);
    else {
      const reverseMax = CAR_SPEC.reverseSpeed * KMH_TO_PXS;
      s.lf = Math.max(-reverseMax, s.lf - CAR_SPEC.reverseAccel * dt);
    }
  }

  /* 5) 공기/구름 저항 */
  if (s.lf !== 0) {
    const v = Math.abs(s.lf);
    const dec = (CAR_SPEC.airResistance * v * v + CAR_SPEC.rollingResistance * v) * dt;
    if (s.lf > 0) s.lf = Math.max(0, s.lf - dec);
    else s.lf = Math.min(0, s.lf + dec);
  }

  /* 6) 노면 — 트랙 이탈 감속 (경계 ±12px 선형 램프 : 이진 분기 연속화) */
  if (env.track) {
    const q = trackQuery(env.track, s.x, s.y, s.trackHint);
    s.trackHint = q.seg;
    s.lastPhase01 = q.phase;              // 랩/타임어택 게이트가 재사용 (중복 스캔 제거)
    const over = q.dist - (env.track.halfWidth - OFFTRACK_RAMP);
    if (over > 0) {
      const k = clamp(over / (2 * OFFTRACK_RAMP), 0, 1);
      const f = Math.exp(-OFFTRACK_DRAG * k * dt);
      s.lf *= f; s.ll *= f;
    }
  }

  /* 7) 그립 — 브레이크 드리프트 (히스테리시스) */
  {
    let lateralFriction = CAR_SPEC.grip;
    const driftSpeed = CAR_SPEC.brakeDriftSpeed * KMH_TO_PXS;
    let wantDrift = false;
    if (s.braking > 0 && speed > driftSpeed) {
      const over = clamp((speed - driftSpeed) / (vmax - driftSpeed), 0, 1);
      if (Math.abs(s.steerInput) > 0.1) {
        if (s.braking < 0.6) {
          lateralFriction = CAR_SPEC.grip + (CAR_SPEC.grip * 0.72 - CAR_SPEC.grip) * over;
        } else {
          lateralFriction = CAR_SPEC.grip * 0.35 + (CAR_SPEC.driftGrip - CAR_SPEC.grip * 0.35) * over;
        }
      }
      // 히스테리시스 : 진입 34 / 해제 26 (미세 오차로 상태 플래핑 방지)
      const all = Math.abs(s.ll);
      wantDrift = s.drifting ? all > DRIFT_EXIT_LL : all > DRIFT_ENTER_LL;
    }
    s.drifting = wantDrift;
    // 임팩트 슬라이드 : 피격 직후엔 그립 상한 — 측면 밀림이 즉사하지 않고 실려 간다
    if (tick < s.impactSlideUntilTick) lateralFriction = Math.min(lateralFriction, IMPACT_SLIDE_GRIP);
    s.ll *= Math.exp(-lateralFriction * dt);
    // 드리프트 부스트 램프 (3틱) — dtScale 비례
    const dr = DRIFT_BOOST_RAMP * (dtScale || 1);
    s.driftBoostT = clamp(s.driftBoostT + (s.drifting ? dr : -dr), 0, 1);
  }

  /* 8) 합성/적분 — 전진 캡 + 외부 속도(ev) 채널 합산 */
  {
    const reverseMax = CAR_SPEC.reverseSpeed * KMH_TO_PXS * scale;
    s.lf = clamp(s.lf, -reverseMax, vmax * scale);
    const cos = Math.cos(s.angle), sin = Math.sin(s.angle);
    s.vx = s.lf * cos - s.ll * sin;
    s.vy = s.lf * sin + s.ll * cos;
    s.x += (s.vx + s.evx) * dt;
    s.y += (s.vy + s.evy) * dt;
    // ev/스핀 감쇠
    if (s.evx || s.evy) {
      const decay = Math.exp(-dt / EV_TAU);
      s.evx *= decay; s.evy *= decay;
      if (Math.hypot(s.evx, s.evy) < EV_STOP) { s.evx = 0; s.evy = 0; }
    }
    if (s.spinV) {
      s.angle += s.spinV * dt;
      s.spinV *= Math.exp(-dt / SPIN_TAU);
      if (Math.abs(s.spinV) < 0.05) s.spinV = 0;
    }
  }

  /* 9) 월드 경계 (스모는 없음) */
  if (!env.noBounds && env.world) {
    const acos = Math.abs(Math.cos(s.angle)), asin = Math.abs(Math.sin(s.angle));
    const halfX = CAR_HL * acos + CAR_HW * asin;
    const halfY = CAR_HL * asin + CAR_HW * acos;
    const preSpeed = Math.hypot(s.vx + s.evx, s.vy + s.evy);
    let hit = false;
    if (s.x < halfX) { s.x = halfX; if (s.vx < 0) s.vx = 0; if (s.evx < 0) s.evx = 0; hit = true; }
    if (s.x > env.world.w - halfX) { s.x = env.world.w - halfX; if (s.vx > 0) s.vx = 0; if (s.evx > 0) s.evx = 0; hit = true; }
    if (s.y < halfY) { s.y = halfY; if (s.vy < 0) s.vy = 0; if (s.evy < 0) s.evy = 0; hit = true; }
    if (s.y > env.world.h - halfY) { s.y = env.world.h - halfY; if (s.vy > 0) s.vy = 0; if (s.evy > 0) s.evy = 0; hit = true; }
    if (hit) {
      decompose(s);
      if (events && preSpeed > 60) events.push({ k: "wall", speed: preSpeed });
    }
  }

  /* 10) 원형 장애물 (보스 기둥 / 광장) */
  if (env.obstacles) {
    const cos = Math.cos(s.angle), sin = Math.sin(s.angle);
    const preSpeed = Math.hypot(s.vx + s.evx, s.vy + s.evy);
    let hitDepth = 0;
    for (const o of env.obstacles) {
      hitDepth = Math.max(hitDepth, collideCircle(s, cos, sin, o.x, o.y, o.r));
    }
    if (events && hitDepth > 0.5 && preSpeed > 60) events.push({ k: "obstacle", speed: preSpeed });
  }
}

/* 원형 장애물 밖으로 차(OBB)를 밀어냄 + 파고드는 속도(주행+ev) 제거. 깊이 반환. */
function collideCircle(s, cos, sin, px, py, pr) {
  const dx = px - s.x, dy = py - s.y;
  const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
  const nx = clamp(lx, -CAR_HL, CAR_HL), ny = clamp(ly, -CAR_HW, CAR_HW);
  const ddx = lx - nx, ddy = ly - ny;
  const d = Math.hypot(ddx, ddy);
  if (d >= pr) return 0;
  let ux, uy;
  if (d < 0.001) {
    const dd = Math.hypot(dx, dy);
    if (dd < 0.001) { ux = 1; uy = 0; } else { ux = -dx / dd; uy = -dy / dd; }
  } else {
    const wx = ddx * cos - ddy * sin, wy = ddx * sin + ddy * cos;
    const n = Math.hypot(wx, wy);
    ux = -wx / n; uy = -wy / n;
  }
  const push = pr - d;
  s.x += ux * push; s.y += uy * push;
  const vr = s.vx * ux + s.vy * uy;
  if (vr < 0) { s.vx -= vr * ux; s.vy -= vr * uy; decompose(s); }
  const er = s.evx * ux + s.evy * uy;
  if (er < 0) { s.evx -= er * ux; s.evy -= er * uy; }
  return push;
}

/* =============================================================================
 *  차대차 충돌 — OBB SAT + 임펄스(ev 채널) (NETCODE.md §5)
 * ========================================================================== */
function obbMTV(a, b) {
  const aC = Math.cos(a.angle), aS = Math.sin(a.angle);
  const bC = Math.cos(b.angle), bS = Math.sin(b.angle);
  const axes = [{ x: aC, y: aS }, { x: -aS, y: aC }, { x: bC, y: bS }, { x: -bS, y: bC }];
  const dx = b.x - a.x, dy = b.y - a.y;
  let minOv = Infinity, nx = 0, ny = 0;
  for (const ax of axes) {
    const aR = CAR_HL * Math.abs(ax.x * aC + ax.y * aS) + CAR_HW * Math.abs(-ax.x * aS + ax.y * aC);
    const bR = CAR_HL * Math.abs(ax.x * bC + ax.y * bS) + CAR_HW * Math.abs(-ax.x * bS + ax.y * bC);
    const proj = dx * ax.x + dy * ax.y;
    const ov = aR + bR - Math.abs(proj);
    if (ov <= 0) return null;
    if (ov < minOv) {
      minOv = ov;
      const sgn = proj >= 0 ? -1 : 1; // A 를 B 반대쪽으로 미는 방향
      nx = ax.x * sgn; ny = ax.y * sgn;
    }
  }
  return { nx, ny, depth: minOv };
}

/* 한 페어 해석. impulseScale : 클라 예측은 0.5(부드러운 쪽으로 오차), 서버 1.0.
 *  contacts : Map("a:b" -> {nx,ny,tick}) — 접촉 법선 히스테리시스(축 플립 핀볼 방지).
 *  반환 : null | { dvA, dvB } (이벤트/사운드용 크기) */
function resolveCarCar(a, b, tick, impulseScale, contacts, pairId) {
  let mtv = obbMTV(a, b);
  if (!mtv) return null;

  // 법선 히스테리시스 : 직전 접촉 법선과 부호 정렬 + 급전환 억제
  if (contacts && pairId) {
    const prev = contacts.get(pairId);
    if (prev && tick - prev.tick <= 3) {
      const dot = mtv.nx * prev.nx + mtv.ny * prev.ny;
      if (dot < -0.3) { mtv.nx = prev.nx; mtv.ny = prev.ny; } // 축 반전 → 이전 법선 유지
    }
    contacts.set(pairId, { nx: mtv.nx, ny: mtv.ny, tick });
  }

  // 위치 분리 (질량 동일 반반)
  const half = mtv.depth / 2;
  a.x += mtv.nx * half; a.y += mtv.ny * half;
  b.x -= mtv.nx * half; b.y -= mtv.ny * half;

  // 상대 속도 (총속도 = 주행 + ev)
  const avx = a.vx + a.evx, avy = a.vy + a.evy;
  const bvx = b.vx + b.evx, bvy = b.vy + b.evy;
  const rvx = avx - bvx, rvy = avy - bvy;
  // 법선 n = A 를 미는 방향. 접근 중이면 (rv . n) < 0
  const vn = rvx * mtv.nx + rvy * mtv.ny;
  if (vn >= 0) return { dvA: 0, dvB: 0 }; // 이미 분리 중 — 위치 분리만

  const closing = -vn;
  // 반발계수 : 저속 0 / 0.25 -> 고속 0.05
  let e;
  if (closing < COL_E_V0) e = 0;
  else if (closing < COL_E_V1) e = COL_E_LOW;
  else if (closing < COL_E_V2) e = COL_E_LOW + (COL_E_HIGH - COL_E_LOW) * ((closing - COL_E_V1) / (COL_E_V2 - COL_E_V1));
  else e = COL_E_HIGH;

  // 등질량 임펄스 : 각자 delta-v = (1+e)*closing/2, 상한 캡
  let dv = Math.min((1 + e) * closing / 2, COL_DV_CAP) * (impulseScale || 1);

  // 접선 마찰
  const tx = -mtv.ny, ty = mtv.nx;
  const vt = rvx * tx + rvy * ty;
  const dvt = clamp(-vt / 2, -COL_MU * dv, COL_MU * dv) * (impulseScale || 1);

  // ev 채널에 적용 (lf 캡이 임펄스를 소멸시키지 않도록 — 리뷰 블로커 해소)
  a.evx += mtv.nx * dv + tx * dvt; a.evy += mtv.ny * dv + ty * dvt;
  b.evx -= mtv.nx * dv + tx * dvt; b.evy -= mtv.ny * dv + ty * dvt;

  // 요 토크 : 접선 상대속도 방향으로 소량 회전, 상한
  if (closing > COL_YAW_V0) {
    const yaw = clamp((closing - COL_YAW_V0) / (COL_E_V2 - COL_YAW_V0), 0, 1) * COL_YAW_MAX;
    const sgn = vt >= 0 ? 1 : -1;
    a.spinV += sgn * yaw * 0.35 * (impulseScale || 1);
    b.spinV += sgn * yaw * 0.35 * (impulseScale || 1);
  }

  // 임팩트 슬라이드 + 접촉 마킹
  if (dv > IMPACT_SLIDE_DV) {
    a.impactSlideUntilTick = tick + IMPACT_SLIDE_TICKS;
    b.impactSlideUntilTick = tick + IMPACT_SLIDE_TICKS;
  }
  a.contactTick = tick; b.contactTick = tick;
  return { dvA: dv, dvB: dv };
}

/* =============================================================================
 *  그룹 스텝 — 페어 상대 변위 기준 CCD 서브스텝 (클라/서버 동일 코드가 핵심)
 * -----------------------------------------------------------------------------
 *  entries = [{ s, buttons, id }...]  (id 는 페어 키/이벤트용, 정수)
 *  opts = { collide, impulseScale, contacts(Map), events(배열) }
 * ========================================================================== */
function stepGroup(entries, env, opts) {
  const collide = opts && opts.collide;
  const events = opts ? opts.events : null;
  // 서브스텝 수 : 최대 변위(단독 + 페어 상대) / SUBSTEP_LEN — 상태만으로 결정(결정론)
  let maxDisp = 0;
  for (const e of entries) {
    const s = e.s;
    const sp = (Math.hypot(s.vx + s.evx, s.vy + s.evy)) * DT;
    if (sp > maxDisp) maxDisp = sp;
  }
  if (collide) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i].s, b = entries[j].s;
        const rel = Math.hypot((a.vx + a.evx) - (b.vx + b.evx), (a.vy + a.evy) - (b.vy + b.evy)) * DT;
        if (rel > maxDisp) maxDisp = rel;
        }
    }
  }
  const substeps = clamp(Math.ceil(maxDisp / SUBSTEP_LEN), 1, SUBSTEP_MAX);
  const dtScale = 1 / substeps;

  for (let step = 0; step < substeps; step++) {
    for (const e of entries) stepCar(e.s, e.buttons, e.env || env, dtScale, events);
    if (collide) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const A = entries[i], B = entries[j];
          if (A.s.noCollide || B.s.noCollide) continue;
          const pairId = A.id < B.id ? A.id + ":" + B.id : B.id + ":" + A.id;
          const r = resolveCarCar(A.s, B.s, env.tick, (opts && opts.impulseScale) || 1, opts && opts.contacts, pairId);
          if (r && events && r.dvA > 40) events.push({ k: "carHit", a: A.id, b: B.id, dv: r.dvA });
        }
      }
    }
  }
  for (const e of entries) quantize(e.s);
  return substeps;
}

/* =============================================================================
 *  랩 / 타임어택 게이트 (틱 기반 — 클라 예측과 서버 검증이 같은 코드)
 * -----------------------------------------------------------------------------
 *  phase 는 stepCar 가 노면 처리 중 계산해 둔 s.lastPhase01 를 재사용한다
 *  (트랙 없는 모드에선 trackQuery 직접 호출).
 * ========================================================================== */
// lp = { checkpoint, lastPhase } — 통과 시 true 반환(랩 1 증가는 호출자가)
function lapGate(lp, phase) {
  if (phase > 0.4 && phase < 0.6) lp.checkpoint = true;
  const crossed = lp.checkpoint && lp.lastPhase > 0.75 && phase < 0.25;
  if (crossed) lp.checkpoint = false;
  lp.lastPhase = phase;
  return crossed;
}

/* att = { state: 0 idle | 1 armed | 2 running, startTick, checkpoint, lastPhase }
 *  반환 : null | { k: "start" } | { k: "finish", ticks } */
function attackStep(att, s, tick) {
  if (att.state === 0) return null;
  const phase = s.lastPhase01 || 0;
  if (att.state === 1) {
    if (Math.abs(s.lf) > 0.5 * KMH_TO_PXS) {
      att.state = 2;
      att.startTick = tick;
      att.checkpoint = false;
      att.lastPhase = phase;
      return { k: "start" };
    }
    att.lastPhase = phase;
    return null;
  }
  // running
  if (lapGate(att, phase)) {
    att.state = 0;
    return { k: "finish", ticks: tick - att.startTick };
  }
  return null;
}

/* 출발선 뒤 배치 좌표 */
function placeBehindStart(track) {
  const st = track.start;
  const back = 3 + 4 + (CAR_SPEC.length * 1.15) / 2;
  return { x: st.x - Math.cos(st.angle) * back, y: st.y - Math.sin(st.angle) * back, angle: st.angle };
}

/* 프로 그리드 슬롯 (2열 스태거) */
function proGridPosition(track, slot) {
  const st = track.start;
  const fwd = { x: Math.cos(st.angle), y: Math.sin(st.angle) };
  const right = { x: Math.cos(st.angle + Math.PI / 2), y: Math.sin(st.angle + Math.PI / 2) };
  const row = Math.floor(slot / 2), col = slot % 2;
  const front = 3 + 4 + (CAR_SPEC.length * 1.15) / 2;
  const back = front + row * 75;
  const lateral = (col === 0 ? -1 : 1) * 70;
  return { x: st.x - fwd.x * back + right.x * lateral, y: st.y - fwd.y * back + right.y * lateral, angle: st.angle };
}

/* 틱 <-> ms (기록 표기 : floor — 화면 타이머와 동일 내림) */
const ticksToMs = (t) => Math.floor(t * TICK_MS);

return {
  TICK_RATE, TICK_MS, DT, A2I, KMH_TO_PXS, PIXELS_PER_METER,
  BTN, CAR_SPEC, CAR_HL, CAR_HW, VMAX,
  OFFTRACK_DRAG, SUMO, PLAZA_OBSTACLES, PLAZA_SPAWNS, BOSS_PILLARS, WORLD_DIMS,
  SUBSTEP_LEN, SUBSTEP_MAX, EV_TAU,
  IMPACT_SLIDE_DV, IMPACT_SLIDE_TICKS,
  clamp, normAngle,
  buildTracks, PRO_COURSE_KEYS, trackQuery,
  makeCarState, decompose, teleport, applyServerState, quantize,
  stepCar, stepGroup, resolveCarCar, obbMTV, collideCircle,
  lapGate, attackStep, placeBehindStart, proGridPosition, ticksToMs,
};

})();

// 서버(require) 전용 내보내기. 브라우저 번들에선 module 이 없어 건너뛰고,
// const SIM 이 IIFE 래퍼 스코프에 남아 game.js 만 접근 가능(콘솔 비노출).
if (typeof module !== "undefined" && module.exports) module.exports = SIM;
