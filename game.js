"use strict";

/* =============================================================================
 *  TOP-VIEW SUPERCAR PHYSICS ENGINE
 * -----------------------------------------------------------------------------
 *  현실의 슈퍼카 거동(관성 / 마찰 / 타이어 그립 / 드리프트 / 무게감)을 목표로 한
 *  탑뷰 차량 물리 엔진입니다.  아케이드식 "speed += 값" 방식이 아니라,
 *  속도 벡터를 차체 기준 "전진 성분 / 측면 성분" 으로 분해하여 처리합니다.
 *
 *  핵심 아이디어
 *  ------------------------------------------------------------------
 *  - 차량은 "바라보는 방향(heading/angle)" 과 "실제 진행하는 속도 벡터(v)" 를
 *    별도로 가진다.
 *  - 조향은 heading 만 즉시 회전시킨다. 속도 벡터는 관성 때문에 그대로 남는다.
 *    → 이 순간 heading 과 v 가 어긋나며 "슬립 앵글(Slip Angle)" 이 생긴다.
 *  - 타이어 그립(측면 마찰)이 매 프레임 측면 속도를 조금씩 깎아 v 를 heading
 *    방향으로 끌어당긴다. 그립이 높으면 즉시 정렬(깔끔한 코너링),
 *    그립이 낮으면 천천히 정렬(드리프트/슬라이드).
 *  - 그립은 속도가 높을수록 낮아진다 → 고속에서 자연스럽게 드리프트 발생.
 *
 *  모든 튜닝 상수는 아래 CONFIG / CAR 에 모여 있어 쉽게 수정/차량 추가 가능.
 * ========================================================================== */


/* =============================================================================
 *  단위 / 전역 설정
 * ========================================================================== */
const CONFIG = {
  // 서바이벌 맵 크기 : 5000 x 5000 px
  MAP_SIZE: 5000,

  // 픽셀 <-> 미터 환산 (물리 계산은 px/s 로 하되, 화면 표시는 km/h 로 변환)
  PIXELS_PER_METER: 8,

  // 한 프레임 dt 상한 (탭 비활성 등으로 인한 물리 폭발 방지)
  MAX_DT: 1 / 30,
};

/* =============================================================================
 *  게임 모드 / 월드
 * -----------------------------------------------------------------------------
 *  - survival : 5000² 오픈 맵. 머리로 받혀 죽으면 모드 선택으로 복귀.
 *  - racing   : 사진 같은 꼬불꼬불한 카트 서킷. 죽음 없음. 트랙 이탈 시 감속.
 * ========================================================================== */
const WORLD = {
  survival: { w: 5000, h: 5000, type: "open" },
  racing: { w: 10000, h: 6000, type: "track", track: null },  // 자유 레이싱
  pro: { w: 10000, h: 6000, type: "track", track: null },     // 프로 레이싱(다른 서킷)
};

// 현재 모드/월드/게임 상태
let gameMode = "survival";   // "survival" | "racing" | "pro"
let world = WORLD.survival;  // 현재 월드 치수/타입
let gameState = "menu";      // "menu" | "playing"
let playerName = "Player";

// 프로 레이싱 상태 (서버 'race' 메시지로 갱신)
const race = {
  state: "none",     // "none" | "lobby" | "countdown" | "racing"
  laps: 3,
  slot: 0,           // 내 그리드 슬롯
  list: [],          // 순위 [{id,name,ready,lap,finished,rank}]
  canReady: false,   // 2명 이상이면 true
  myReady: false,
  countdownEnd: 0,   // 로컬 시각(performance.now): 카운트다운 끝
  endEnd: 0,         // 로컬 시각: 종료 타이머 끝 (0=없음)
  goFlashUntil: 0,   // "GO!" 표시 끝 시각
  // 내 바퀴 추적
  lap: 0, prog: 0, lastPhase: 0, checkpoint: false,
};

const OFFTRACK_DRAG = 2.4;   // 트랙 이탈 시 추가 감속 계수 (클수록 풀밭처럼 느려짐)

/* 레이싱 트랙(카트 서킷) ------------------------------------------------------
 *  중심선을 "별모양 보장(자기교차 없음)" 극좌표식 폐곡선으로 생성한다.
 *      point(θ) = center + ( R(θ)·cosθ , R(θ)·sinθ ),  R(θ) > 0
 *  여러 주파수의 사인을 더해 코너가 많은 굽이진 서킷을 만든다. R 이 항상
 *  양수라 중심에서 별모양이라 절대 자기 자신과 교차하지 않는다.
 *  자유/프로는 하모닉만 달리해 비슷하지만 다른 트랙을 만든다. */
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

  const path = new Path2D();
  centerline.forEach((p, i) => i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y));
  path.closePath();

  const a0 = centerline[0], a1 = centerline[1];
  const start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
  return { halfWidth: opts.halfWidth, kerb: opts.kerb, centerline, path, start };
}

/* 자유 레이싱 = 항상 "원래 맵"으로 고정 (랜덤 X) */
const FREE_RECIPE = {
  w: 10000, h: 6000, halfWidth: 230, kerb: 26, stretch: 1.7,
  R: a => 1 + 0.16 * Math.sin(2 * a + 0.6) + 0.30 * Math.sin(3 * a + 0.4)
        + 0.18 * Math.sin(5 * a + 1.3) + 0.10 * Math.sin(7 * a + 0.2),
};

/* 프로 레이싱 전용 맵 풀 (더 구불구불, 5종). 서버가 인덱스를 정해 같은 레이스의
 *  모든 플레이어가 같은 맵을 보게 한다. R 진폭 합 < 1 → 항상 R>0(자기교차 없음).
 *  server.js 의 PRO_RECIPE_COUNT 와 개수를 맞춰야 한다. */
const PRO_RECIPES = [
  { w: 10000, h: 6000, halfWidth: 215, kerb: 25, stretch: 1.6,
    R: a => 1 + 0.22 * Math.sin(2 * a + 1.5) + 0.18 * Math.sin(3 * a + 2.2)
          + 0.24 * Math.sin(4 * a + 0.5) + 0.14 * Math.sin(6 * a + 1.0) },
  { w: 10000, h: 6000, halfWidth: 210, kerb: 24, stretch: 1.75,
    R: a => 1 + 0.16 * Math.sin(2 * a + 0.2) + 0.26 * Math.sin(3 * a + 1.8)
          + 0.18 * Math.sin(5 * a + 0.7) + 0.14 * Math.sin(7 * a + 2.0) + 0.08 * Math.sin(9 * a + 0.4) },
  { w: 10000, h: 6000, halfWidth: 220, kerb: 26, stretch: 1.55,
    R: a => 1 + 0.24 * Math.sin(2 * a + 2.5) + 0.16 * Math.sin(4 * a + 0.9)
          + 0.22 * Math.sin(5 * a + 1.6) + 0.10 * Math.sin(7 * a + 0.3) + 0.08 * Math.sin(8 * a + 2.2) },
  { w: 10000, h: 6000, halfWidth: 205, kerb: 24, stretch: 1.7,
    R: a => 1 + 0.18 * Math.sin(2 * a + 1.0) + 0.24 * Math.sin(3 * a + 0.5)
          + 0.16 * Math.sin(5 * a + 2.3) + 0.16 * Math.sin(6 * a + 1.2) + 0.10 * Math.sin(8 * a + 0.6) },
  { w: 10000, h: 6000, halfWidth: 218, kerb: 25, stretch: 1.65,
    R: a => 1 + 0.20 * Math.sin(2 * a + 0.9) + 0.20 * Math.sin(3 * a + 2.6)
          + 0.20 * Math.sin(4 * a + 1.4) + 0.12 * Math.sin(6 * a + 0.2) + 0.10 * Math.sin(9 * a + 1.9) },
];

// 프로 트랙을 인덱스로 만들고 캐시한다 (한 번 만든 맵은 재사용)
const proTrackCache = new Map();
function buildProTrack(index) {
  const i = ((index % PRO_RECIPES.length) + PRO_RECIPES.length) % PRO_RECIPES.length;
  if (!proTrackCache.has(i)) proTrackCache.set(i, makeTrack(PRO_RECIPES[i]));
  return proTrackCache.get(i);
}

function generateTracks() {
  WORLD.racing.track = makeTrack(FREE_RECIPE); // 자유 = 고정
  WORLD.pro.track = buildProTrack(0);          // 프로 기본값 (서버 인덱스로 교체됨)
}

// km/h -> px/s 변환 계수.  (km/h ÷ 3.6 = m/s) × (m -> px)
const KMH_TO_PXS = (1 / 3.6) * CONFIG.PIXELS_PER_METER;
// px/s -> km/h (속도계 표시에 사용)
const PXS_TO_KMH = 1 / KMH_TO_PXS;


/* =============================================================================
 *  차량 데이터 구조
 * -----------------------------------------------------------------------------
 *  향후 여러 차량을 추가하기 쉽도록 "스펙(불변)" 과 "상태(매 프레임 변함)" 를
 *  하나의 객체로 두고, 스펙 값은 모두 여기 상단에서 튜닝한다.
 *  새 차량을 추가할 땐 이 객체를 복제해 수치만 바꾸면 된다.
 * ========================================================================== */
