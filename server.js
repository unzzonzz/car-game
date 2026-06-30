"use strict";

/* =============================================================================
 *  멀티플레이어 서버
 * -----------------------------------------------------------------------------
 *  역할 1) 정적 파일(index.html, style.css, game.js) 서빙
 *  역할 2) WebSocket 으로 플레이어 상태 릴레이
 *
 *  네트워크 모델 : "이동은 클라이언트 예측 + 충돌 판정은 서버 권위"
 *  - 각 클라이언트가 자기 차량의 물리를 계산하고 상태(x, y, angle)를 보낸다.
 *  - 서버는 모든 차량을 "한 프레임의 일관된 좌표"로 모아두고, 누가 누구를
 *    들이받아 죽었는지(킬 판정)를 단독으로 결정한다. → 두 PC의 판정 불일치 제거.
 *  - 판정 결과(사망/부활 위치/폭발)는 서버가 모두에게 통지한다.
 *
 *  실행 :  node server.js   →  http://localhost:3000
 * ========================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;       // 초당 스냅샷 브로드캐스트 횟수 (60 → 더 매끈/낮은 지연, 대역폭 2배)
const COLLISION_HZ = 60;    // 초당 충돌 판정 횟수

// 판정용 월드/차량 상수 (클라이언트 game.js 의 값과 반드시 일치)
const MAP_SIZE = 5000;      // 서바이벌 맵 크기 (정사각형)
const CAR_LEN = 38;
const CAR_WID = 18;
const INVULN_MS = 1500;     // 부활/입장 후 무적 시간 (이 동안 죽지도 죽이지도 못함)
const GRACE_MS = 500;       // 입장 직후 클라이언트의 옛 위치 전송을 무시하는 시간
const TELEPORT_DIST = 200;  // 한 틱에 이 이상 움직이면 텔레포트로 간주(스윕 생략)
//  레이싱은 충돌/킬이 없어 서버가 트랙 좌표를 알 필요 없다(클라가 출발점 결정).

// 맵 풀 : 서버는 인덱스만 정하고, 클라가 같은 인덱스로 동일 트랙을 생성한다.
//  (game.js 의 RECIPES.length 와 일치해야 함)
const RECIPE_COUNT = 5;
function randomTrackIndex() { return Math.floor(Math.random() * RECIPE_COUNT); }
let freeTrackIndex = randomTrackIndex(); // 자유 레이싱 현재 맵

// --- 정적 파일 서버 ---------------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

const server = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, path.normalize(urlPath));

  // 디렉터리 탈출 방지
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// --- WebSocket 서버 ---------------------------------------------------------
const wss = new WebSocketServer({ server });

let nextId = 1;
// id -> { ws, state, active, mode, name, invulnUntil, graceUntil, prevHead }
//  active=false : 메뉴 화면(미입장). 스냅샷/판정에서 제외된다.
const players = new Map();

wss.on("connection", (ws) => {
  const id = nextId++;
  players.set(id, { ws, state: null, active: false, mode: "survival", name: "" });

  // heartbeat : 클라이언트가 살아있는지 추적 (프록시가 유휴 연결을 끊는 것 방지)
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // 접속한 클라이언트에게 자신의 id 를 알려준다
  ws.send(JSON.stringify({ type: "welcome", id }));
  console.log(`[+] player ${id} connected (total ${players.size})`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const p = players.get(id);
    if (!p) return;

    if (msg.type === "join") {
      p.name = sanitizeName(msg.name);
      const mode = (msg.mode === "racing") ? "racing"
        : (msg.mode === "pro") ? "pro" : "survival";

      if (mode === "pro") {
        // 프로 레이싱 : 정원/상태 체크 후 로비 입장
        if (proRoom.state !== "lobby") {
          send(p, { type: "joinReject", reason: "레이스가 진행 중입니다. 잠시 후 다시 시도하세요." });
          return;
        }
        if (proCount() >= PRO_MAX) {
          send(p, { type: "joinReject", reason: `정원(${PRO_MAX}명)이 가득 찼습니다.` });
          return;
        }
        const firstPro = proCount() === 0;
        p.mode = "pro"; p.active = true;
        p.ready = false; p.lap = 0; p.prog = 0; p.finished = false; p.finishTime = 0;
        p.slot = proAssignSlot();
        p.state = null; p.invulnUntil = 0; p.graceUntil = 0;
        if (firstPro) proRoom.trackIndex = randomTrackIndex(); // 새 레이스 → 새 맵
        send(p, { type: "proStart", slot: p.slot, laps: PRO_LAPS, trackIndex: proRoom.trackIndex });
        broadcastRace();
        console.log(`[>] player ${id} joined pro (slot ${p.slot}, map ${proRoom.trackIndex})`);
        return;
      }

      const firstRacing = mode === "racing" && modeCount("racing") === 0;
      p.mode = mode; p.active = true;
      if (mode === "survival") {
        const spawn = pickSpawn(id);
        p.state = { x: spawn.x, y: spawn.y, angle: spawn.angle, drifting: false, teleport: true };
        p.prevHead = headOf(p.state);
        p.invulnUntil = Date.now() + INVULN_MS;
        p.graceUntil = Date.now() + GRACE_MS;
        send(p, { type: "spawn", x: spawn.x, y: spawn.y, angle: spawn.angle });
      } else { // racing(자유)
        if (firstRacing) freeTrackIndex = randomTrackIndex(); // 빈 방에 첫 입장 → 새 맵
        p.state = null; p.invulnUntil = 0; p.graceUntil = 0;
        send(p, { type: "trackIndex", index: freeTrackIndex });
      }
      console.log(`[>] player ${id} joined ${p.mode} as "${p.name}"`);

    } else if (msg.type === "leave") {
      const wasPro = p.mode === "pro" && p.active;
      p.active = false; p.state = null;
      if (wasPro) proOnLeave();

    } else if (msg.type === "ready") {
      // 프로 로비에서 준비 토글 → 모두 준비되면 카운트다운 시작
      if (!p.active || p.mode !== "pro" || proRoom.state !== "lobby") return;
      p.ready = !!msg.value;
      broadcastRace();
      maybeStartCountdown();

    } else if (msg.type === "chat") {
      // 모든 모드가 공유하는 전역 채팅
      if (!p.active) return;
      const text = sanitizeChat(msg.text);
      if (!text) return;
      broadcastAll({ type: "chat", id, name: p.name, text, t: Date.now() });

    } else if (msg.type === "state") {
      if (!p.active) return;
      if (Date.now() < (p.graceUntil || 0)) return;
      p.state = {
        x: msg.x, y: msg.y, angle: msg.angle,
        drifting: !!msg.drifting,
        teleport: !!msg.teleport,
      };
      // 프로 레이싱 중이면 바퀴수/진행도 갱신 + 완주 감지
      if (p.mode === "pro" && proRoom.state === "racing" && typeof msg.lap === "number") {
        p.lap = msg.lap;
        if (typeof msg.prog === "number") p.prog = msg.prog;
        if (!p.finished && p.lap >= PRO_LAPS) {
          p.finished = true; p.finishTime = Date.now();
          if (proRoom.endAt === 0) proRoom.endAt = Date.now() + END_TIMER_MS; // 첫 완주 → 10초
          broadcastRace();
        }
      }
    }
  });

  ws.on("close", () => {
    const pc = players.get(id);
    const wasPro = pc && pc.mode === "pro" && pc.active;
    players.delete(id);
    if (wasPro) proOnLeave();
    console.log(`[-] player ${id} disconnected (total ${players.size})`);
  });

  ws.on("error", () => {}); // 비정상 종료 무시
});

// 주기적으로 ping 을 보내 죽은 연결을 정리하고 살아있는 연결은 유지한다.
//  - 25초마다 ping → 응답(pong) 없으면 다음 주기에 강제 종료.
//  - 활성 트래픽이 없어도 연결을 깨워 프록시 타임아웃으로 끊기는 것을 줄인다.
const heartbeat = setInterval(() => {
  for (const [, p] of players) {
    if (p.ws.isAlive === false) { p.ws.terminate(); continue; }
    p.ws.isAlive = false;
    try { p.ws.ping(); } catch {}
  }
}, 25000);
wss.on("close", () => clearInterval(heartbeat));

// =============================================================================
//  서버 권위 충돌 판정
// -----------------------------------------------------------------------------
//  규칙(아케이드 — 지렁이 키우기의 반대) : "상대의 머리(앞코)가 내 차체에
//  닿으면 내가 죽는다." 단, 내 머리도 상대 몸에 박혀 있으면(=쌍방 정면) 무승부.
//  서버가 모든 차량을 같은 프레임 좌표로 보고 단독 결정하므로 두 PC의 판정이
//  어긋날 수 없다. 빠른 통과(터널링)는 머리의 직전→현재 궤적을 샘플링(스윕)해 막는다.
// =============================================================================

// 한 점이 차량의 차체 사각형(OBB) 안에 있는지
function pointInCar(px, py, s) {
  const dx = px - s.x;
  const dy = py - s.y;
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  return Math.abs(lx) <= CAR_LEN / 2 && Math.abs(ly) <= CAR_WID / 2;
}

// 차량의 머리(앞코) 월드 좌표
function headOf(s) {
  return {
    x: s.x + Math.cos(s.angle) * (CAR_LEN / 2),
    y: s.y + Math.sin(s.angle) * (CAR_LEN / 2),
  };
}

// 머리의 직전→현재 궤적을 N등분해 한 점이라도 상대 몸에 들어가면 명중(스윕)
function sweptHeadHit(prevHead, curHead, target) {
  const N = 4;
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const x = prevHead.x + (curHead.x - prevHead.x) * t;
    const y = prevHead.y + (curHead.y - prevHead.y) * t;
    if (pointInCar(x, y, target)) return true;
  }
  return false;
}

// 이름 정리 : 좌우 공백 제거, 제어문자 제거, 12자 제한, 비면 기본값
function sanitizeName(name) {
  let s = (typeof name === "string" ? name : "").replace(/[\x00-\x1f]/g, "").trim();
  if (s.length > 12) s = s.slice(0, 12);
  return s || "Player";
}

// 채팅 정리 : 제어문자 제거, 좌우 공백 제거, 200자 제한
function sanitizeChat(text) {
  let s = (typeof text === "string" ? text : "").replace(/[\x00-\x1f]/g, "").trim();
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

// 서바이벌 부활 위치 : 다른 서바이벌 플레이어로부터 가장 멀리 떨어진 곳
function pickSpawn(selfId) {
  const margin = 250, safe = 700;
  let best = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 }, bestD = -1;
  for (let i = 0; i < 30; i++) {
    const x = margin + Math.random() * (MAP_SIZE - 2 * margin);
    const y = margin + Math.random() * (MAP_SIZE - 2 * margin);
    let minD = Infinity;
    for (const [id, p] of players) {
      if (id === selfId || !p.active || p.mode !== "survival" || !p.state) continue;
      const d = Math.hypot(x - p.state.x, y - p.state.y);
      if (d < minD) minD = d;
    }
    if (minD > bestD) { bestD = minD; best = { x, y }; }
    if (minD > safe) break;
  }
  return { x: best.x, y: best.y, angle: Math.random() * Math.PI * 2 };
}

function send(p, obj) {
  if (p.ws.readyState === p.ws.OPEN) p.ws.send(JSON.stringify(obj));
}
// 같은 모드의 활성 플레이어들에게만 전송
function broadcastMode(mode, obj) {
  const payload = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.active && p.mode === mode && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}
// 모든 활성 플레이어에게 전송 (전역 채팅 등)
function broadcastAll(obj) {
  const payload = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.active && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

// =============================================================================
//  프로 레이싱 룸 (단일 공유 룸, 상태기계: lobby → countdown → racing → 종료)
// -----------------------------------------------------------------------------
//  - 최대 7명. 2명 이상 모두 ready 면 자동으로 5초 카운트다운 후 시작.
//  - 카운트다운 동안 이동 불가(클라가 막음). 3바퀴 완주 순으로 순위.
//  - 첫 완주자 발생 시각부터 10초 뒤 종료 → 전원 자유 레이싱으로 이동.
//  바퀴/진행도는 클라가 트랙으로 계산해 보고(이동 권위와 동일), 서버는 순위/타이머 관리.
// =============================================================================
const PRO_MAX = 7;
const PRO_LAPS = 3;
const COUNTDOWN_MS = 5000;
const END_TIMER_MS = 10000;
const proRoom = { state: "lobby", countdownAt: 0, endAt: 0, trackIndex: randomTrackIndex() };

// 특정 모드의 활성 플레이어 수
function modeCount(mode) {
  let n = 0;
  for (const [, p] of players) if (p.active && p.mode === mode) n++;
  return n;
}

function proList() {
  const a = [];
  for (const [id, p] of players) if (p.active && p.mode === "pro") a.push({ id, p });
  return a;
}
function proCount() {
  let n = 0;
  for (const [, p] of players) if (p.active && p.mode === "pro") n++;
  return n;
}
function proAssignSlot() {
  const used = new Set();
  for (const [, p] of players) if (p.active && p.mode === "pro") used.add(p.slot);
  for (let s = 0; s < PRO_MAX; s++) if (!used.has(s)) return s;
  return 0;
}

// 순위 산정 : 완주자 먼저(빨리 완주한 순) → 미완주는 진행도 높은 순
function rankedPro() {
  const list = proList();
  list.sort((a, b) => {
    const A = a.p, B = b.p;
    if (A.finished !== B.finished) return A.finished ? -1 : 1;
    if (A.finished && B.finished) return A.finishTime - B.finishTime;
    return (B.prog || 0) - (A.prog || 0);
  });
  return list.map((e, i) => ({
    id: e.id, name: e.p.name, ready: !!e.p.ready,
    lap: e.p.lap || 0, finished: !!e.p.finished, rank: i + 1,
  }));
}

function broadcastRace() {
  const now = Date.now();
  const msg = {
    type: "race",
    state: proRoom.state,
    laps: PRO_LAPS,
    trackIndex: proRoom.trackIndex,
    canReady: proCount() >= 2, // 혼자면 ready 비활성
    countdownMs: proRoom.state === "countdown" ? Math.max(0, proRoom.countdownAt - now) : 0,
    endMs: (proRoom.state === "racing" && proRoom.endAt > 0) ? Math.max(0, proRoom.endAt - now) : 0,
    players: rankedPro(),
  };
  for (const { p } of proList()) send(p, msg);
}

function maybeStartCountdown() {
  if (proRoom.state !== "lobby") return;
  const list = proList();
  if (list.length < 2 || !list.every((e) => e.p.ready)) return;
  proRoom.state = "countdown";
  proRoom.countdownAt = Date.now() + COUNTDOWN_MS;
  proRoom.endAt = 0;
  broadcastRace();
}

function proOnLeave() {
  if (proCount() === 0) { proRoom.state = "lobby"; proRoom.countdownAt = 0; proRoom.endAt = 0; return; }
  if (proRoom.state === "countdown" && proCount() < 2) { proRoom.state = "lobby"; proRoom.countdownAt = 0; }
  broadcastRace();
  maybeStartCountdown();
}

function endRace() {
  for (const { p } of proList()) {
    send(p, { type: "toFreeRacing" }); // 클라는 자유 레이싱으로 재입장
    p.active = false; p.state = null;
  }
  proRoom.state = "lobby"; proRoom.countdownAt = 0; proRoom.endAt = 0;
}

function proTick() {
  const now = Date.now();
  if (proRoom.state === "countdown") {
    if (now >= proRoom.countdownAt) {
      proRoom.state = "racing"; proRoom.endAt = 0;
      for (const { p } of proList()) { p.lap = 0; p.prog = 0; p.finished = false; p.finishTime = 0; }
    }
    broadcastRace();
  } else if (proRoom.state === "racing") {
    if (proRoom.endAt > 0 && now >= proRoom.endAt) endRace();
    else broadcastRace(); // 순위/종료 카운트다운 갱신
  }
}
setInterval(proTick, 200); // 5Hz

// 사망 처리 : 죽은 자리 폭발 통지 → 본인은 메뉴로(비활성). 서바이벌 전용.
function killPlayer(victimId, victim, killerId) {
  const deathX = victim.state.x, deathY = victim.state.y;

  // 본인에게 사망 통지 → 클라는 모드 선택 화면으로 복귀
  send(victim, { type: "death" });

  // 같은 모드 플레이어에게 폭발 통지 (죽은 자리, 색은 클라가 victimId 로 계산)
  broadcastMode("survival", { type: "killed", victimId, killerId, x: deathX, y: deathY });

  // 비활성화 → 스냅샷/판정에서 제외
  victim.active = false;
  victim.state = null;
}

// 충돌 판정 1틱 (서바이벌 모드만)
function runCollisions() {
  // 판정 대상 : 활성 + 서바이벌 + 무적 아님
  const live = [];
  const now = Date.now();
  for (const [id, p] of players) {
    if (!p.active || p.mode !== "survival" || !p.state) continue;
    // 머리 궤적(prev→cur) 준비. 텔레포트(과도한 이동)면 스윕 생략.
    const cur = headOf(p.state);
    if (!p.prevHead || Math.hypot(cur.x - p.prevHead.x, cur.y - p.prevHead.y) > TELEPORT_DIST) {
      p.prevHead = cur;
    }
    p.curHead = cur;
    if (now >= (p.invulnUntil || 0)) live.push({ id, p });
  }

  const dead = new Set();
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const A = live[i], B = live[j];
      if (dead.has(A.id) || dead.has(B.id)) continue;

      const aHitB = sweptHeadHit(A.p.prevHead, A.p.curHead, B.p.state);
      const bHitA = sweptHeadHit(B.p.prevHead, B.p.curHead, A.p.state);

      if (aHitB && bHitA) {
        // 머리끼리 정면충돌 → 둘 다 터진다 (서로가 killer)
        killPlayer(A.id, A.p, B.id); dead.add(A.id);
        killPlayer(B.id, B.p, A.id); dead.add(B.id);
      } else if (aHitB) { killPlayer(B.id, B.p, A.id); dead.add(B.id); }
      else if (bHitA) { killPlayer(A.id, A.p, B.id); dead.add(A.id); }
    }
  }

  // 다음 틱 스윕을 위해 머리 위치 갱신
  for (const [, p] of players) {
    if (p.curHead) p.prevHead = p.curHead;
  }
}

setInterval(runCollisions, 1000 / COLLISION_HZ);

// --- 브로드캐스트 루프 ------------------------------------------------------
//  모드별로 활성 플레이어들의 최신 상태를 모아 30Hz 로 전송한다.
//  (서바이벌/레이싱 플레이어는 서로 보이지 않도록 분리)
setInterval(() => {
  const now = Date.now();
  const byMode = { survival: [], racing: [], pro: [] };

  for (const [id, p] of players) {
    if (!p.active || !p.state) continue;
    byMode[p.mode].push({
      id, name: p.name,
      x: p.state.x, y: p.state.y, angle: p.state.angle,
      drifting: p.state.drifting,
      teleport: !!p.state.teleport,       // 1회성 스냅 신호
      invuln: now < (p.invulnUntil || 0), // 원격 무적 표시(깜빡임)용
    });
  }

  for (const [, p] of players) {
    if (!p.active) continue;
    // st = 서버 송신 시각. 클라이언트가 이 일정 간격 타임스탬프로 보간 → 끊김 감소.
    send(p, { type: "snapshot", st: now, players: byMode[p.mode] });
  }

  // teleport 는 1회성 → 보낸 뒤 해제
  for (const [, p] of players) {
    if (p.state) p.state.teleport = false;
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Car game server running at http://localhost:${PORT}`);
});
