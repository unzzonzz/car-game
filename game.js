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
  // 월드(맵) 크기 : 5000 x 5000 px
  MAP_SIZE: 5000,

  // 픽셀 <-> 미터 환산 (물리 계산은 px/s 로 하되, 화면 표시는 km/h 로 변환)
  PIXELS_PER_METER: 8,

  // 한 프레임 dt 상한 (탭 비활성 등으로 인한 물리 폭발 방지)
  MAX_DT: 1 / 30,
};

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

  grip: 13.0,             // 저속 측면 그립 계수 (1/s) — 클수록 측면미끄럼 즉시 제거
  driftGrip: 2.0,         // 고속 측면 그립 계수 (1/s) — 작을수록 잘 미끄러짐(드리프트)

  steering: 3.0,          // 최대 조향 각속도 (rad/s) — 풀 카운터 시 1초에 회전하는 라디안
  highSpeedSteer: 0.40,   // 고속에서 남는 조향 권한 비율 (0~1) — 고속일수록 핸들 둔해짐

  weight: 1500,           // 차량 질량 (kg) — 무게감/반응속도(조향 램프, 그립 회복)에 사용

  airResistance: 1.15e-4, // 공기저항 계수 — 감속 ∝ 속도² (고속에서 급격히 커짐)
  rollingResistance: 0.022, // 구름저항 계수 — 감속 ∝ 속도 (저속 코스팅을 서서히 멈춤)

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

  invulnUntil: 0,          // 이 시각(performance.now ms)까지 무적 — 부활 직후 보호
};


/* =============================================================================
 *  입력 처리
 * ========================================================================== */
const keys = { w: false, a: false, d: false, space: false };

