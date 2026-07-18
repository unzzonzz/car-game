"use strict";

/* =============================================================================
 *  netbot.js — v4 넷코드 측정 하네스 (NETCODE.md §10)
 * -----------------------------------------------------------------------------
 *  게임 클라이언트와 같은 파이프라인(고정틱 예측 + reconciliation + 상대 전방
 *  시뮬)을 shared.js 로 그대로 수행하는 헤드리스 봇. 합성 지연/지터를 양방향에
 *  주입해 다음을 실측한다:
 *   1) 보정률/크기  : 결정론이 성립하면 직선 주행 중 reconcile 불일치 = 0
 *   2) 시점 일치도  : A 화면의 (A-B) 진행차 + B 화면의 (B-A) 진행차 ≈ 0
 *                    (v3 구조는 두 값이 같은 부호로 더해져 수백 px 편향)
 *   3) 전환 과도오차: 상대 조향 전환 시 표시 오차 p95
 *   4) 대역폭
 *
 *  사용 :  node netbot.js [serverUrl] [delayMs] [jitterMs]
 *  예   :  node netbot.js ws://localhost:59101 40 10   (RTT 80ms + 지터)
 * ========================================================================== */

const WebSocket = require("ws");
const SIM = require("./shared.js");
const TRACKS = SIM.buildTracks();

const URL = process.argv[2] || "ws://localhost:3000";
const DELAY_MS = Number(process.argv[3] || 40);   // 편도 지연
const JITTER_MS = Number(process.argv[4] || 10);  // 편도 지터(0~값 균등)

const MSG_INPUT = 4, MSG_SNAP4 = 5;
const A2I = 32767 / Math.PI;
const HIST_N = 128;
const MODE = process.argv[5] || "retro2"; // retro2(트랙) / survival(무트랙 최고속) 등

function delay(fn) {
  const d = DELAY_MS + Math.random() * JITTER_MS;
  setTimeout(fn, d);
}

const SIM_FIELDS = ["x", "y", "angle", "vx", "vy", "lf", "ll", "steerInput", "throttle", "braking", "reversing",
  "drifting", "driftBoostT", "evx", "evy", "spinV", "invulnUntilTick", "lockUntilTick", "stunUntilTick",
  "punchReadyTick", "respawnReadyTick", "impactSlideUntilTick", "contactTick", "trackHint", "lastPhase01"];
function copySim(dst, src) { for (const f of SIM_FIELDS) dst[f] = src[f]; return dst; }

class Bot {
  constructor(name, driveFn) {
    this.name = name;
    this.driveFn = driveFn;           // (tick) => buttons
    this.car = SIM.makeCarState(0, 0, 0);
    this.simTick = 0;
    this.acc = 0;
    this.clockOff = null;
    this.lead = 3;
    this.phaseWin = [];
    this.leadDownAt = 0;
    this.id = null;
    this.lastSnapTick = 0;
    this.lastSnapAt = 0;
    this.hist = new Array(HIST_N).fill(null);
    this.recentInputs = [];
    this.remotes = new Map();         // id -> { sim, simTick, buttons, x, y, angle, snapAt }
    this.stats = {
      corrections: 0, corrMax: 0, corrSum: 0,
      snaps: 0, bytesIn: 0, bytesOut: 0,
      hardResyncs: 0,
    };
    this.ready = false;
    this.env = {
      tick: 0,
      world: SIM.WORLD_DIMS[MODE] || { w: 5000, h: 5000 }, // survival = 서버 MAP_SIZE
      track: TRACKS[MODE] || null,
      obstacles: MODE === "plaza" ? SIM.PLAZA_OBSTACLES : MODE === "boss" ? SIM.BOSS_PILLARS : null,
      speedScale: MODE === "sumo" ? SIM.SUMO.speedScale : 1,
      noBounds: MODE === "sumo", freeze: false,
    };
    this.collideOn = ["plaza", "survival", "sumo", "boss"].includes(MODE);
    this.contacts = new Map();
  }