const CAR = {
  // ---- 스펙 (튜닝 값) -------------------------------------------------------
  maxSpeed: 1200,          // 최고속도 (km/h) — 이 값을 절대 넘지 않음
  acceleration: 165,      // 트랙션 한계 가속도 (px/s²) — 출발 시 최대 가속(접지력 한계)
  brakePower: 230,        // 브레이크 감속도 (px/s²) — 강력하지만 즉시정지 X (ABS 느낌)

  reverseSpeed: 50,       // 후진 최고속도 (km/h) — 전진보다 훨씬 느리게
  reverseAccel: 90,       // 후진 가속도 (px/s²) — 전진보다 약하게

  grip: 13.0,             // 평상시 측면 그립 계수 (1/s) — 클수록 미끄럼 즉시 제거(드리프트 X)
  driftGrip: 1.2,         // 브레이크 드리프트 시 측면 그립 (1/s) — 작을수록 더 크게 옆으로 미끄러짐
  brakeDriftSpeed: 110,   // 이 속도(km/h) 이상에서 브레이크를 밟아야 드리프트 발생

  steering: 3.0,          // 최대 조향 각속도 (rad/s) — 풀 카운터 시 1초에 회전하는 라디안
  highSpeedSteer: 0.40,   // 고속에서 남는 조향 권한 비율 (0~1) — 고속일수록 핸들 둔해짐
  driftSteerBoost: 1.7,   // 드리프트 중 조향 권한 배수 — 뒤가 풀려 차가 더 잘 돌아 슬립각↑

  weight: 1500,           // 차량 질량 (kg) — 무게감/반응속도(조향 램프, 그립 회복)에 사용

  airResistance: 7.0e-5,  // 공기저항 계수 — 감속 ∝ 속도² (고속에서 커짐). 낮출수록 관성↑
  rollingResistance: 0.012, // 구름저항 계수 — 감속 ∝ 속도 (저속 코스팅). 낮출수록 더 오래 굴러감

  enginePower: 0,         // 엔진 출력 — init()에서 maxSpeed 기준으로 자동 산출

  // 차체 크기 (px) — 렌더 및 충돌용
  length: 38,
  width: 18,

  // ---- 상태 (매 프레임 갱신) ------------------------------------------------
  x: CONFIG.MAP_SIZE / 2,  // 월드 좌표 x
  y: CONFIG.MAP_SIZE / 2,  // 월드 좌표 y
  angle: -Math.PI / 2,     // 바라보는 방향(heading). -90° = 화면상 위쪽

  vx: 0, vy: 0,            // 월드 좌표 속도 벡터 (px/s)
  lf: 0,                   // 차체 기준 전진 속도 성분 (local forward)
  ll: 0,                   // 차체 기준 측면 속도 성분 (local lateral) — 드리프트의 핵심

  // 입력(부드럽게 보간된 값)
  throttle: 0,             // 0~1
  braking: 0,              // 0~1
  reversing: 0,            // 0~1 (S 키) — 후진
  steerInput: 0,           // -1(좌) ~ +1(우), 부드럽게 램프됨

  drifting: false,         // 현재 브레이크 드리프트 중인지 (자국/조향/네트워크 공통 기준)
  invulnUntil: 0,          // 이 시각(performance.now ms)까지 무적 — 부활 직후 보호
};


/* =============================================================================
 *  우클릭 / 개발자도구 차단 (캐주얼 억제용 — 완전 차단은 불가)
 * -----------------------------------------------------------------------------
 *  주의: 브라우저 메뉴·JS 비활성화·디바이스 모드 등으로 우회 가능하므로
 *  "보안"이 아니라 "초보 방지" 수준이다. 진짜 방지는 서버 권위 검증이 필요.
 * ========================================================================== */
// 우클릭(컨텍스트 메뉴) 차단
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 개발자도구/소스보기 단축키 차단 (capture 단계에서 먼저 가로챔)
window.addEventListener("keydown", (e) => {
  const k = (e.key || "").toLowerCase();
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (
    e.key === "F12" ||                                         // F12
    (ctrlOrCmd && e.shiftKey && (k === "i" || k === "j" || k === "c")) || // 검사/콘솔
    (ctrlOrCmd && k === "u")                                   // 소스 보기
  ) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);


/* =============================================================================
 *  입력 처리
 * ========================================================================== */
const keys = { w: false, a: false, s: false, d: false, space: false };

// Enter 로 채팅창을 포커스한 그 Enter 의 keyup 이 곧바로 전송/blur 되는 것을 막는 플래그
let chatFocusGuard = false;

// 텍스트 입력(이름창)에 포커스가 있거나 메뉴 화면이면 게임 키 입력을 무시한다.
function typingInInput() {
  const el = document.activeElement;
  return el && el.tagName === "INPUT";
}

window.addEventListener("keydown", (e) => {
  // Enter : 입력창에 포커스가 없으면 채팅 입력창으로 바로 포커스
  if (e.code === "Enter" && !typingInInput() && gameState === "playing") {
    document.getElementById("chatInput").focus();
    chatFocusGuard = true; // 이 Enter 의 keyup 은 전송이 아니라 포커스용
    e.preventDefault();
    return;
  }
  if (typingInInput()) return; // 입력창(이름/채팅) 사용 중엔 WASD/S/Space 가로채지 않음
  switch (e.code) {
    case "KeyW": keys.w = true; break;
    case "KeyA": keys.a = true; break;
    case "KeyS": keys.s = true; break;
    case "KeyD": keys.d = true; break;
    case "Space": keys.space = true; e.preventDefault(); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW": keys.w = false; break;
    case "KeyA": keys.a = false; break;
    case "KeyS": keys.s = false; break;
    case "KeyD": keys.d = false; break;
    case "Space": keys.space = false; break;
  }
});


/* =============================================================================
 *  유틸리티
 * ========================================================================== */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;

// 차량의 현재 진행 속력(스칼라, px/s)
function speedOf(car) {
  return Math.hypot(car.vx, car.vy);
}


/* =============================================================================
 *  초기화 — maxSpeed 와 저항 계수로부터 엔진 출력을 역산
 * -----------------------------------------------------------------------------
 *  엔진은 "출력(파워) 한계" 모델을 쓴다 :  구동 가속도 = power / 속도.
 *  → 저속에선 트랙션 한계(acceleration)로 제한되고,
 *    고속에선 1/속도 로 줄어들어 자연스럽게 최고속도에서 멈춘다.
 *  최고속도 vmax 에서 (구동 가속도 == 저항 가속도) 가 되도록 power 를 정한다 :
 *      power / vmax = air·vmax² + roll·vmax
 *      power        = air·vmax³ + roll·vmax²
 * ========================================================================== */
function init() {
  const vmax = CAR.maxSpeed * KMH_TO_PXS;
  CAR.enginePower =
    CAR.airResistance * vmax * vmax * vmax +
    CAR.rollingResistance * vmax * vmax;

  generateTracks(); // 자유/프로 레이싱 트랙 생성
}


/* =============================================================================
 *  물리 파이프라인
 *  입력 → 조향 → (속도 분해) → 엔진 → 브레이크 → 공기/구름저항
 *       → 그립(측면마찰) → 속도/위치 → 충돌 → 카메라 → 렌더
 * ========================================================================== */

/* 1) 입력 처리 ---------------------------------------------------------------
 *  키 상태를 차량의 연속 입력값으로 변환한다.
 *  특히 조향은 즉시 -1/+1 로 튀지 않고 목표값으로 "램프(ramp)" 시켜
 *  무거운 차의 핸들 반응 지연을 표현한다 (무게가 클수록 느리게 반응). */
function updateInput(car, dt) {
  // 프로 레이싱 로비/카운트다운 동안엔 움직일 수 없다 (그리드에서 정지)
  if (gameMode === "pro" && (race.state === "lobby" || race.state === "countdown")) {
    car.throttle = 0; car.braking = 0; car.reversing = 0; car.steerInput = 0;
    car.vx = 0; car.vy = 0; car.lf = 0; car.ll = 0;
    return;
  }

  car.throttle = keys.w ? 1 : 0;
  car.braking = keys.space ? 1 : 0;
  car.reversing = keys.s ? 1 : 0;

  // 목표 조향 : A=좌(-1), D=우(+1)
  const target = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);

  // 무게 기반 조향 반응 속도. 무거울수록 핸들 입력이 천천히 찬다.
  const responsiveness = 9000 / car.weight; // 1500kg -> 6.0 /s
  const t = clamp(responsiveness * dt, 0, 1);
  car.steerInput = lerp(car.steerInput, target, t);
}

/* 2) 조향 -------------------------------------------------------------------
 *  heading(바라보는 방향)만 회전시킨다. 속도 벡터는 건드리지 않으므로
 *  이 순간부터 heading 과 진행방향이 어긋나기 시작한다(=슬립 앵글의 씨앗).
 *  - 정지 상태에선 회전하지 않는다(제자리 회전 방지) → 탱크 조향 배제.
 *  - 고속일수록 조향 권한이 줄어 급격한 방향전환을 막는다(고속 안정성). */
