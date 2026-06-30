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
  racing: { w: 10000, h: 6000, type: "track" },
};

// 현재 모드/월드/게임 상태
let gameMode = "survival";   // "survival" | "racing"
let world = WORLD.survival;  // 현재 월드 치수/타입
let gameState = "menu";      // "menu" | "playing"
let playerName = "Player";

const OFFTRACK_DRAG = 2.4;   // 트랙 이탈 시 추가 감속 계수 (클수록 풀밭처럼 느려짐)

/* 레이싱 트랙(카트 서킷) ------------------------------------------------------
 *  중심선을 "별모양 보장(자기교차 없음)" 극좌표식 폐곡선으로 생성한다.
 *      point(θ) = center + ( R(θ)·cosθ , R(θ)·sinθ ),  R(θ) > 0
 *  여러 주파수의 사인을 더해 코너가 많은 굽이진 서킷을 만든다. R 이 항상
 *  양수라 중심에서 별모양이라 절대 자기 자신과 교차하지 않는다.
 *  생성 후 bbox 를 월드(트랙 폭 여백 포함)에 자동으로 맞춰 스케일/이동한다. */
const TRACK = {
  halfWidth: 230,     // 트랙 절반 폭 (전체 폭 460px)
  kerb: 26,           // 빨강/흰 커브 폭
  centerline: [],     // 월드 좌표 중심선 점들 (닫힌 루프)
  path: null,         // 렌더용 캐시 Path2D (중심선)
  start: { x: 0, y: 0, angle: 0 }, // 출발 위치/방향
};

// 트랙 중심선을 생성한다 (init 에서 1회 호출). world.racing 치수에 맞춰 자동 피팅.
function generateTrack() {
  const N = 260; // 중심선 해상도
  // 1) 단위 극좌표 곡선 샘플 (여러 하모닉 → 굽이진 서킷)
  const raw = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const R = 1
      + 0.16 * Math.sin(2 * a + 0.6)
      + 0.30 * Math.sin(3 * a + 0.4)
      + 0.18 * Math.sin(5 * a + 1.3)
      + 0.10 * Math.sin(7 * a + 0.2);
    raw.push({ x: Math.cos(a) * R * 1.7, y: Math.sin(a) * R }); // x 를 늘려 가로로 길게
  }
  // 2) bbox 계산
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  // 3) 월드(트랙 폭 + 여백 만큼 안쪽) 에 맞춰 스케일/이동
  const W = WORLD.racing.w, H = WORLD.racing.h;
  const inset = TRACK.halfWidth + TRACK.kerb + 120;
  const scale = Math.min((W - 2 * inset) / (maxX - minX), (H - 2 * inset) / (maxY - minY));
  const offX = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (H - (maxY - minY) * scale) / 2 - minY * scale;

  TRACK.centerline = raw.map(p => ({ x: p.x * scale + offX, y: p.y * scale + offY }));

  // 4) 렌더용 Path2D (닫힌 루프)
  const path = new Path2D();
  TRACK.centerline.forEach((p, i) => i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y));
  path.closePath();
  TRACK.path = path;

  // 5) 출발 위치/방향 = 중심선 0번 점, 다음 점 방향
  const a0 = TRACK.centerline[0], a1 = TRACK.centerline[1];
  TRACK.start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
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
  maxSpeed: 320,          // 최고속도 (km/h) — 이 값을 절대 넘지 않음
  acceleration: 165,      // 트랙션 한계 가속도 (px/s²) — 출발 시 최대 가속(접지력 한계)
  brakePower: 230,        // 브레이크 감속도 (px/s²) — 강력하지만 즉시정지 X (ABS 느낌)

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
  steerInput: 0,           // -1(좌) ~ +1(우), 부드럽게 램프됨

  drifting: false,         // 현재 브레이크 드리프트 중인지 (자국/조향/네트워크 공통 기준)
  invulnUntil: 0,          // 이 시각(performance.now ms)까지 무적 — 부활 직후 보호
};


/* =============================================================================
 *  입력 처리
 * ========================================================================== */
const keys = { w: false, a: false, d: false, space: false };

// 텍스트 입력(이름창)에 포커스가 있거나 메뉴 화면이면 게임 키 입력을 무시한다.
function typingInInput() {
  const el = document.activeElement;
  return el && el.tagName === "INPUT";
}