  connect() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(URL);
      this.ws.on("message", (data, isBinary) => {
        this.stats.bytesIn += data.length;
        delay(() => this.onMessage(data, isBinary)); // 하향 지연 주입
      });
      this.ws.on("open", () => {
        this.send({ type: "hello", v: 4 });
        this.send({ type: "join", mode: MODE, name: this.name });
        resolve();
      });
    });
  }
  send(obj) {
    const s = JSON.stringify(obj);
    this.stats.bytesOut += s.length;
    delay(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(s); }); // 상향 지연
  }
  sendBin(buf) {
    this.stats.bytesOut += buf.length;
    delay(() => { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf); });
  }

  noteServerTick(tick, atMs) {
    const off = tick - atMs / SIM.TICK_MS;
    if (this.clockOff === null || off > this.clockOff) this.clockOff = off;
    else this.clockOff = Math.max(off, this.clockOff - 0.0008);
  }
  estServerTick(nowMs) { return this.clockOff === null ? this.simTick : nowMs / SIM.TICK_MS + this.clockOff; }
  notePhase(v) {
    const now = performance.now();
    this.phaseWin.push({ t: now, v });
    while (this.phaseWin.length && this.phaseWin[0].t < now - 2000) this.phaseWin.shift();
    let m1 = -127, m2 = -127;
    for (const s of this.phaseWin) { if (s.v > m1) { m2 = m1; m1 = s.v; } else if (s.v > m2) m2 = s.v; }
    if (m2 >= 0) { this.lead = Math.min(20, this.lead + Math.max(1, m2 + 1)); this.phaseWin.length = 0; }
    else if (m1 <= -3 && now - this.leadDownAt > 5000 && this.lead > 1) { this.lead -= 1; this.leadDownAt = now; }
  }

  onMessage(data, isBinary) {
    if (isBinary) {
      if (data[0] === MSG_SNAP4) this.applySnap(this.decodeSnap(data));
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === "welcome") {
      this.id = msg.id;
      if (typeof msg.tick === "number") {
        this.noteServerTick(msg.tick, performance.now());
        this.simTick = msg.tick + this.lead;
      }
    } else if (msg.type === "spawn") {
      SIM.teleport(this.car, msg.x, msg.y, msg.angle);
      this.hist.fill(null);
      this.ready = true;
      this.spawnAt = performance.now();
    } else if (msg.type === "kicked") {
      console.error(`[${this.name}] kicked:`, msg.reason);
    }
  }

  decodeSnap(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 1;
    const tick = dv.getUint32(o); o += 4;
    const ack = dv.getUint32(o); o += 4;
    const phase = dv.getInt8(o); o += 1;
    const flags = dv.getUint8(o); o += 1;
    const keyframe = !!(flags & 1);
    const count = dv.getUint16(o); o += 2;
    const ents = [];
    for (let i = 0; i < count; i++) {
      const e = { id: dv.getUint32(o) }; o += 4;
      const mask = dv.getUint16(o); o += 2;
      if (mask & 1) { e.x = dv.getInt32(o) / 4; o += 4; e.y = dv.getInt32(o) / 4; o += 4; }
      if (mask & 2) { e.vx = dv.getInt16(o) / 8; o += 2; e.vy = dv.getInt16(o) / 8; o += 2; }
      if (mask & 4) { e.evx = dv.getInt16(o) / 8; o += 2; e.evy = dv.getInt16(o) / 8; o += 2; }
      if (mask & 8) { e.angle = dv.getInt16(o) / A2I; o += 2; }
      if (mask & 16) { e.steer = dv.getInt8(o) / 127; o += 1; }
      if (mask & 32) { e.buttons = dv.getUint8(o); o += 1; }
      if (mask & 64) { e.state = dv.getUint8(o); o += 1; }
      if (mask & 128) { e.invulnTicks = dv.getUint8(o); o += 1; e.lockTicks = dv.getUint8(o); o += 1; e.stunTicks = dv.getUint8(o); o += 1; }
      if (mask & 256) { e.spinV = dv.getInt16(o) / 8; o += 2; }
      if (mask & 512) { e.driftBoostT = buf[o] / 255; o += 1; }
      if (mask & 1024) { e.slideTicks = buf[o]; o += 1; }
      if (keyframe) { o += 3; const nl = buf[o]; o += 1 + nl; } // 색/이름 스킵
      ents.push(e);
    }
    return { tick, ack, phase, ents };
  }

  applySnap(snap) {
    if (snap.tick <= this.lastSnapTick) return; // 지터 재정렬로 늦게 온 옛 스냅샷 폐기
    const nowMs = performance.now();
    this.stats.snaps++;
    this.noteServerTick(snap.tick, nowMs);
    this.lastSnapTick = snap.tick;
    this.lastSnapAt = nowMs;
    this.notePhase(snap.phase);
    let me = null;
    const seen = new Set();
    for (const e of snap.ents) {
      if (e.id === this.id) { me = e; continue; }
      seen.add(e.id);
      let r = this.remotes.get(e.id);
      if (!r) { r = { sim: SIM.makeCarState(e.x, e.y, e.angle), simTick: snap.tick, x: e.x, y: e.y, angle: e.angle, driftUntil: 0 }; this.remotes.set(e.id, r); }
      r.buttons = e.buttons || 0;
      r.extrap = ((e.state || 0) >> 5) & 3;
      SIM.applyServerState(r.sim, {
        x: e.x, y: e.y, angle: e.angle, vx: e.vx || 0, vy: e.vy || 0,
        evx: e.evx || 0, evy: e.evy || 0, spinV: e.spinV || 0, steer: e.steer || 0,
        drifting: !!((e.state || 0) & 1), driftBoostT: e.driftBoostT, tick: snap.tick,
        invulnTicks: e.invulnTicks, lockTicks: e.lockTicks, stunTicks: e.stunTicks, slideTicks: e.slideTicks,
      });
      r.simTick = snap.tick;
      r.snapAt = nowMs;
      this.advanceRemote(r);
    }
    for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
    if (me && this.ready) this.reconcile(me, snap.tick);
  }

  advanceRemote(r) {
    if (r.extrap !== 0) return;
    if (performance.now() - r.snapAt > 250) return;
    let guard = 0;
    while (r.simTick < this.simTick && guard++ < 20) {
      r.simTick++;
      this.env.tick = r.simTick;
      SIM.stepCar(r.sim, r.buttons, this.env, 1, null);
    }
  }

  reconcile(me, T) {
    const h = this.hist[T % HIST_N];
    if (!h || h.tick !== T) {
      if (Math.abs(this.simTick - T) > 30) {
        this.stats.hardResyncs++;
        SIM.applyServerState(this.car, { x: me.x, y: me.y, angle: me.angle, vx: me.vx || 0, vy: me.vy || 0, evx: me.evx || 0, evy: me.evy || 0, spinV: me.spinV || 0, steer: me.steer || 0, drifting: !!((me.state || 0) & 1), tick: T });
        this.simTick = T + this.lead;
        this.hist.fill(null);
      }
      return;
    }
    const dx = me.x - h.x, dy = me.y - h.y;
    const err = Math.hypot(dx, dy);
    if (err <= 0.6) return; // 양자화 경계(2쿼텀) 잡음 무시
    const inContact = !!((me.state || 0) & 16) || (this.car.contactTick >= T - 3);
    if (inContact && err < 90) { // 몸싸움 중 : 소프트 블렌드 (클라와 동일)
      this.stats.softBlends = (this.stats.softBlends || 0) + 1;
      this.car.x += dx * 0.25; this.car.y += dy * 0.25;
      this.car.vx += ((me.vx || 0) - this.car.vx) * 0.35; this.car.vy += ((me.vy || 0) - this.car.vy) * 0.35;
      this.car.evx += ((me.evx || 0) - this.car.evx) * 0.35; this.car.evy += ((me.evy || 0) - this.car.evy) * 0.35;
      this.car.spinV += ((me.spinV || 0) - this.car.spinV) * 0.5;
      if (me.slideTicks !== undefined) this.car.impactSlideUntilTick = T + me.slideTicks;
      SIM.decompose(this.car);
      return;
    }
    this.stats.corrections++;
    this.stats.corrSum += err;
    if (err > this.stats.corrMax) this.stats.corrMax = err;
    if (this.stats.corrections <= 8 || err > this.stats.corrMax * 0.99) {
      console.log(`[corr ${this.name}] T=${T} err=${err.toFixed(2)} d=(${dx.toFixed(2)},${dy.toFixed(2)}) hBtn=${h.buttons} srvSteer=${(me.steer||0).toFixed(2)} mySteer=${h.steerInput.toFixed(2)} ackLag=${this.simTick - T}`);
    }
    SIM.applyServerState(this.car, {
      x: me.x, y: me.y, angle: me.angle, vx: me.vx || 0, vy: me.vy || 0,
      evx: me.evx || 0, evy: me.evy || 0, spinV: me.spinV || 0, steer: me.steer || 0,
      drifting: !!((me.state || 0) & 1), tick: T,
      invulnTicks: me.invulnTicks, lockTicks: me.lockTicks, stunTicks: me.stunTicks,
    });
    let lastButtons = h.buttons;
    for (let tk = T + 1; tk <= this.simTick; tk++) {
      const hh = this.hist[tk % HIST_N];
      const b = hh && hh.tick === tk ? hh.buttons : lastButtons;
      lastButtons = b;
      this.env.tick = tk;
      SIM.stepGroup([{ s: this.car, buttons: b, id: this.id || 0 }], this.env, {}); // 라이브와 같은 적분기
      if (hh && hh.tick === tk) copySim(hh, this.car);
    }
  }

  tick(nowMs) {
    // 시계 슬루 (클라 frame() 과 동일 규칙)
    let period = SIM.TICK_MS;
    if (this.clockOff !== null) {
      const target = Math.floor(this.estServerTick(nowMs)) + this.lead;
      const diff = target - this.simTick;
      if (diff > 60 || diff < -60) { this.simTick = target; this.acc = 0; this.hist.fill(null); }
      else period = SIM.TICK_MS * (1 - Math.max(-2, Math.min(2, diff)) * 0.02);
    }
    this.acc += nowMs - (this.lastNow || nowMs);
    this.lastNow = nowMs;
    let ticked = 0;
    while (this.acc >= period && ticked < 6) {
      this.acc -= period;
      this.simTick++;
      ticked++;
      const btns = this.ready ? this.driveFn(this.simTick) : 0;
      this.recentInputs.push({ tick: this.simTick, buttons: btns });
      while (this.recentInputs.length > 3) this.recentInputs.shift();
      this.env.tick = this.simTick;
      const entries = [{ s: this.car, buttons: btns, id: this.id || 0 }];
      let collide = false;
      if (this.collideOn) {
        for (const [id, r] of this.remotes) {
          if (r.extrap !== 0) continue;
          if (r.simTick !== this.simTick - 1) continue;
          if (Math.hypot(r.sim.x - this.car.x, r.sim.y - this.car.y) > 400) continue;
          entries.push({ s: r.sim, buttons: r.buttons, id, _r: r, posOnly: true });
          collide = true;
        }
      }
      SIM.stepGroup(entries, this.env, { collide, impulseScale: 0.5, contacts: this.contacts });
      for (const e of entries) if (e._r) e._r.simTick = this.simTick;
      const h = this.hist[this.simTick % HIST_N] || (this.hist[this.simTick % HIST_N] = {});
      h.tick = this.simTick; h.buttons = btns;
      copySim(h, this.car);
      for (const [, r] of this.remotes) this.advanceRemote(r);
    }
    if (this.acc >= period) this.acc = 0;
    if (ticked && this.ws.readyState === WebSocket.OPEN) {
      const n = this.recentInputs.length;
      const buf = Buffer.allocUnsafe(6 + n * 5);
      buf.writeUInt8(MSG_INPUT, 0);
      buf.writeUInt32BE(this.lastSnapTick >>> 0, 1);
      buf.writeUInt8(n, 5);
      let o = 6;
      for (const r of this.recentInputs) { buf.writeUInt32BE(r.tick >>> 0, o); o += 4; buf.writeUInt8(r.buttons, o); o += 1; }
      this.sendBin(buf);
    }
    // 표시 스무딩 (파리티 측정용 — 클라와 동일한 피드포워드)
    const dt = Math.min(0.05, (nowMs - (this.lastDispNow || nowMs)) / 1000) || 0.004;
    this.lastDispNow = nowMs;
    const ease = 1 - Math.exp(-dt / 0.08);
    for (const [, r] of this.remotes) {
      const tvx = r.sim.vx + r.sim.evx, tvy = r.sim.vy + r.sim.evy;
      r.x += (r.sim.x - r.x) * ease + tvx * dt * (1 - ease);
      r.y += (r.sim.y - r.y) * ease + tvy * dt * (1 - ease);
      let d = r.sim.angle - r.angle; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      r.angle += Math.max(-4 * dt, Math.min(4 * dt, d * ease));
    }
  }
}