function updateSteering(car, dt) {
  const speed = speedOf(car);
  const speedRatio = clamp(speed / (car.maxSpeed * KMH_TO_PXS), 0, 1);

  // 저속 게이트 : 속도가 거의 0이면 조향 거의 없음, 일정 속도부터 완전 적용
  const lowSpeedGate = clamp(speed / (25 * KMH_TO_PXS), 0, 1);

  // 고속 권한 감소 : 1(저속) → highSpeedSteer(고속) 로 보간
  let authority = lerp(1, car.highSpeedSteer, speedRatio);

  // 드리프트 중엔 뒤가 풀려 차가 더 잘 돈다 → 조향 권한을 키워 슬립각을 크게 만든다
  //  (car.drifting 은 직전 프레임 updateGrip 에서 갱신된 값 — 한 프레임 지연은 무시 가능)
  if (car.drifting) authority *= car.driftSteerBoost;

  const turnRate = car.steering * car.steerInput * authority * lowSpeedGate;
  car.angle += turnRate * dt;
}

/* (속도 분해) ----------------------------------------------------------------
 *  월드 속도 벡터 v 를 "현재 heading 기준" 전진/측면 성분으로 분해한다.
 *  heading 벡터  f = (cos a, sin a)
 *  우측  벡터    r = (-sin a, cos a)
 *  lf = v·f (전진),  ll = v·r (측면). */
function decompose(car) {
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  car.lf = car.vx * cos + car.vy * sin;
  car.ll = -car.vx * sin + car.vy * cos;
}

/* 3) 엔진 가속 ---------------------------------------------------------------
 *  구동 가속도 = enginePower / 속도, 단 트랙션 한계(acceleration)로 상한.
 *  → 출발 직후엔 일정한 강한 가속(접지 한계), 속도가 붙을수록 1/v 로 점점
 *    힘이 줄어 최고속도에 가까워질수록 가속이 둔해진다(현실적인 RPM 체감). */
function updateEngine(car, dt) {
  if (car.throttle <= 0) return;

  const v = Math.max(car.lf, 1); // 0 나눗셈 방지
  let driveAccel = car.enginePower / v;
  driveAccel = Math.min(driveAccel, car.acceleration); // 트랙션 한계

  car.lf += driveAccel * car.throttle * dt;
}

/* 4) 브레이크 ----------------------------------------------------------------
 *  강력하지만 즉시 0 으로 만들지 않는다. 일정한 감속도를 매 프레임 빼되,
 *  음수(후진)로 내려가지 않도록 0 에서 멈춘다 (ABS가 잡아주는 느낌). */
function updateBrake(car, dt) {
  if (car.braking <= 0 || car.lf <= 0) return;

  const decel = car.brakePower * car.braking * dt;
  car.lf = Math.max(0, car.lf - decel);
}

/* 4-b) 후진 (S) --------------------------------------------------------------
 *  - 전진 중이면 먼저 브레이크처럼 감속시킨다(바로 후진 X).
 *  - 정지/후진 중이면 뒤로 가속한다. 전진보다 약하고 최고속도도 낮다.
 *  - W(전진)가 눌려 있으면 전진이 우선이라 후진은 무시한다. */
function updateReverse(car, dt) {
  if (car.reversing <= 0 || car.throttle > 0) return;

  if (car.lf > 0) {
    // 전진 중 → 감속
    car.lf = Math.max(0, car.lf - car.brakePower * dt);
  } else {
    // 정지/후진 중 → 뒤로 가속 (음수 방향), 후진 최고속도로 제한
    const reverseMax = car.reverseSpeed * KMH_TO_PXS;
    car.lf = Math.max(-reverseMax, car.lf - car.reverseAccel * dt);
  }
}

/* 5) 저항 (공기 + 구름) ------------------------------------------------------
 *  - 공기저항 : 속도² 에 비례 → 고속에서 급격히 커져 코스팅 감속이 빨라진다.
 *  - 구름저항 : 속도 에 비례 → 저속에서도 서서히 차를 멈추게 한다.
 *  엑셀을 떼도 즉시 멈추지 않고 관성으로 굴러가다 천천히 감속하는 핵심.
 *  전진/후진(부호) 양쪽 모두 0 방향으로 감속시킨다. */
function updateResistance(car, dt) {
  if (car.lf === 0) return;

  const v = Math.abs(car.lf);
  const dec = (car.airResistance * v * v + car.rollingResistance * v) * dt;
  if (car.lf > 0) car.lf = Math.max(0, car.lf - dec);
  else car.lf = Math.min(0, car.lf + dec);
}

/* 6) 그립 (측면 마찰) — 브레이크 드리프트 -----------------------------------
 *  측면 속도 성분 ll 을 매 프레임 지수적으로 감쇠시킨다.  ll *= e^(-grip · dt)
 *  - 평상시엔 grip(높음)을 유지 → 측면속도가 즉시 사라져 v 가 heading 에 빠르게
 *    정렬된다. 따라서 고속에서도 드리프트 없이 깔끔하게 회전한다.
 *  - "고속 + 브레이크(SPACE)" 일 때만 그립을 driftGrip(낮음)으로 떨어뜨려 뒤가
 *    미끄러지게 한다. 이때 조향을 같이 넣으면 슬립 앵글이 생겨 드리프트가 된다.
 *    (브레이크만 밟고 직진하면 미끄러지지 않고 그냥 감속) */
function updateGrip(car, dt) {
  const speed = speedOf(car);

  // 기본은 항상 높은 그립 → 드리프트 없음
  let lateralFriction = car.grip;
  car.drifting = false;

  // 고속에서 브레이크를 밟는 동안에만 그립을 낮춰 브레이크 드리프트 유발
  const driftSpeed = car.brakeDriftSpeed * KMH_TO_PXS;
  if (car.braking > 0 && speed > driftSpeed) {
    // 빠를수록 더 잘 미끄러지게 (driftGrip 쪽으로 강하게)
    const over = clamp((speed - driftSpeed) / (car.maxSpeed * KMH_TO_PXS - driftSpeed), 0, 1);
    lateralFriction = lerp(car.grip * 0.35, car.driftGrip, over);

    // 실제로 옆으로 미끄러지고 있을 때(측면 속도 충분)만 "드리프트 중"으로 본다.
    //  → 브레이크만 밟고 직진하면 자국/부스트 없음. 조향을 같이 넣어야 드리프트.
    if (Math.abs(car.ll) > 30) car.drifting = true;
  }

  // 지수 감쇠 (프레임레이트 독립적)
  car.ll *= Math.exp(-lateralFriction * dt);
}

/* 7) 속도/위치 계산 ----------------------------------------------------------
 *  분해·가공된 전진/측면 성분(lf, ll)을 다시 월드 속도 벡터로 합성하고,
 *  최고속도를 넘지 않도록 전진성분을 제한한 뒤 위치를 적분한다. */
function updatePhysics(car, dt) {
  // 전진 성분 캡 : 전진은 최고속도, 후진은 후진 최고속도까지 (측면 드리프트 속도는 별도)
  const vmax = car.maxSpeed * KMH_TO_PXS;
  const reverseMax = car.reverseSpeed * KMH_TO_PXS;
  car.lf = clamp(car.lf, -reverseMax, vmax);

  // local(lf, ll) → world(vx, vy) 합성
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  car.vx = car.lf * cos - car.ll * sin;
  car.vy = car.lf * sin + car.ll * cos;

  // 위치 적분
  car.x += car.vx * dt;
  car.y += car.vy * dt;
}

/* 8) 충돌 처리 — 맵 경계 ------------------------------------------------------
 *  두 모드 모두 맵 밖으로 못 나가게 차체를 벽 안쪽에 가둔다(죽음 없음). */
function updateCollision(car) {
  const half = car.length / 2;
  let hit = false;
  if (car.x < half) { car.x = half; car.vx = 0; hit = true; }
  if (car.x > world.w - half) { car.x = world.w - half; car.vx = 0; hit = true; }
  if (car.y < half) { car.y = half; car.vy = 0; hit = true; }
  if (car.y > world.h - half) { car.y = world.h - half; car.vy = 0; hit = true; }
  if (hit) decompose(car); // 벽에 흡수된 속도를 차체 성분에 반영
}

/* 9) 노면 — 레이싱 트랙 이탈 시 감속 ------------------------------------------
 *  트랙(캡슐 링) 밖(풀밭/안쪽 구멍)에서는 전진 속도를 추가로 깎아 느려지게 한다. */
function updateSurface(car, dt) {
  if (world.type !== "track") return;          // 자유/프로 레이싱 모두 적용
  if (isOnTrack(car.x, car.y)) return;
  // 풀밭 저항 : 전진/측면 속도를 지수적으로 감쇠
  const f = Math.exp(-OFFTRACK_DRAG * dt);
  car.lf *= f;
  car.ll *= f;
}

/* 점이 트랙 위에 있는지 : 중심선(폐곡선)까지의 최단 거리가 트랙 절반 폭 이내면
 *  아스팔트, 아니면 이탈(잔디). 중심선의 모든 세그먼트를 훑어 최소 거리를 구한다. */
function isOnTrack(x, y) {
  const track = world.track;
  if (!track) return true;
  const pts = track.centerline;
  const n = pts.length;
  let minD2 = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d2 = distToSegmentSq(x, y, a.x, a.y, b.x, b.y);
    if (d2 < minD2) minD2 = d2;
  }
  return minD2 <= track.halfWidth * track.halfWidth;
}