window.addEventListener("keydown", (e) => {
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
  const authority = lerp(1, car.highSpeedSteer, speedRatio);

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

/* 6) 그립 (측면 마찰) — 드리프트의 핵심 -------------------------------------
 *  측면 속도 성분 ll 을 매 프레임 지수적으로 감쇠시킨다.
 *      ll *= e^(-grip · dt)
 *  - grip(감쇠율)이 크면 측면속도가 즉시 사라져 v 가 heading 에 빠르게 정렬
 *    → 깔끔하고 회전반경 작은 코너링(저속).
 *  - grip 이 작으면 측면속도가 오래 남아 차 뒤가 미끄러진다 → 드리프트(고속).
 *  속도가 높을수록 grip → driftGrip 으로 낮아져 자연히 드리프트가 발생.
 *  추가로 고속에서 핸들을 많이 꺾으면 그립이 더 떨어지도록 해 드리프트 유도. */
function updateGrip(car, dt) {
  const speed = speedOf(car);
  const speedRatio = clamp(speed / (car.maxSpeed * KMH_TO_PXS), 0, 1);

  // 속도에 따른 기본 그립 (저속:grip → 고속:driftGrip)
  let lateralFriction = lerp(car.grip, car.driftGrip, speedRatio);

  // 고속 + 큰 조향 시 그립 추가 감소 → 뒤가 더 잘 흘러나간다
  const steerLoad = Math.abs(car.steerInput) * speedRatio;
  lateralFriction *= lerp(1.0, 0.55, steerLoad);

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
 *  맵 벽에 차체가 닿으면 "사망" 처리하고 맵 중앙에서 리스폰한다. */
function updateCollision(car) {
  const r = CONFIG.MAP_SIZE;
  const half = car.length / 2;

  if (car.x < half || car.x > r - half ||
      car.y < half || car.y > r - half) {
    respawn(car);
  }
}

/* 벽 충돌 시 로컬에서 차량을 "다른 플레이어가 없는" 랜덤 위치로 되살린다.
 *  (플레이어 간 킬에 의한 부활은 서버가 위치를 정해 handleDeath 로 처리한다.)
 *  - 맵 위 여러 후보 중 알고 있는 원격 플레이어로부터 가장 먼 지점을 고른다.
 *  - 부활 직후 잠깐 무적을 주고, teleport 플래그로 남들 화면 슬라이드를 막는다. */
function respawn(car) {
  const S = CONFIG.MAP_SIZE;
  const margin = 250;            // 벽에서 떨어뜨릴 여백
  const safeDist = 700;          // 이 거리 이상 떨어지면 충분히 안전하다고 판단

  let bx = S / 2, by = S / 2, bestDist = -1;
  for (let i = 0; i < 30; i++) {
    const x = margin + Math.random() * (S - 2 * margin);
    const y = margin + Math.random() * (S - 2 * margin);

    // 이 후보에서 가장 가까운 플레이어까지의 거리
    let minD = Infinity;
    for (const r of remotePlayers.values()) {
      const d = Math.hypot(x - r.x, y - r.y);
      if (d < minD) minD = d;
    }

    if (minD > bestDist) { bestDist = minD; bx = x; by = y; }
    if (minD > safeDist) break; // 충분히 안전한 곳 발견 → 종료
  }

  car.x = bx; car.y = by;
  car.angle = Math.random() * Math.PI * 2; // 무작위 방향
  car.vx = 0; car.vy = 0;
  car.lf = 0; car.ll = 0;
  car.steerInput = 0;
  car.invulnUntil = performance.now() + 1500; // 1.5초 무적
  net.pendingTeleport = true; // 남들 화면에서 슬라이드 없이 스냅되도록
  skidMarks.length = 0; // 이전 타이어 자국 정리
}

/* 플레이어 간 킬 판정은 이제 서버 권위로 처리한다(server.js 의 runCollisions).
 *  클라이언트는 더 이상 스스로 죽음을 판정하지 않고, 서버의 통지를 따른다.
 *  - "death"  : 내가 죽었으니 지정 위치에서 부활하라 (handleDeath)
 *  - "killed" : 누군가 죽었으니 그 자리에 폭발을 띄워라 (모두에게)
 *  → 두 PC의 판정 불일치 / "내가 박았는데 내가 죽음" 문제가 사라진다. */

// 서버가 내 사망을 통지 → 권위 위치로 부활
function handleDeath(x, y, angle) {
  CAR.x = x; CAR.y = y; CAR.angle = angle;
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0;
  CAR.steerInput = 0;
  CAR.invulnUntil = performance.now() + 1500;
  net.pendingTeleport = true; // 다음 송신에 teleport 표시 → 남들 화면에서 슬라이드 방지
  skidMarks.length = 0;
  showDeathScreen();
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

// 내 차 : 측면 미끄럼이 크고 속도가 충분하면 내 색으로 자국을 남긴다.
function updateSkid(car) {
  const lateral = Math.abs(car.ll);
  const speed = speedOf(car);
  if (lateral > 18 && speed > 40 * KMH_TO_PXS) {
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

  // 폭발 이펙트 (차량 위에)
  drawExplosions();

  ctx.restore();

  drawMinimap(car);
  drawSpeed(car);
}

// 바닥 : 초록 배경 + 도로 그리드
function drawGround() {
  const S = CONFIG.MAP_SIZE;

  // 맵 영역
  ctx.fillStyle = "#46504a";
  ctx.fillRect(0, 0, S, S);

  // 그리드 (위치 파악용) — 화면에 보이는 영역만 그린다
  const grid = 250;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const x0 = Math.max(0, Math.floor(camera.x / grid) * grid);
  const x1 = Math.min(S, camera.x + canvas.width);
  const y0 = Math.max(0, Math.floor(camera.y / grid) * grid);
  const y1 = Math.min(S, camera.y + canvas.height);
  for (let x = x0; x <= x1; x += grid) {
    ctx.moveTo(x, y0); ctx.lineTo(x, y1);
  }
  for (let y = y0; y <= y1; y += grid) {
    ctx.moveTo(x0, y); ctx.lineTo(x1, y);
  }
  ctx.stroke();

  // 맵 경계
  ctx.strokeStyle = "#d8d040";
  ctx.lineWidth = 8;
  ctx.strokeRect(0, 0, S, S);
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

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSpeed(car) {
  // 전진 속도(체감 속도)를 km/h 정수로 표시
  const kmh = Math.round(Math.max(0, car.lf) * PXS_TO_KMH);
  speedEl.textContent = kmh;
}

// 미니맵 : 맵 전체 + 차량 위치 + 차량 방향
function drawMinimap(car) {
  const size = minimap.width;
  const scale = size / CONFIG.MAP_SIZE;

  mctx.clearRect(0, 0, size, size);

  // 맵 바닥
  mctx.fillStyle = "rgba(70,80,74,0.9)";
  mctx.fillRect(0, 0, size, size);

  // 현재 화면(뷰포트) 영역 표시
  mctx.strokeStyle = "rgba(255,255,255,0.4)";
  mctx.lineWidth = 1;
  mctx.strokeRect(
    camera.x * scale, camera.y * scale,
    canvas.width * scale, canvas.height * scale
  );

  // 다른 플레이어 (작은 점)
  for (const [id, r] of remotePlayers) {
    mctx.fillStyle = colorForId(id);
    mctx.beginPath();
    mctx.arc(r.x * scale, r.y * scale, 3, 0, Math.PI * 2);
    mctx.fill();
  }

  // 내 차량 위치 + 방향(삼각형)
  const cx = car.x * scale;
  const cy = car.y * scale;
  mctx.save();
  mctx.translate(cx, cy);
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

  net.ws.onopen = () => { net.connected = true; };

  net.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "welcome") {
      net.id = msg.id;
    } else if (msg.type === "death") {
      // 서버 판정: 내가 죽었다 → 권위 위치로 부활
      handleDeath(msg.x, msg.y, msg.angle);
    } else if (msg.type === "killed") {
      // 서버 통지: 누군가 죽었다 → 그 자리에서 그 차 색으로 폭발 (모두에게)
      const color = msg.victimId === net.id ? myColor() : colorForId(msg.victimId);
      spawnExplosion(msg.x, msg.y, color);
      // 내가 죽인 경우 내 화면을 흔든다 (타격감)
      if (msg.killerId === net.id) addShake(34);
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

// 내 차 상태를 주기적으로 서버에 전송
function netSend(car, now) {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  if (now - net.lastSend < net.sendInterval) return;
  net.lastSend = now;

  const drifting = Math.abs(car.ll) > 18 && speedOf(car) > 40 * KMH_TO_PXS;
  const msg = {
    type: "state",
    x: Math.round(car.x), y: Math.round(car.y),
    angle: +car.angle.toFixed(3),
    drifting,
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

  // ----- 물리 파이프라인 (역할 분리) -----
  updateInput(CAR, dt);       // 입력
  updateSteering(CAR, dt);    // 조향 (heading 회전)
  decompose(CAR);             // 속도 → 전진/측면 분해 (슬립 앵글 발생)
  updateEngine(CAR, dt);      // 엔진 가속
  updateBrake(CAR, dt);       // 브레이크
  updateResistance(CAR, dt);  // 공기/구름 저항
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

init();
requestAnimationFrame(frame);