/* ---- 스모 그라인딩 시나리오 : 옆구리 밀착 몸싸움 20초 ---- */
async function sumoGrind() {
  console.log(`[netbot] GRIND server=${URL} delay=${DELAY_MS} jitter=${JITTER_MS}`);
  // 상호 추적 : 둘 다 상대를 향해 조향 → 정면 밀착 후 지속 몸싸움
  function homing() {
    return function (tick) {
      const rc = this.remotes.values().next().value;
      if (!rc) return SIM.BTN.W;
      const want = Math.atan2(rc.y - this.car.y, rc.x - this.car.x);
      let d = want - this.car.angle;
      while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      return SIM.BTN.W | (d > 0.06 ? SIM.BTN.D : d < -0.06 ? SIM.BTN.A : 0);
    };
  }
  const botC = new Bot("botC", null); botC.driveFn = homing().bind(botC);
  const botD = new Bot("botD", null); botD.driveFn = homing().bind(botD);
  await botC.connect();
  await botD.connect();
  const loop = setInterval(() => { const now = performance.now(); botC.tick(now); botD.tick(now); }, 4);
  await new Promise((r) => setTimeout(r, 3000));

  const agree = [];  // 두 화면의 상대거리 일치도
  const sampler = setInterval(() => {
    const rD = botC.remotes.get(botD.id), rC = botD.remotes.get(botC.id);
    if (!rD || !rC) return;
    const dC = Math.hypot(botC.car.x - rD.x, botC.car.y - rD.y);   // C 화면의 C-D 거리
    const dD = Math.hypot(botD.car.x - rC.x, botD.car.y - rC.y);   // D 화면의 D-C 거리
    const trueD = Math.hypot(botC.car.x - botD.car.x, botC.car.y - botD.car.y); // (참고용)
    agree.push({ diff: Math.abs(dC - dD), dC, dD, trueD });
  }, 200);
  await new Promise((r) => setTimeout(r, 20000));
  clearInterval(sampler); clearInterval(loop);

  const p = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0; };
  const touching = agree.filter((s) => s.trueD < 120);
  console.log(`\n==== 스모 그라인딩 (20초 밀착 몸싸움) ====`);
  console.log(`표본 ${agree.length} (접촉권 ${touching.length})`);
  console.log(`화면 간 상대거리 차 |dC-dD| : p50=${p(agree.map(s => s.diff), 0.5).toFixed(1)}px p95=${p(agree.map(s => s.diff), 0.95).toFixed(1)}px (목표 <20px)`);
  console.log(`접촉권 표본 p95=${p(touching.map(s => s.diff), 0.95).toFixed(1)}px`);
  for (const b of [botC, botD]) {
    const s = b.stats;
    console.log(`[${b.name}] corrections=${s.corrections} (max=${s.corrMax.toFixed(1)}px avg=${s.corrections ? (s.corrSum / s.corrections).toFixed(1) : 0}px) softBlends=${s.softBlends || 0} hardResyncs=${s.hardResyncs}`);
  }
  process.exit(0);
}