// 트랙 중심선상 위치(0~1 진행도) : 가장 가까운 세그먼트 인덱스+비율을 정규화
function trackPhase(x, y, track) {
  const pts = track.centerline, n = pts.length;
  let best = 0, bestD2 = Infinity, bestFrac = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1) : 0;
    const cx = a.x + t * dx, cy = a.y + t * dy;
    const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (d2 < bestD2) { bestD2 = d2; best = i; bestFrac = t; }
  }
  return (best + bestFrac) / n;
}

// 프로 레이싱 : 바퀴수 추적 (중간 체크포인트를 지나야 시작선 통과를 1바퀴로 인정 → 역주행 악용 방지)
function updateLap(car) {
  if (gameMode !== "pro" || race.state !== "racing") return;
  const ph = trackPhase(car.x, car.y, world.track);
  if (ph > 0.4 && ph < 0.6) race.checkpoint = true;           // 중간 통과
  if (race.checkpoint && race.lastPhase > 0.75 && ph < 0.25) { // 시작선 정방향 통과
    race.lap++;
    race.checkpoint = false;
  }
  race.lastPhase = ph;
  race.prog = race.lap + ph;
}

// 프로 그리드 슬롯 위치 (시작선 뒤쪽, 2열 스태거)
function proGridPosition(slot) {
  const s = WORLD.pro.track.start;
  const fwd = { x: Math.cos(s.angle), y: Math.sin(s.angle) };
  const right = { x: Math.cos(s.angle + Math.PI / 2), y: Math.sin(s.angle + Math.PI / 2) };
  const row = Math.floor(slot / 2), col = slot % 2;
  const back = 70 + row * 75;
  const lateral = (col === 0 ? -1 : 1) * 70;
  return {
    x: s.x - fwd.x * back + right.x * lateral,
    y: s.y - fwd.y * back + right.y * lateral,
    angle: s.angle,
  };
}

// 점(px,py)에서 선분까지의 거리 제곱 (sqrt 생략으로 빠르게)
function distToSegmentSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1) : 0;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

/* 플레이어 간 킬 판정은 서버 권위(server.js runCollisions)로 처리한다.
 *  클라이언트는 서버 통지를 따른다.
 *  - "death"  : 내가 죽었다 → 모드 선택 화면으로 복귀 (서바이벌 전용)
 *  - "killed" : 누군가 죽었다 → 그 자리에 폭발을 띄운다 (같은 모드 모두) */

// 서버가 내 사망을 통지 → 모드 선택 화면으로 (죽으면 다시 모드 선택)
function handleDeath() {
  showDeathScreen();      // 잠깐 사망 표시
  setTimeout(toMenu, 900); // 곧 모드 선택 메뉴로 복귀
}


/* =============================================================================
 *  폭발 이펙트 (사망 시) — 모든 플레이어 화면에 보인다
 * ========================================================================== */
const explosions = [];

function spawnExplosion(x, y, color) {
  const parts = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const sp = 100 + Math.random() * 300;
    parts.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.5 + Math.random() * 0.6,
      size: 2 + Math.random() * 4,
    });
  }
  explosions.push({ cx: x, cy: y, parts, color, age: 0 });
}

function updateExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.age += dt;
    let alive = e.age < 0.45; // 충격파 링이 살아있는 동안 유지
    for (const p of e.parts) {
      if (p.life > 0) {
        p.life -= dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.9; p.vy *= 0.9; // 공기저항으로 파편 감속
        alive = true;
      }
    }
    if (!alive) explosions.splice(i, 1);
  }
}