window.addEventListener("keydown", (e) => {
  if (typingInInput()) return; // 이름 입력 중엔 WASD/Space 가로채지 않음
  switch (e.code) {
    case "KeyW": keys.w = true; break;
    case "KeyA": keys.a = true; break;
    case "KeyD": keys.d = true; break;
    case "Space": keys.space = true; e.preventDefault(); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW": keys.w = false; break;
    case "KeyA": keys.a = false; break;
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

  generateTrack(); // 레이싱 트랙 중심선/경로 생성
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
  car.throttle = keys.w ? 1 : 0;
  car.braking = keys.space ? 1 : 0;

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

/* 5) 저항 (공기 + 구름) ------------------------------------------------------
 *  - 공기저항 : 속도² 에 비례 → 고속에서 급격히 커져 코스팅 감속이 빨라진다.
 *  - 구름저항 : 속도 에 비례 → 저속에서도 서서히 차를 멈추게 한다.
 *  엑셀을 떼도 즉시 멈추지 않고 관성으로 굴러가다 천천히 감속하는 핵심. */
function updateResistance(car, dt) {
  if (car.lf <= 0) return;

  const drag = car.airResistance * car.lf * car.lf; // 공기저항
  const roll = car.rollingResistance * car.lf;      // 구름저항
  car.lf = Math.max(0, car.lf - (drag + roll) * dt);
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
  // 전진 성분에 최고속도 캡 적용 (측면 드리프트 속도는 별도)
  const vmax = car.maxSpeed * KMH_TO_PXS;
  car.lf = clamp(car.lf, 0, vmax);

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
  if (gameMode !== "racing") return;
  if (isOnTrack(car.x, car.y)) return;
  // 풀밭 저항 : 전진/측면 속도를 지수적으로 감쇠
  const f = Math.exp(-OFFTRACK_DRAG * dt);
  car.lf *= f;
  car.ll *= f;
}

/* 점이 트랙 위에 있는지 : 중심선(폐곡선)까지의 최단 거리가 트랙 절반 폭 이내면
 *  아스팔트, 아니면 이탈(잔디). 중심선의 모든 세그먼트를 훑어 최소 거리를 구한다. */
function isOnTrack(x, y) {
  const pts = TRACK.centerline;
  const n = pts.length;
  let minD2 = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d2 = distToSegmentSq(x, y, a.x, a.y, b.x, b.y);
    if (d2 < minD2) minD2 = d2;
  }
  return minD2 <= TRACK.halfWidth * TRACK.halfWidth;
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
  const p = TRACK.path;
  const tw = TRACK.halfWidth * 2;
  c.lineJoin = "round";
  c.lineCap = "round";

  // 1) 커브(빨강) — 트랙보다 넓게
  c.strokeStyle = "#c0392b";
  c.lineWidth = tw + 2 * TRACK.kerb;
  c.stroke(p);
  // 2) 흰 점선을 같은 폭으로 덮어 빨강/흰 커브 무늬 (가운데는 곧 아스팔트가 덮음)
  if (opt.kerbDash) {
    c.setLineDash(opt.kerbDash);
    c.strokeStyle = "#ecf0f1";
    c.lineWidth = tw + 2 * TRACK.kerb;
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
  const s = TRACK.start;
  const nx = Math.cos(s.angle + Math.PI / 2), ny = Math.sin(s.angle + Math.PI / 2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(s.x - nx * TRACK.halfWidth, s.y - ny * TRACK.halfWidth);
  ctx.lineTo(s.x + nx * TRACK.halfWidth, s.y + ny * TRACK.halfWidth);
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
  // 전진 속도(체감 속도)를 km/h 정수로 표시
  const kmh = Math.round(Math.max(0, car.lf) * PXS_TO_KMH);
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

  // 레이싱 트랙 (중심선을 굵게 stroke → 미니맵 트랙 모양)
  if (world.type === "track" && TRACK.path) {
    mctx.save();
    mctx.translate(ox, oy);
    mctx.scale(scale, scale);
    mctx.lineJoin = "round";
    mctx.lineCap = "round";
    mctx.strokeStyle = "#7a8a76";
    mctx.lineWidth = TRACK.halfWidth * 2 + 2 * TRACK.kerb;
    mctx.stroke(TRACK.path);
    mctx.strokeStyle = "#566";
    mctx.lineWidth = TRACK.halfWidth * 2;
    mctx.stroke(TRACK.path);
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
  sendInterval: 1000 / 30,
  lastSend: 0,
  pendingTeleport: false, // true면 다음 상태 송신에 teleport 플래그를 실어 보낸다
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
    } else if (msg.type === "snapshot") {
      const seen = new Set();
      for (const p of msg.players) {
        if (p.id === net.id) continue; // 내 차는 로컬 물리로 그린다
        seen.add(p.id);
        let r = remotePlayers.get(p.id);
        if (!r) {
          // 처음 본 플레이어 : 목표 위치에서 바로 시작
          r = { x: p.x, y: p.y, angle: p.angle };
          remotePlayers.set(p.id, r);
        }
        r.tx = p.x; r.ty = p.y; r.tangle = p.angle;
        r.drifting = p.drifting;
        r.invuln = p.invuln;
        r.name = p.name;
        // 텔레포트(부활 등) 신호면 보간하지 말고 즉시 스냅 → 맵 가로지르는 슬라이드 방지
        if (p.teleport) { r.x = p.x; r.y = p.y; r.angle = p.angle; }
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

/* =============================================================================
 *  채팅 (미니맵 하단)
 * ========================================================================== */
const MAX_CHAT_LINES = 80;

// 입력창 내용을 서버로 전송
function sendChat() {
  const input = document.getElementById("chatInput");
  const text = (input.value || "").trim();
  if (!text) return;
  if (net.connected && net.ws.readyState === WebSocket.OPEN && gameState === "playing") {
    net.ws.send(JSON.stringify({ type: "chat", text }));
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
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat();
      e.target.blur(); // Enter 로 보내면 입력창에서 빠져나와 운전 복귀
    }
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
  net.ws.send(JSON.stringify(msg));
}

// 원격 차량을 목표 위치로 매 프레임 보간 (부드러운 이동)
function updateRemotes() {
  for (const [id, r] of remotePlayers) {
    r.x = lerp(r.x, r.tx, 0.25);
    r.y = lerp(r.y, r.ty, 0.25);
    // 각도는 -π~π 경계를 고려해 최단 경로로 보간
    let diff = r.tangle - r.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    r.angle += diff * 0.25;

    // 드리프트 중인 원격 차량의 타이어 자국도 그 차 색으로 남긴다
    if (r.drifting) pushSkid(r.x, r.y, r.angle, skidColorForId(id));
  }
}

connect();


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
  updateResistance(CAR, dt);  // 공기/구름 저항
  updateSurface(CAR, dt);     // 노면(레이싱 트랙 이탈 시 감속)
  updateGrip(CAR, dt);        // 그립 (측면 마찰) → 드리프트
  updatePhysics(CAR, dt);     // 속도/위치 합성·적분
  updateCollision(CAR);       // 맵 경계 충돌
  updateSkid(CAR);            // 스키드 마크
  updateCamera(CAR, dt);      // 카메라 추적 (+ 흔들림 감쇠)

  // ----- 네트워크 -----
  netSend(CAR, now);          // 내 상태 송신
  updateRemotes();            // 원격 차량 보간
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
  CAR.maxSpeed = playerName === "울트라응가맨" ? 600 : "울트라슈퍼응가맨" ? 1200 : 320;

  const vmax = CAR.maxSpeed * KMH_TO_PXS;
  CAR.enginePower =
  CAR.airResistance * vmax * vmax * vmax +
  CAR.rollingResistance * vmax * vmax;

  try { localStorage.setItem("carGameName", playerName); } catch {}

  // 상태 초기화
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  camera.shake = 0;
  document.getElementById("chatLog").innerHTML = ""; // 새 방 → 채팅 비움
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
  keys.w = keys.a = keys.d = keys.space = false; // 메뉴 조작으로 눌린 키 초기화

  // 레이싱은 클라이언트가 트랙 출발점에서 시작(서버 spawn 없음).
  // 서바이벌은 서버가 'spawn' 으로 위치를 정해 보내준다.
  if (mode === "racing") {
    CAR.x = TRACK.start.x; CAR.y = TRACK.start.y; CAR.angle = TRACK.start.angle;
    CAR.invulnUntil = performance.now() + 1500;
    net.pendingTeleport = true;
    updateCamera(CAR, 0); // 카메라 즉시 출발점으로
  }

  gameState = "playing";
  document.getElementById("menu").classList.remove("show");
  document.getElementById("exitBtn").style.display = "block";

  sendJoin(); // 서버에 입장 (서바이벌이면 서버가 spawn 통지)
}

function toMenu() {
  if (gameState === "menu") return;
  gameState = "menu";
  sendLeave();
  remotePlayers.clear();
  skidMarks.length = 0;
  document.getElementById("exitBtn").style.display = "none";
  document.getElementById("death").classList.remove("show");
  document.getElementById("menu").classList.add("show");
}

// 메뉴 UI 배선
function setupMenu() {
  const input = document.getElementById("nameInput");
  // 저장된 이름 자동완성
  try { input.value = localStorage.getItem("carGameName") || ""; } catch {}

  document.getElementById("btnSurvival").addEventListener("click", () => startGame("survival"));
  document.getElementById("btnRacing").addEventListener("click", () => startGame("racing"));
  document.getElementById("exitBtn").addEventListener("click", toMenu);

  document.getElementById("menu").classList.add("show"); // 시작은 메뉴
}

init();
setupMenu();
setupChat();
requestAnimationFrame(frame);