/* ---- 시나리오 ---- */
async function main() {
  if (process.argv[6] === "keep") { // 단일 봇 상주 (브라우저 육안/원격 경로 검증용)
    const solo = new Bot("netbot", (tick) => SIM.BTN.W | ((tick % 240) < 60 ? SIM.BTN.D : 0));
    await solo.connect();
    setInterval(() => solo.tick(performance.now()), 4);
    console.log("[netbot] solo keep-alive");
    return;
  }
  if (MODE === "sumo") return sumoGrind();
  console.log(`[netbot] server=${URL} one-way delay=${DELAY_MS}ms jitter=${JITTER_MS}ms mode=${MODE}`);

  let bSteer = 0; // 봇 B 조향 상태 (시나리오 2에서 토글)
  const botA = new Bot("botA", () => SIM.BTN.W);
  const botB = new Bot("botB", () => SIM.BTN.W | bSteer);

  await botA.connect();
  await botB.connect();

  // 틱 루프 (양 봇)
  const loop = setInterval(() => {
    const now = performance.now();
    botA.tick(now);
    botB.tick(now);
  }, 4);

  await new Promise((r) => setTimeout(r, 3000)); // 스폰/시계 안정화

  const diag = setInterval(() => {
    const rB = botA.remotes.get(botB.id);
    if (!rB) return;
    console.log(`[diag] A.tick=${botA.simTick} B.tick=${botB.simTick} A>B.simTick=${rB.simTick} leadA=${botA.lead} leadB=${botB.lead} | A.x=${botA.car.x.toFixed(0)} B.x=${botB.car.x.toFixed(0)} tgtBx=${rB.sim.x.toFixed(0)} dispBx=${rB.x.toFixed(0)}`);
  }, 2000);
  setTimeout(() => clearInterval(diag), 13000);

  /* 시나리오 1 : 직선 최고 가속 12초 — 시점 일치도 + 보정률 */
  const parity = [];
  const sampler1 = setInterval(() => {
    if (!botA.ready || !botB.ready || botA.remotes.size === 0 || botB.remotes.size === 0) return;
    const dispB = botA.remotes.get(botB.id);
    const dispA = botB.remotes.get(botA.id);
    if (!dispB || !dispA) return;
    // 진행 방향(공유 스폰에서 동일 heading) 기준 "내가 앞선 정도"
    const hx = Math.cos(botA.car.angle), hy = Math.sin(botA.car.angle);
    const aheadA = (botA.car.x - dispB.x) * hx + (botA.car.y - dispB.y) * hy;
    const aheadB = (botB.car.x - dispA.x) * hx + (botB.car.y - dispA.y) * hy;
    const speed = Math.hypot(botA.car.vx, botA.car.vy);
    parity.push({ bias: aheadA + aheadB, aheadA, aheadB, speed });
  }, 250);
  await new Promise((r) => setTimeout(r, 12000));
  clearInterval(sampler1);

  /* 시나리오 2 : B 가 0.7초 간격 조향 토글 8초 — A 화면의 B 표시 오차 */
  const transErr = [];
  const steerToggle = setInterval(() => { bSteer = bSteer ? 0 : SIM.BTN.D; }, 700);
  const sampler2 = setInterval(() => {
    const dispB = botA.remotes.get(botB.id);
    if (!dispB) return;
    transErr.push(Math.hypot(dispB.x - botB.car.x, dispB.y - botB.car.y));
  }, 100);
  await new Promise((r) => setTimeout(r, 8000));
  clearInterval(steerToggle); clearInterval(sampler2); clearInterval(loop);

  /* ---- 리포트 ---- */
  const p = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0; };
  const lateBias = parity.filter((s) => s.speed > 800);
  console.log("\n==== 시나리오 1 : 나란히 최고속 직진 (시점 일치도) ====");
  console.log(`속도>800px/s 표본 ${lateBias.length}개`);
  console.log(`bias(두 화면 '내가 앞' 합산, v3 예상 수백px) : p50=${p(lateBias.map(s => Math.abs(s.bias)), 0.5).toFixed(1)}px p95=${p(lateBias.map(s => Math.abs(s.bias)), 0.95).toFixed(1)}px`);
  console.log(`|aheadA| p95=${p(lateBias.map(s => Math.abs(s.aheadA)), 0.95).toFixed(1)}px  |aheadB| p95=${p(lateBias.map(s => Math.abs(s.aheadB)), 0.95).toFixed(1)}px`);
  console.log(`최고 속도 : ${Math.max(0, ...parity.map(s => s.speed)).toFixed(0)}px/s`);
  console.log("\n==== 시나리오 2 : 상대 조향 전환 표시 오차 ====");
  console.log(`p50=${p(transErr, 0.5).toFixed(1)}px  p95=${p(transErr, 0.95).toFixed(1)}px  max=${Math.max(0, ...transErr).toFixed(1)}px  (목표 과도 <45px @RTT80)`);
  for (const b of [botA, botB]) {
    const s = b.stats;
    console.log(`\n[${b.name}] snaps=${s.snaps} corrections=${s.corrections} (max=${s.corrMax.toFixed(2)}px, avg=${s.corrections ? (s.corrSum / s.corrections).toFixed(2) : 0}px) hardResyncs=${s.hardResyncs}`);
    console.log(`  대역 : in=${(s.bytesIn / 23 / 1024).toFixed(1)}KB/s out=${(s.bytesOut / 23 / 1024).toFixed(1)}KB/s (23s 기준)`);
  }
  botA.ws.close(); botB.ws.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