function drawExplosions() {
  const RING = 0.45;
  for (const e of explosions) {
    // 흰 충격파 링
    if (e.age < RING) {
      const t = e.age / RING;
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(e.cx, e.cy, 10 + t * 80, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 파편 (죽은 차 색)
    for (const p of e.parts) {
      if (p.life <= 0) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 0.6));
      ctx.fillStyle = e.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
}

/* 사망 화면 오버레이 제어 */
function showDeathScreen() {
  const el = document.getElementById("death");
  if (!el) return;
  el.classList.add("show");
  clearTimeout(showDeathScreen._t);
  showDeathScreen._t = setTimeout(() => el.classList.remove("show"), 1500);
}


/* =============================================================================
 *  스키드 마크 (드리프트 시 타이어 자국) — 주행감 시각 피드백
 * ========================================================================== */
// 모든 플레이어(나 + 원격)의 타이어 자국을 한 배열에 모은다. 각 점은 주인 색을 가진다.
const skidMarks = [];
const MAX_SKID = 2000;

// 임의의 차량 위치/방향/색으로 뒷바퀴 자국 두 점을 남긴다.
function pushSkid(x, y, angle, color) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rearOffset = -CAR.length * 0.35; // 뒷바퀴 위치
  const halfW = CAR.width * 0.4;
  for (const side of [-1, 1]) {
    skidMarks.push({
      x: x + cos * rearOffset - sin * halfW * side,
      y: y + sin * rearOffset + cos * halfW * side,
      color,
    });
  }
  while (skidMarks.length > MAX_SKID) skidMarks.shift();
}

// 내 차 : 드리프트 중일 때만 내 색으로 타이어 자국을 남긴다.
function updateSkid(car) {
  if (car.drifting) {
    pushSkid(car.x, car.y, car.angle, skidColorForId(net.id ?? 0));
  }
}


/* =============================================================================
 *  카메라 — 차량을 항상 화면 중앙에 두고 맵이 움직인다
 * ========================================================================== */
const camera = { x: 0, y: 0, shake: 0 };

// 화면 흔들림을 추가한다(상대를 죽였을 때 등). 값이 클수록 세게 흔들림.
function addShake(amount) {
  camera.shake = Math.min(camera.shake + amount, 45);
}

function updateCamera(car, dt) {
  camera.x = car.x - canvas.width / 2;
  camera.y = car.y - canvas.height / 2;
  // 흔들림은 시간에 따라 빠르게 잦아든다(약 0.4초)
  camera.shake *= Math.exp(-9 * dt);
  if (camera.shake < 0.3) camera.shake = 0;
}


/* =============================================================================
 *  렌더링
 * ========================================================================== */
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const minimap = document.getElementById("minimap");
const mctx = minimap.getContext("2d");
const speedEl = document.getElementById("speed");

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener("resize", resize);
resize();

function render(car) {
  // 화면 클리어
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 흔들림 오프셋 (킬 시 화면 진동)
  const sx = camera.shake ? (Math.random() * 2 - 1) * camera.shake : 0;
  const sy = camera.shake ? (Math.random() * 2 - 1) * camera.shake : 0;

  ctx.save();
  ctx.translate(-camera.x + sx, -camera.y + sy); // 월드 → 화면 변환 (+흔들림)

  drawGround();
  drawSkid();

  // 속도 불꽃 (내 차 뒤만) — 차체 아래에 깔리도록 차량보다 먼저 그린다
  drawSpeedFlame(car.x, car.y, car.angle, Math.abs(car.lf) * PXS_TO_KMH);

  // 다른 플레이어 차량 (보간된 위치)
  for (const [id, r] of remotePlayers) {
    drawCar(r, colorForId(id));
  }
  // 내 차량 (내 고유 색)
  drawCar(car, myColor());

  // 이름표 (차 아래) — 회전 영향 안 받게 차량 그린 뒤 별도로
  for (const r of remotePlayers.values()) drawName(r.name, r.x, r.y);
  drawName(playerName, car.x, car.y);

  // 폭발 이펙트 (차량 위에)
  drawExplosions();

  ctx.restore();

  drawMinimap(car);
  drawSpeed(car);
  drawRaceHud(); // 프로 레이싱 카운트다운/종료 타이머
}

/* 프로 레이싱 HUD : 화면 가운데 F1 신호등(5초) + 상단 종료 카운트다운(10초) */
function drawRaceHud() {
  if (gameMode !== "pro") return;
  const now = performance.now();
  const cx = canvas.width / 2;

  // 카운트다운 : 빨간 신호등 5개가 1초마다 하나씩 켜진다
  if (race.state === "countdown" && race.countdownEnd > now) {
    const remain = race.countdownEnd - now;
    const lit = clamp(5 - Math.floor(remain / 1000), 0, 5); // 1초마다 하나씩 차올라 5개 → 소등=출발
    const r = 26, gap = 70, y = canvas.height * 0.32;
    const startX = cx - (gap * 4) / 2;
    // 신호등 패널 배경
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(startX - 40, y - r - 22, gap * 4 + 80, r * 2 + 44, 16);
    ctx.fill();
    for (let i = 0; i < 5; i++) {
      const x = startX + i * gap;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (i < lit) {
        ctx.fillStyle = "#ff2b2b";
        ctx.shadowColor = "#ff2b2b"; ctx.shadowBlur = 24;
      } else {
        ctx.fillStyle = "#3a0d0d"; ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // 신호 꺼짐 직후 GO!
  if (race.goFlashUntil > now) {
    ctx.fillStyle = "#3be066";
    ctx.font = "800 90px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 18;
    ctx.fillText("GO!", cx, canvas.height * 0.32);
    ctx.shadowBlur = 0;
  }

  // 종료 카운트다운 (상단 가운데, 텍스트)
  if (race.state === "racing" && race.endEnd > now) {
    const sec = Math.ceil((race.endEnd - now) / 1000);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    roundRect(cx - 130, 16, 260, 46, 12); ctx.fill();
    ctx.fillStyle = "#ffd83a";
    ctx.font = "700 24px 'Segoe UI', Arial, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`종료까지 ${sec}초`, cx, 39);
  }
}

// 바닥 : 모드에 따라 오픈 맵(그리드) 또는 레이싱 트랙
function drawGround() {
  if (world.type === "track") drawRacingGround();
  else drawSurvivalGround();
}

function drawSurvivalGround() {
  const W = world.w, H = world.h;
  ctx.fillStyle = "#46504a";
  ctx.fillRect(0, 0, W, H);

  // 그리드 (위치 파악용) — 화면에 보이는 영역만 그린다
  const grid = 250;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const x0 = Math.max(0, Math.floor(camera.x / grid) * grid);
  const x1 = Math.min(W, camera.x + canvas.width);
  const y0 = Math.max(0, Math.floor(camera.y / grid) * grid);
  const y1 = Math.min(H, camera.y + canvas.height);
  for (let x = x0; x <= x1; x += grid) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = y0; y <= y1; y += grid) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();

  ctx.strokeStyle = "#d8d040";
  ctx.lineWidth = 8;
  ctx.strokeRect(0, 0, W, H);
}

// 트랙 리본(커브+아스팔트+중앙선)을 주어진 컨텍스트에 그린다.
//  중심선 Path2D 를 폭을 달리해 여러 번 stroke 해서 층층이 쌓는다.
function strokeTrack(c, opt) {
  const track = world.track;
  const p = track.path;
  const tw = track.halfWidth * 2;
  c.lineJoin = "round";
  c.lineCap = "round";

  // 1) 커브(빨강) — 트랙보다 넓게
  c.strokeStyle = "#c0392b";
  c.lineWidth = tw + 2 * track.kerb;
  c.stroke(p);
  // 2) 흰 점선을 같은 폭으로 덮어 빨강/흰 커브 무늬 (가운데는 곧 아스팔트가 덮음)
  if (opt.kerbDash) {
    c.setLineDash(opt.kerbDash);
    c.strokeStyle = "#ecf0f1";
    c.lineWidth = tw + 2 * track.kerb;
    c.stroke(p);
    c.setLineDash([]);
  }
  // 3) 아스팔트 — 트랙 폭만큼 덮어 가운데를 메우고 커브 링만 남긴다
  c.strokeStyle = "#3a3f44";
  c.lineWidth = tw;
  c.stroke(p);
  // 4) 중앙 점선
  if (opt.center) {
    c.setLineDash([50, 60]);
    c.strokeStyle = "rgba(255,255,255,0.35)";
    c.lineWidth = 4;
    c.stroke(p);
    c.setLineDash([]);
  }
}

function drawRacingGround() {
  const W = world.w, H = world.h;

  // 잔디
  ctx.fillStyle = "#4a7a44";
  ctx.fillRect(0, 0, W, H);

  // 트랙 리본
  strokeTrack(ctx, { kerbDash: [55, 55], center: true });

  // 스타트/피니시 라인 (출발점에서 진행방향에 수직으로 트랙 폭을 가로지름)
  const s = world.track.start;
  const nx = Math.cos(s.angle + Math.PI / 2), ny = Math.sin(s.angle + Math.PI / 2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(s.x - nx * world.track.halfWidth, s.y - ny * world.track.halfWidth);
  ctx.lineTo(s.x + nx * world.track.halfWidth, s.y + ny * world.track.halfWidth);
  ctx.stroke();

  // 맵 경계
  ctx.strokeStyle = "#d8d040";
  ctx.lineWidth = 8;
  ctx.strokeRect(0, 0, W, H);
}

// 차 아래에 이름표를 그린다 (회전 없이, 가독성 위해 어두운 외곽선 + 흰 글자)
function drawName(text, x, y) {
  if (!text) return;
  ctx.font = "600 14px 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const ny = y + CAR.length / 2 + 6;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, x, ny);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, ny);
}

function drawSkid() {
  for (const m of skidMarks) {
    ctx.fillStyle = m.color;
    ctx.fillRect(m.x - 2, m.y - 2, 4, 4);
  }
}

/* 속도 불꽃 : 450km/h↑ 붉은 불꽃, 500km/h↑ 하늘색 불꽃을 차 뒤에 분사한다.
 *  "lighter" 합성 + 여러 겹 + 깜빡임으로 빠르고 눈에 띄게 보이게 한다. */
function drawSpeedFlame(x, y, angle, kmh) {
  if (kmh < 450) return;
  const blue = kmh >= 500;
  const t = clamp((kmh - (blue ? 500 : 450)) / 90, 0, 1); // 강도 0~1
  const now = performance.now();
  const flick = 0.78 + 0.22 * Math.sin(now / 28) * Math.cos(now / 47); // 깜빡임
  const len = (46 + 70 * t) * flick;  // 불꽃 길이
  const halfW = CAR.width * 0.55;
  const tail = "rgba(0,0,0,0)"; // 끝은 투명

  // 색 : 바깥(어두움) → 안쪽(밝음)
  const cols = blue
    ? ["#1f7bff", "#46c8ff", "#bff0ff"]
    : ["#ff3010", "#ff7a1e", "#ffd25a"];
  const glow = blue ? "rgba(80,200,255,0.30)" : "rgba(255,90,30,0.30)";

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalCompositeOperation = "lighter"; // 빛 합성 → 글로우

  const rearX = -CAR.length / 2 + 2; // 차 뒤쪽 끝
  // 0) 둥근 글로우 (바닥에 깔리는 빛무리)
  const gr = ctx.createRadialGradient(rearX - len * 0.35, 0, 2, rearX - len * 0.35, 0, len * 0.8);
  gr.addColorStop(0, glow);
  gr.addColorStop(1, tail);
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(rearX - len * 0.35, 0, len * 0.8, 0, Math.PI * 2);
  ctx.fill();

  // 1~3) 겹겹의 불꽃 혀 (바깥 넓고 → 안쪽 좁고 밝게)
  const layers = [
    { w: halfW * 1.5, l: len,        c: cols[0], a: 0.6 },
    { w: halfW * 1.0, l: len * 0.78, c: cols[1], a: 0.75 },
    { w: halfW * 0.5, l: len * 0.5,  c: cols[2], a: 1.0 },
  ];
  for (const L of layers) {
    const g = ctx.createLinearGradient(rearX, 0, rearX - L.l, 0);
    g.addColorStop(0, L.c);
    g.addColorStop(1, tail);
    ctx.fillStyle = g;
    ctx.globalAlpha = L.a;
    ctx.beginPath();
    ctx.moveTo(rearX, -L.w);
    ctx.quadraticCurveTo(rearX - L.l * 0.55, -L.w * 0.35, rearX - L.l, 0); // 위 곡선 → 뾰족 끝
    ctx.quadraticCurveTo(rearX - L.l * 0.55, L.w * 0.35, rearX, L.w);      // 아래 곡선
    ctx.closePath();
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.restore();
}

function drawCar(car, color = "#e23b2e") {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);

  // 부활 직후 무적 상태면 깜빡이게 표시 (내 차: invulnUntil / 원격: 서버의 invuln 플래그)
  if ((car.invulnUntil && performance.now() < car.invulnUntil) || car.invuln) {
    ctx.globalAlpha = 0.4 + 0.35 * Math.abs(Math.sin(performance.now() / 90));
  }

  const L = car.length || CAR.length;
  const W = car.width || CAR.width;

  // 그림자
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(-L / 2 + 2, -W / 2 + 3, L, W);

  // 차체
  ctx.fillStyle = color;
  roundRect(-L / 2, -W / 2, L, W, 5);
  ctx.fill();

  // 앞부분(코) 표시 — 진행방향 식별
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(L / 2 - 8, -W / 2 + 2, 6, W - 4); // 앞유리
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(-L / 2 + 4, -W / 2 + 2, 6, W - 4); // 뒷유리

  // 사이드미러 한 쌍 (앞유리 옆 = 차 앞쪽) — 앞뒤를 확실히 구분 ㅋㅋ
  const mx = L / 2 - 12; // 앞유리 부근 x
  const mLen = 5;        // 미러 길이(차 길이 방향)
  const mDepth = 3.5;    // 차체 밖으로 튀어나온 깊이
  // 미러 받침(스토크) — 차체 색
  ctx.fillStyle = color;
  ctx.fillRect(mx, -W / 2 - mDepth, mLen, mDepth);       // 왼쪽
  ctx.fillRect(mx, W / 2, mLen, mDepth);                 // 오른쪽
  // 미러 유리 — 어둡게
  ctx.fillStyle = "#14181c";
  ctx.fillRect(mx + 1, -W / 2 - mDepth, mLen - 2, mDepth - 1); // 왼쪽 유리
  ctx.fillRect(mx + 1, W / 2 + 1, mLen - 2, mDepth - 1);       // 오른쪽 유리

  ctx.restore();
}

function roundRect(x, y, w, h, r, c = ctx) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawSpeed(car) {
  // 체감 속도를 km/h 정수로 표시 (후진도 크기로 표시)
  const kmh = Math.round(Math.abs(car.lf) * PXS_TO_KMH);
  speedEl.textContent = kmh;
}

// 미니맵 : 맵 전체 + 차량 위치 + 차량 방향 (월드가 비정사각형이어도 비율 유지)
function drawMinimap(car) {
  const size = minimap.width;
  const scale = Math.min(size / world.w, size / world.h); // 박스에 맞춰 축소
  const ox = (size - world.w * scale) / 2;                // 가운데 정렬 오프셋
  const oy = (size - world.h * scale) / 2;
  const wx = (x) => ox + x * scale;                       // 월드 x → 미니맵 x
  const wy = (y) => oy + y * scale;

  mctx.clearRect(0, 0, size, size);

  // 월드 영역 바닥
  mctx.fillStyle = "rgba(40,45,42,0.9)";
  mctx.fillRect(ox, oy, world.w * scale, world.h * scale);

  // 레이싱 트랙 (중심선을 굵게 stroke → 미니맵 트랙 모양) + 시작선
  if (world.type === "track" && world.track) {
    const track = world.track;
    mctx.save();
    mctx.translate(ox, oy);
    mctx.scale(scale, scale);
    mctx.lineJoin = "round";
    mctx.lineCap = "round";
    mctx.strokeStyle = "#7a8a76";
    mctx.lineWidth = track.halfWidth * 2 + 2 * track.kerb;
    mctx.stroke(track.path);
    mctx.strokeStyle = "#566";
    mctx.lineWidth = track.halfWidth * 2;
    mctx.stroke(track.path);
    // 시작선 (흰색, 트랙 폭을 가로지름)
    const s = track.start;
    const nx = Math.cos(s.angle + Math.PI / 2), ny = Math.sin(s.angle + Math.PI / 2);
    mctx.strokeStyle = "#ffffff";
    mctx.lineWidth = Math.max(track.halfWidth * 0.5, 60);
    mctx.beginPath();
    mctx.moveTo(s.x - nx * track.halfWidth, s.y - ny * track.halfWidth);
    mctx.lineTo(s.x + nx * track.halfWidth, s.y + ny * track.halfWidth);
    mctx.stroke();
    mctx.restore();
  }

  // 현재 화면(뷰포트) 영역 표시
  mctx.strokeStyle = "rgba(255,255,255,0.4)";
  mctx.lineWidth = 1;
  mctx.strokeRect(wx(camera.x), wy(camera.y), canvas.width * scale, canvas.height * scale);

  // 다른 플레이어 (작은 점)
  for (const [id, r] of remotePlayers) {
    mctx.fillStyle = colorForId(id);
    mctx.beginPath();
    mctx.arc(wx(r.x), wy(r.y), 3, 0, Math.PI * 2);
    mctx.fill();
  }

  // 내 차량 위치 + 방향(삼각형)
  mctx.save();
  mctx.translate(wx(car.x), wy(car.y));
  mctx.rotate(car.angle);
  mctx.fillStyle = myColor();
  mctx.beginPath();
  mctx.moveTo(7, 0);    // 앞쪽 꼭지점
  mctx.lineTo(-5, -4);
  mctx.lineTo(-5, 4);
  mctx.closePath();
  mctx.fill();
  mctx.restore();
}


/* =============================================================================
 *  멀티플레이어 (WebSocket 클라이언트)
 * -----------------------------------------------------------------------------
 *  - 자기 차량 상태(x, y, angle)를 30Hz 로 서버에 전송한다.
 *  - 서버가 보내주는 전체 스냅샷으로 다른 플레이어 차량을 갱신한다.
 *  - 다른 차량은 네트워크 지연/저속 전송으로 끊겨 보이므로 매 프레임
 *    목표 위치로 보간(interpolation)하여 부드럽게 렌더한다.
 *  - 서버가 없어도(정적 파일로 열어도) 게임은 1인 모드로 정상 동작한다.
 * ========================================================================== */
const net = {
  ws: null,
  id: null,             // 서버가 부여한 내 플레이어 id
  connected: false,
  sendInterval: 1000 / 60, // 내 상태 송신율 (서버 TICK_RATE 와 맞춤)
  lastSend: 0,
  pendingTeleport: false, // true면 다음 상태 송신에 teleport 플래그를 실어 보낸다
  hasServerTime: false,   // 서버가 스냅샷에 st(송신시각)를 넣어주는지 (재배포 여부)
  serverNewest: 0,        // 가장 최근에 받은 서버 타임스탬프(st)
  playT: null,            // 원격 보간용 재생 시계(서버시간 도메인, INTERP_DELAY 만큼 과거)
};

// 다른 플레이어 : id -> { x, y, angle (렌더값), tx, ty, tangle (목표값), drifting }
const remotePlayers = new Map();

// 플레이어 id 로부터 "고유 색"을 결정적으로 생성한다.
//  - id 만으로 색이 정해지므로 모든 클라이언트가 같은 플레이어를 같은 색으로 본다
//    → "난 파란 차야" 처럼 색으로 서로를 부르며 소통할 수 있다.
//  - 황금각(137.508°)으로 hue 를 분산시켜 인원이 늘어도 색이 잘 겹치지 않는다.
function hueForId(id) {
  return ((id || 0) * 137.508) % 360;
}
function colorForId(id) {
  return `hsl(${hueForId(id)}, 72%, 55%)`;
}
// 타이어 자국용 색 (어둡고 반투명한 같은 계열)
function skidColorForId(id) {
  return `hsla(${hueForId(id)}, 55%, 30%, 0.5)`;
}
// 내 차 색 (서버가 id 를 줄 때까지는 id 0 기준 색)
function myColor() {
  return colorForId(net.id ?? 0);
}

function connect() {
  // 같은 호스트의 ws 엔드포인트로 접속 (node server.js 가 서빙)
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    net.ws = new WebSocket(`${proto}//${location.host}`);
  } catch {
    return; // file:// 등으로 열면 접속 실패 → 1인 모드
  }

  net.ws.onopen = () => {
    net.connected = true;
    // 재접속 시, 플레이 중이었다면 같은 모드로 자동 재입장
    if (gameState === "playing") sendJoin();
  };

  net.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "welcome") {
      net.id = msg.id;
    } else if (msg.type === "counts") {
      // 모드별 참가 인원 → 메뉴 버튼 배지 갱신
      const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = `${n}명`; };
      set("countSurvival", msg.survival || 0);
      set("countRacing", msg.racing || 0);
      set("countPro", msg.pro || 0);
    } else if (msg.type === "spawn") {
      // 서버가 정한 입장/부활 위치 → 거기서 시작
      CAR.x = msg.x; CAR.y = msg.y; CAR.angle = msg.angle;
      CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
      CAR.invulnUntil = performance.now() + 1500;
      net.pendingTeleport = true; // 남들 화면에서 슬라이드 없이 스냅되도록
    } else if (msg.type === "death") {
      // 서버 판정: 내가 죽었다 → 모드 선택 화면으로 복귀
      handleDeath();
    } else if (msg.type === "killed") {
      // 서버 통지: 누군가 죽었다 → 그 자리에서 그 차 색으로 폭발
      const color = msg.victimId === net.id ? myColor() : colorForId(msg.victimId);
      spawnExplosion(msg.x, msg.y, color);
      // 내가 죽인 경우 내 화면을 흔든다 (타격감)
      if (msg.killerId === net.id) addShake(34);
    } else if (msg.type === "chat") {
      // 채팅 수신 → 로그에 추가 (이름은 보낸 사람 색)
      addChatLine(msg.name, msg.text, colorForId(msg.id), msg.t);
    } else if (msg.type === "proStart") {
      // 프로 입장 승인 → 트랙 적용 후 내 그리드 슬롯에 배치
      race.slot = msg.slot;
      race.laps = msg.laps || 3;
      if (typeof msg.trackIndex === "number") WORLD.pro.track = buildProTrack(msg.trackIndex);
      const g = proGridPosition(msg.slot);
      CAR.x = g.x; CAR.y = g.y; CAR.angle = g.angle;
      CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
      net.pendingTeleport = true;
      updateCamera(CAR, 0);
    } else if (msg.type === "joinReject") {
      // 정원 초과/진행 중 → 메뉴로 복귀하며 사유 표시
      gameMode = "survival"; race.state = "none";
      toMenu();
      alert(msg.reason || "입장할 수 없습니다.");
    } else if (msg.type === "race") {
      handleRaceMessage(msg);
    } else if (msg.type === "toFreeRacing") {
      // 프로 레이스 종료 → 모두 자유 레이싱으로 이동
      race.state = "none";
      enterFreeRacingFromPro();
    } else if (msg.type === "snapshot") {
      // 서버가 송신 시각(st)을 주면 그걸로 보간한다. 안 주면(재배포 전) 기존
      // 지수 스무딩으로 폴백하므로 손해는 없다.
      const hasSt = typeof msg.st === "number";
      if (hasSt) {
        net.hasServerTime = true;
        if (msg.st > net.serverNewest) net.serverNewest = msg.st;
      }
      const st = hasSt ? msg.st : performance.now();
      const seen = new Set();
      for (const p of msg.players) {
        if (p.id === net.id) continue; // 내 차는 로컬 물리로 그린다
        seen.add(p.id);
        let r = remotePlayers.get(p.id);
        if (!r) {
          // 처음 본 플레이어
          r = { buffer: [], x: p.x, y: p.y, angle: p.angle, drifting: false };
          remotePlayers.set(p.id, r);
        }
        r.invuln = p.invuln;
        r.name = p.name;

        // 스냅샷을 "서버 송신 시각(st)"과 함께 버퍼에 쌓는다 (엔티티 보간용)
        if (p.teleport) {
          // 텔레포트(부활 등) → 버퍼 리셋 + 즉시 스냅 (보간으로 맵 가로지르는 것 방지)
          r.buffer = [{ t: st, x: p.x, y: p.y, angle: p.angle, drifting: p.drifting }];
          r.x = p.x; r.y = p.y; r.angle = p.angle; r.drifting = p.drifting;
        } else {
          r.buffer.push({ t: st, x: p.x, y: p.y, angle: p.angle, drifting: p.drifting });
          if (r.buffer.length > 40) r.buffer.shift(); // 버퍼 상한
        }
      }
      // 스냅샷에 없는 = 떠난 플레이어 제거
      for (const id of remotePlayers.keys()) {
        if (!seen.has(id)) remotePlayers.delete(id);
      }
    }
  };

  net.ws.onclose = () => {
    net.connected = false;
    remotePlayers.clear();
    setTimeout(connect, 1500); // 자동 재접속
  };

  net.ws.onerror = () => { net.ws.close(); };
}

// 모드 선택 → 서버에 입장 요청 (이름/모드 전달)
function sendJoin() {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify({ type: "join", mode: gameMode, name: playerName }));
}
// 메뉴 복귀 → 서버에 퇴장 통지
function sendLeave() {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify({ type: "leave" }));
}
// 준비 토글 전송
function sendReady(value) {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify({ type: "ready", value }));
}

/* =============================================================================
 *  프로 레이싱 — 서버 'race' 메시지 처리 + 로비/순위 UI
 * ========================================================================== */
function handleRaceMessage(msg) {
  // 프로 트랙 동기화 (로비 진입자/재동기화 대비)
  if (typeof msg.trackIndex === "number") WORLD.pro.track = buildProTrack(msg.trackIndex);
  const prevState = race.state;
  race.state = msg.state;
  race.laps = msg.laps || race.laps;
  race.list = msg.players || [];
  race.canReady = !!msg.canReady;

  // 내 ready 상태를 서버 목록에서 동기화
  const me = race.list.find((p) => p.id === net.id);
  if (me) race.myReady = !!me.ready;

  // 타이머는 로컬 시계로 환산해 매끄럽게 표시
  race.countdownEnd = msg.countdownMs > 0 ? performance.now() + msg.countdownMs : 0;
  race.endEnd = msg.endMs > 0 ? performance.now() + msg.endMs : 0;

  // 카운트다운 → 레이싱 전환 시 : 바퀴 추적 초기화 + GO 표시
  if (prevState !== "racing" && race.state === "racing") {
    race.lap = 0; race.prog = 0; race.checkpoint = false;
    race.lastPhase = trackPhase(CAR.x, CAR.y, world.track);
    race.goFlashUntil = performance.now() + 1200;
  }
  updateRaceUI();
}

// 프로 종료 → 자유 레이싱으로 자연스럽게 입장
function enterFreeRacingFromPro() {
  gameMode = "racing";
  world = WORLD.racing;
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  const s = world.track.start;
  CAR.x = s.x; CAR.y = s.y; CAR.angle = s.angle;
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
  net.pendingTeleport = true;
  updateCamera(CAR, 0);
  updateRaceUI();    // 로비/순위판 숨김
  sendJoin();        // racing 으로 재입장
}

// 로비 패널 + 순위판 DOM 갱신
function updateRaceUI() {
  const lobby = document.getElementById("lobby");
  const standings = document.getElementById("standings");
  const inPro = gameMode === "pro" && race.state !== "none";

  // 로비는 lobby 상태에서만
  lobby.classList.toggle("show", gameMode === "pro" && race.state === "lobby");
  standings.style.display = inPro ? "block" : "none";

  // 로비 플레이어 목록
  const lobbyList = document.getElementById("lobbyList");
  lobbyList.innerHTML = "";
  for (const p of race.list) {
    const row = document.createElement("div");
    row.className = "lobby-row";
    const dot = document.createElement("span");
    dot.className = "lobby-dot";
    dot.style.background = colorForId(p.id);
    const nm = document.createElement("span");
    nm.className = "lobby-name";
    nm.textContent = p.name + (p.id === net.id ? " (나)" : "");
    const st = document.createElement("span");
    st.className = "lobby-ready " + (p.ready ? "on" : "off");
    st.textContent = p.ready ? "준비완료" : "대기중";
    row.append(dot, nm, st);
    lobbyList.appendChild(row);
  }

  // 준비 버튼
  const btn = document.getElementById("readyBtn");
  btn.disabled = !race.canReady;
  btn.textContent = race.myReady ? "준비 취소" : "준비";
  btn.classList.toggle("ready", race.myReady);
  document.getElementById("lobbyHint").textContent =
    race.canReady ? "모두 준비하면 자동으로 시작됩니다" : "2명 이상 모이면 시작할 수 있어요";

  // 순위판
  const sList = document.getElementById("standingsList");
  sList.innerHTML = "";
  for (const p of race.list) {
    const row = document.createElement("div");
    row.className = "stand-row";
    const rank = document.createElement("span");
    rank.className = "stand-rank";
    rank.textContent = p.rank + ".";
    const star = document.createElement("span");
    star.className = "stand-star";
    if (p.finished) { star.textContent = "★"; star.style.color = colorForId(p.id); }
    const nm = document.createElement("span");
    nm.className = "stand-name";
    nm.style.color = colorForId(p.id);
    nm.textContent = p.name;
    const lap = document.createElement("span");
    lap.className = "stand-lap";
    lap.textContent = p.finished ? "완주" : `${p.lap}/${race.laps}`;
    row.append(rank, star, nm, lap);
    sList.appendChild(row);
  }
}

/* =============================================================================
 *  채팅 (미니맵 하단)
 * ========================================================================== */
const MAX_CHAT_LINES = 80;

// 입력창 내용을 서버로 전송
// 현재 표시 이름 : 플레이 중이면 확정 이름, 메뉴/로비에선 입력창 값
function currentName() {
  if (gameState === "playing") return playerName;
  const v = (document.getElementById("nameInput").value || "").trim().slice(0, 12);
  return v || "Player";
}

function sendChat() {
  const input = document.getElementById("chatInput");
  const text = (input.value || "").trim();
  if (!text) return;
  // 메뉴/로비/플레이 어디서든 전송 (미입장 상태면 이름을 함께 보냄)
  if (net.connected && net.ws.readyState === WebSocket.OPEN) {
    net.ws.send(JSON.stringify({ type: "chat", text, name: currentName() }));
  }
  input.value = "";
}

// 시간 H:i (24시간 HH:MM)
function fmtTime(t) {
  const d = new Date(t || Date.now());
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// 채팅 로그에 한 줄 추가 (textContent 로만 넣어 HTML 주입 방지)
function addChatLine(name, text, color, t) {
  const log = document.getElementById("chatLog");
  const wasBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;

  const line = document.createElement("div");
  line.className = "chat-msg";

  const timeEl = document.createElement("span");
  timeEl.className = "chat-time";
  timeEl.textContent = fmtTime(t);

  const nameEl = document.createElement("span");
  nameEl.className = "chat-name";
  nameEl.style.color = color || "#fff";
  nameEl.textContent = name + ":";

  const textEl = document.createElement("span");
  textEl.className = "chat-text";
  textEl.textContent = text;

  line.append(timeEl, nameEl, document.createTextNode(" "), textEl);
  log.appendChild(line);

  // 오래된 줄 정리
  while (log.children.length > MAX_CHAT_LINES) log.removeChild(log.firstChild);

  // 사용자가 맨 아래를 보고 있었으면 자동 스크롤
  if (wasBottom) log.scrollTop = log.scrollHeight;
}

// 채팅 UI 배선 (전송 버튼 + Enter)
function setupChat() {
  document.getElementById("chatSend").addEventListener("click", () => {
    sendChat();
    document.getElementById("chatInput").focus(); // 버튼 클릭 후 계속 입력 가능
  });
  document.getElementById("chatInput").addEventListener("keyup", (e) => {
    if (e.key !== "Enter") return;
    // 채팅창을 연(포커스한) Enter 의 keyup 이면 전송하지 않고 무시 → 포커스 유지
    if (chatFocusGuard) { chatFocusGuard = false; return; }
    e.preventDefault();
    sendChat();
    e.target.blur(); // Enter 로 보내면 입력창에서 빠져나와 운전 복귀
  });
}

// 내 차 상태를 주기적으로 서버에 전송
function netSend(car, now) {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  if (now - net.lastSend < net.sendInterval) return;
  net.lastSend = now;

  const msg = {
    type: "state",
    x: Math.round(car.x), y: Math.round(car.y),
    angle: +car.angle.toFixed(3),
    drifting: car.drifting, // 드리프트 중일 때만 → 남들 화면에도 그때만 자국
  };
  // 막 텔레포트(벽/플레이어 리스폰)했으면 서버·남들에게 스냅하라고 알린다
  if (net.pendingTeleport) { msg.teleport = true; net.pendingTeleport = false; }
  // 프로 레이싱 중이면 바퀴수/진행도 보고 (서버가 순위·완주 판정)
  if (gameMode === "pro" && race.state === "racing") {
    msg.lap = race.lap;
    msg.prog = +race.prog.toFixed(3);
  }
  net.ws.send(JSON.stringify(msg));
}

// 렌더를 서버 시각보다 이만큼 과거로 늦춰(재생 시계), 그 사이 도착한 스냅샷을
// 확보해두고 "서버 송신 시각(일정 간격)" 기준으로 두 스냅샷을 보간한다.
// → 도착 지터/버스트가 있어도 일정 속도로 매끈하게 움직인다.
const INTERP_DELAY = 90; // ms (60Hz면 스냅샷 ~5개분 버퍼 → 지연 줄이면서도 안전)

// 원격 차량 : 서버 타임스탬프 기반 엔티티 보간 (Source 엔진식).
//  서버가 st 를 주지 않으면(재배포 전) 기존 지수 스무딩으로 폴백한다.
function updateRemotes(dt) {
  if (!net.hasServerTime) { updateRemotesFallback(); return; }
  if (net.serverNewest === 0) return; // 아직 스냅샷 없음

  // 재생 시계 : 실시간으로 전진시키되(등속 보장), (서버최신 - INTERP_DELAY)로 부드럽게 수렴
  const target = net.serverNewest - INTERP_DELAY;
  if (net.playT === null) net.playT = target;
  else {
    net.playT += dt * 1000;
    net.playT += (target - net.playT) * clamp(dt * 2.5, 0, 1); // 드리프트 보정
    if (net.playT > net.serverNewest) net.playT = net.serverNewest;      // 데이터보다 앞서지 않게
    if (net.serverNewest - net.playT > INTERP_DELAY + 400) net.playT = target; // 너무 뒤처지면 리싱크
  }
  const renderT = net.playT;

  for (const [id, r] of remotePlayers) {
    const buf = r.buffer;

    // 이미 지나간(소비된) 오래된 샘플 정리 — renderT 이전 샘플은 1개만 남긴다
    while (buf.length >= 2 && buf[1].t <= renderT) buf.shift();

    if (buf.length === 0) continue;

    if (buf.length === 1 || renderT <= buf[0].t) {
      // 보간할 두 점이 없으면(막 입장/패킷 부족) 가장 이른 샘플을 그대로 사용
      const s = buf[0];
      r.x = s.x; r.y = s.y; r.angle = s.angle; r.drifting = s.drifting;
    } else {
      // buf[0].t <= renderT < buf[1].t 사이를 선형 보간
      const a = buf[0], b = buf[1];
      const span = b.t - a.t;
      const t = clamp(span > 0 ? (renderT - a.t) / span : 1, 0, 1);
      r.x = lerp(a.x, b.x, t);
      r.y = lerp(a.y, b.y, t);
      // 각도는 -π~π 경계를 고려해 최단 경로로
      let d = b.angle - a.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      r.angle = a.angle + d * t;
      r.drifting = a.drifting; // 진행 중인 구간의 드리프트 상태
    }

    // 드리프트 중인 원격 차량의 타이어 자국도 그 차 색으로 남긴다
    if (r.drifting) pushSkid(r.x, r.y, r.angle, skidColorForId(id));
  }
}

// 폴백(서버가 st 미제공 = 재배포 전) : 기존 지수 스무딩. 최신 스냅샷으로 수렴.
function updateRemotesFallback() {
  for (const [id, r] of remotePlayers) {
    const buf = r.buffer;
    if (!buf.length) continue;
    const tgt = buf[buf.length - 1]; // 가장 최근 스냅샷
    r.x = lerp(r.x, tgt.x, 0.25);
    r.y = lerp(r.y, tgt.y, 0.25);
    let d = tgt.angle - r.angle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    r.angle += d * 0.25;
    r.drifting = tgt.drifting;
    if (r.drifting) pushSkid(r.x, r.y, r.angle, skidColorForId(id));
  }
}

connect();

// 탭을 닫거나 떠날 때 연결을 즉시 끊어 서버 인원수에 유령으로 남지 않게 한다.
window.addEventListener("pagehide", () => {
  try { if (net.ws && net.ws.readyState === WebSocket.OPEN) net.ws.close(); } catch {}
});


/* =============================================================================
 *  메인 루프
 * ========================================================================== */
let lastTime = performance.now();

function frame(now) {
  // 프레임 간 실제 경과시간(dt). 폭발 방지를 위해 상한 클램프.
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, CONFIG.MAX_DT);

  // 메뉴 화면(미입장)에선 물리/네트워크를 멈춘다 (메뉴 오버레이가 화면을 덮음)
  if (gameState !== "playing") {
    requestAnimationFrame(frame);
    return;
  }

  // ----- 물리 파이프라인 (역할 분리) -----
  updateInput(CAR, dt);       // 입력
  updateSteering(CAR, dt);    // 조향 (heading 회전)
  decompose(CAR);             // 속도 → 전진/측면 분해 (슬립 앵글 발생)
  updateEngine(CAR, dt);      // 엔진 가속
  updateBrake(CAR, dt);       // 브레이크
  updateReverse(CAR, dt);     // 후진 (S)
  updateResistance(CAR, dt);  // 공기/구름 저항
  updateSurface(CAR, dt);     // 노면(레이싱 트랙 이탈 시 감속)
  updateGrip(CAR, dt);        // 그립 (측면 마찰) → 드리프트
  updatePhysics(CAR, dt);     // 속도/위치 합성·적분
  updateCollision(CAR);       // 맵 경계 충돌
  updateLap(CAR);             // 프로 레이싱 바퀴 추적
  updateSkid(CAR);            // 스키드 마크
  updateCamera(CAR, dt);      // 카메라 추적 (+ 흔들림 감쇠)

  // ----- 네트워크 -----
  netSend(CAR, now);          // 내 상태 송신
  updateRemotes(dt);          // 원격 차량 보간 (서버 타임스탬프 기반)
  updateExplosions(dt);       // 폭발 이펙트 갱신 (킬 판정은 서버가 통지)

  render(CAR);                // 렌더

  requestAnimationFrame(frame);
}

/* =============================================================================
 *  모드 선택 / 메뉴 전환
 * ========================================================================== */
function startGame(mode) {
  gameMode = mode;
  world = WORLD[mode];

  // 이름 확정 + 저장
  const input = document.getElementById("nameInput");
  playerName = (input.value || "").trim().slice(0, 12) || "Player";

  try { localStorage.setItem("carGameName", playerName); } catch {}

  // 상태 초기화
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  camera.shake = 0;
  // 채팅 로그는 비우지 않는다 → 나갔다 다시 들어와도 이전 대화가 보인다
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
  keys.w = keys.a = keys.s = keys.d = keys.space = false; // 메뉴 조작으로 눌린 키 초기화

  // 레이싱 위치 결정
  //  - racing(자유) : 트랙 출발점에서 시작 (서버 spawn 없음)
  //  - pro         : 로비 진입. 서버 proStart 가 그리드 슬롯을 정해줌.
  //  - survival    : 서버가 spawn 으로 위치 통지.
  race.state = "none"; race.myReady = false;
  if (mode === "racing") {
    const s = world.track.start;
    CAR.x = s.x; CAR.y = s.y; CAR.angle = s.angle;
    CAR.invulnUntil = performance.now() + 1500;
    net.pendingTeleport = true;
    updateCamera(CAR, 0);
  } else if (mode === "pro") {
    race.state = "lobby"; // proStart/race 메시지로 곧 갱신됨
  }

  gameState = "playing";
  document.getElementById("menu").classList.remove("show");
  document.getElementById("exitBtn").style.display = "block";
  updateRaceUI();

  sendJoin(); // 서버에 입장
}

function toMenu() {
  if (gameState === "menu") return;
  gameState = "menu";
  sendLeave();
  gameMode = "survival";
  race.state = "none";
  remotePlayers.clear();
  skidMarks.length = 0;
  document.getElementById("exitBtn").style.display = "none";
  document.getElementById("death").classList.remove("show");
  document.getElementById("menu").classList.add("show");
  updateRaceUI(); // 로비/순위판 숨김
}

// 메뉴 UI 배선
function setupMenu() {
  const input = document.getElementById("nameInput");
  // 저장된 이름 자동완성
  try { input.value = localStorage.getItem("carGameName") || ""; } catch {}

  document.getElementById("btnSurvival").addEventListener("click", () => startGame("survival"));
  document.getElementById("btnRacing").addEventListener("click", () => startGame("racing"));
  document.getElementById("btnPro").addEventListener("click", () => startGame("pro"));
  document.getElementById("exitBtn").addEventListener("click", toMenu);

  // 프로 로비 준비 버튼
  document.getElementById("readyBtn").addEventListener("click", () => {
    race.myReady = !race.myReady;
    sendReady(race.myReady);
    updateRaceUI();
  });
  // 로비 나가기
  document.getElementById("lobbyLeave").addEventListener("click", toMenu);

  document.getElementById("menu").classList.add("show"); // 시작은 메뉴
}

init();
setupMenu();
setupChat();
requestAnimationFrame(frame);
