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

// 프로 맵 풀 : 서버가 인덱스만 정하고, 클라가 같은 인덱스로 동일 트랙을 생성한다.
//  자유 레이싱은 고정 맵이라 랜덤이 없다. (game.js 의 PRO_RECIPES.length 와 일치)
const PRO_RECIPE_COUNT = 5;

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
  players.set(id, { ws, state: null, active: false, mode: "survival", name: "", roomId: null });

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
        // 프로 진입 = 방 목록 화면(브라우저). 방은 따로 만들거나 골라 들어간다.
        p.mode = "pro"; p.active = true; p.roomId = null;
        send(p, { type: "roomList", rooms: roomSummaries() });
        console.log(`[>] player ${id} entered pro lobby browser`);
        return;
      }

      p.mode = mode; p.active = true; p.roomId = null;
      if (mode === "survival") {
        const spawn = pickSpawn(id);
        p.state = { x: spawn.x, y: spawn.y, angle: spawn.angle, drifting: false, teleport: true };
        p.prevHead = headOf(p.state);
        p.invulnUntil = Date.now() + INVULN_MS;
        p.graceUntil = Date.now() + GRACE_MS;
        send(p, { type: "spawn", x: spawn.x, y: spawn.y, angle: spawn.angle });
      } else { // racing(자유) : 고정 맵
        p.state = null; p.invulnUntil = 0; p.graceUntil = 0;
      }
      console.log(`[>] player ${id} joined ${p.mode} as "${p.name}"`);

    } else if (msg.type === "createRoom") {
      if (!p.active || p.mode !== "pro" || p.roomId != null) return;
      const laps = clampInt(msg.laps, 1, 20, 3);
      const maxPlayers = clampInt(msg.maxPlayers, 1, PRO_MAX, 7); // 1 = 솔로 방
      const timeLimitMs = TIME_LIMITS.includes(msg.timeLimit) ? msg.timeLimit : 0;
      let course, trackIndex;
      if (msg.course === "random") { course = "random"; trackIndex = Math.floor(Math.random() * NAMED_COURSES); }
      else { trackIndex = clampInt(msg.course, 0, NAMED_COURSES - 1, 0); course = trackIndex; }
      const name = sanitizeRoomName(msg.name) || `${p.name}의 방`;
      const room = {
        id: nextRoomId++, name, hostId: id, state: "lobby",
        laps, course, trackIndex, timeLimitMs, maxPlayers,
        countdownAt: 0, raceEndAt: 0, raceStartAt: 0,
      };
      rooms.set(room.id, room);
      enterRoom(id, p, room.id);
      console.log(`[>] player ${id} created room ${room.id} "${name}"`);

    } else if (msg.type === "joinRoom") {
      if (!p.active || p.mode !== "pro" || p.roomId != null) return;
      const room = rooms.get(msg.roomId);
      if (!room) { send(p, { type: "joinReject", reason: "방이 사라졌습니다." }); return; }
      if (room.state !== "lobby") { send(p, { type: "joinReject", reason: "레이스가 진행 중인 방입니다." }); return; }
      if (roomMembers(room.id).length >= room.maxPlayers) { send(p, { type: "joinReject", reason: "방이 가득 찼습니다." }); return; }
      enterRoom(id, p, room.id);

    } else if (msg.type === "leaveRoom") {
      if (p.roomId == null) return;
      leaveRoom(id, p);
      send(p, { type: "roomList", rooms: roomSummaries() }); // 방 목록으로 복귀

    } else if (msg.type === "leave") {
      if (p.mode === "pro" && p.roomId != null) leaveRoom(id, p);
      p.active = false; p.state = null; p.roomId = null;

    } else if (msg.type === "ready") {
      if (p.roomId == null) return;
      const room = rooms.get(p.roomId);
      if (!room || room.state !== "lobby") return;
      p.ready = !!msg.value;
      broadcastRoom(p.roomId);
      maybeStartCountdown(p.roomId);

    } else if (msg.type === "chat") {
      // 전역 채팅 — 메뉴/로비 등 미입장자도 보내고 받을 수 있다.
      const text = sanitizeChat(msg.text);
      if (!text) return;
      const name = p.active ? p.name : sanitizeName(msg.name);
      broadcastConnected({ type: "chat", id, name, text, t: Date.now() });

    } else if (msg.type === "state") {
      if (!p.active) return;
      if (Date.now() < (p.graceUntil || 0)) return;
      p.state = {
        x: msg.x, y: msg.y, angle: msg.angle,
        drifting: !!msg.drifting,
        teleport: !!msg.teleport,
      };
      // 프로 레이싱 중이면 바퀴수/진행도 갱신 + 완주 감지
      if (p.mode === "pro" && p.roomId != null && typeof msg.lap === "number") {
        const room = rooms.get(p.roomId);
        if (room && room.state === "racing") {
          p.lap = msg.lap;
          if (typeof msg.prog === "number") p.prog = msg.prog;
          if (!p.finished && p.lap >= room.laps) {
            p.finished = true; p.finishTime = Date.now();
            const cand = Date.now() + END_TIMER_MS;
            room.raceEndAt = room.raceEndAt > 0 ? Math.min(room.raceEndAt, cand) : cand;
            broadcastRoom(p.roomId);
          }
        }
      }
    }
  });

  ws.on("close", () => {
    const pc = players.get(id);
    if (pc && pc.mode === "pro" && pc.active && pc.roomId != null) leaveRoom(id, pc);
    players.delete(id);
    console.log(`[-] player ${id} disconnected (total ${players.size})`);
  });

  ws.on("error", () => {}); // 비정상 종료 무시
});

// 주기적으로 ping 을 보내 죽은(유령) 연결을 빨리 정리하고 살아있는 연결은 유지한다.
//  - 8초마다 ping → 응답(pong) 없으면 다음 주기에 강제 종료(최대 ~16초 내 정리).
//  - 비정상 종료/네트워크 끊김으로 남은 연결이 인원수에 오래 잡히는 것을 막는다.
const heartbeat = setInterval(() => {
  for (const [, p] of players) {
    if (p.ws.isAlive === false) { p.ws.terminate(); continue; }
    p.ws.isAlive = false;
    try { p.ws.ping(); } catch {}
  }
}, 8000);
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
// 모든 활성 플레이어에게 전송
function broadcastAll(obj) {
  const payload = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.active && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}
// 모든 "접속자"(메뉴/로비 포함)에게 전송 — 전역 채팅용
function broadcastConnected(obj) {
  const payload = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

// 모드별 참가 인원을 "모든 접속자"(메뉴 화면 포함)에게 알린다 → 모드 버튼에 표시
function broadcastCounts() {
  const counts = { survival: 0, racing: 0, pro: 0 };
  for (const [, p] of players) {
    if (p.active && counts[p.mode] !== undefined) counts[p.mode]++;
  }
  const payload = JSON.stringify({ type: "counts", ...counts });
  for (const [, p] of players) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}
setInterval(broadcastCounts, 1000);

// =============================================================================
//  프로 레이싱 — 다중 방 시스템
// -----------------------------------------------------------------------------
//  - 프로 진입 = 방 목록(브라우저). 방을 만들거나 골라 들어간다.
//  - 방장이 바퀴/코스/시간제한/최대인원을 설정. 방마다 lobby→countdown→racing→종료.
//  - 2명 이상 모두 ready 면 5초 카운트다운 후 시작. 카운트다운 동안 이동 불가.
//  - 종료 = (첫 완주자+10초) 와 (시간제한) 중 먼저 오는 시각 → 전원 자유 레이싱으로.
//  바퀴/진행도는 클라가 보고, 서버는 순위/타이머/방 상태를 관리한다.
// =============================================================================
const PRO_MAX = 7;
const COUNTDOWN_MS = 5000;
const END_TIMER_MS = 10000;
const NAMED_COURSES = 4;        // 선택 가능한 코스 수 (game.js PRO_RECIPES[0..3])
const TIME_LIMITS = [0, 60000, 120000, 180000, 300000]; // 무제한/1/2/3/5분(ms)

let nextRoomId = 1;
const rooms = new Map(); // roomId -> room

function clampInt(v, lo, hi, def) {
  v = Math.floor(Number(v));
  if (!Number.isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, v));
}
function sanitizeRoomName(name) {
  let s = (typeof name === "string" ? name : "").replace(/[\x00-\x1f]/g, "").trim();
  if (s.length > 16) s = s.slice(0, 16);
  return s;
}

function roomMembers(roomId) {
  const a = [];
  for (const [id, p] of players) if (p.active && p.mode === "pro" && p.roomId === roomId) a.push({ id, p });
  return a;
}
function assignSlot(roomId) {
  const used = new Set();
  for (const { p } of roomMembers(roomId)) used.add(p.slot);
  for (let s = 0; s < PRO_MAX; s++) if (!used.has(s)) return s;
  return 0;
}
function hostName(room) {
  const h = players.get(room.hostId);
  return h ? h.name : "?";
}

// 방 목록 요약 (브라우저용)
function roomSummaries() {
  const out = [];
  for (const [, r] of rooms) {
    out.push({
      id: r.id, name: r.name, host: hostName(r),
      players: roomMembers(r.id).length, maxPlayers: r.maxPlayers,
      laps: r.laps, course: r.course, timeLimit: r.timeLimitMs, state: r.state,
    });
  }
  return out;
}
function broadcastRoomList() {
  const payload = JSON.stringify({ type: "roomList", rooms: roomSummaries() });
  for (const [, p] of players) {
    if (p.active && p.mode === "pro" && p.roomId == null && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

// 방 순위 : 완주자 먼저(빨리 완주한 순) → 미완주는 진행도 높은 순
function rankedRoom(roomId) {
  const list = roomMembers(roomId);
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

function broadcastRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const now = Date.now();
  const msg = {
    type: "race",
    roomId, roomName: room.name, hostId: room.hostId,
    state: room.state, laps: room.laps, course: room.course,
    timeLimit: room.timeLimitMs, maxPlayers: room.maxPlayers, trackIndex: room.trackIndex,
    canReady: roomMembers(roomId).length >= 1, // 솔로(1명)도 시작 가능
    countdownMs: room.state === "countdown" ? Math.max(0, room.countdownAt - now) : 0,
    endMs: (room.state === "racing" && room.raceEndAt > 0) ? Math.max(0, room.raceEndAt - now) : 0,
    players: rankedRoom(roomId),
  };
  for (const { p } of roomMembers(roomId)) send(p, msg);
}

// 방 입장 (생성/참가 공통)
function enterRoom(pid, p, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  p.roomId = roomId;
  p.ready = false; p.lap = 0; p.prog = 0; p.finished = false; p.finishTime = 0;
  p.slot = assignSlot(roomId);
  p.state = null; p.invulnUntil = 0; p.graceUntil = 0;
  send(p, { type: "roomJoined", roomId, isHost: room.hostId === pid });
  send(p, { type: "proStart", slot: p.slot, laps: room.laps, trackIndex: room.trackIndex });
  broadcastRoom(roomId);
  broadcastRoomList();
}

// 방 퇴장 (방 → 브라우저). 비면 방 삭제, 방장이 나가면 위임.
function leaveRoom(pid, p) {
  const rid = p.roomId;
  if (rid == null) return;
  p.roomId = null; p.ready = false; p.state = null;
  const room = rooms.get(rid);
  if (!room) return;
  const remain = roomMembers(rid);
  if (remain.length === 0) { rooms.delete(rid); broadcastRoomList(); return; }
  if (room.hostId === pid) room.hostId = remain[0].id; // 호스트 위임
  if (room.state === "countdown" && remain.length < 1) { room.state = "lobby"; room.countdownAt = 0; }
  broadcastRoom(rid);
  broadcastRoomList();
  maybeStartCountdown(rid);
}

function maybeStartCountdown(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== "lobby") return;
  const m = roomMembers(roomId);
  if (m.length < 1 || !m.every((e) => e.p.ready)) return; // 솔로(1명)도 시작 가능
  room.state = "countdown";
  room.countdownAt = Date.now() + COUNTDOWN_MS;
  room.raceEndAt = 0;
  broadcastRoom(roomId);
  broadcastRoomList();
}

function endRoomRace(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const { p } of roomMembers(roomId)) {
    send(p, { type: "toFreeRacing" }); // 클라는 자유 레이싱으로 이동
    p.active = false; p.state = null; p.roomId = null;
  }
  rooms.delete(roomId);
  broadcastRoomList();
}

function proTick() {
  const now = Date.now();
  for (const rid of [...rooms.keys()]) {
    const room = rooms.get(rid);
    if (!room) continue;
    if (room.state === "countdown") {
      if (now >= room.countdownAt) {
        room.state = "racing"; room.raceStartAt = now;
        room.raceEndAt = room.timeLimitMs > 0 ? now + room.timeLimitMs : 0;
        for (const { p } of roomMembers(rid)) { p.lap = 0; p.prog = 0; p.finished = false; p.finishTime = 0; }
        broadcastRoomList();
      }
      broadcastRoom(rid);
    } else if (room.state === "racing") {
      if (room.raceEndAt > 0 && now >= room.raceEndAt) endRoomRace(rid);
      else broadcastRoom(rid);
    }
  }
  broadcastRoomList(); // 브라우저 방 목록 라이브 갱신
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
  const byMode = { survival: [], racing: [] };
  const byRoom = new Map(); // roomId -> entries (프로는 같은 방끼리만 본다)

  for (const [id, p] of players) {
    if (!p.active || !p.state) continue;
    const entry = {
      id, name: p.name,
      x: p.state.x, y: p.state.y, angle: p.state.angle,
      drifting: p.state.drifting,
      teleport: !!p.state.teleport,
      invuln: now < (p.invulnUntil || 0),
    };
    if (p.mode === "pro") {
      if (p.roomId != null) {
        if (!byRoom.has(p.roomId)) byRoom.set(p.roomId, []);
        byRoom.get(p.roomId).push(entry);
      }
    } else {
      byMode[p.mode].push(entry);
    }
  }

  for (const [, p] of players) {
    if (!p.active) continue;
    let arr;
    if (p.mode === "pro") arr = (p.roomId != null) ? (byRoom.get(p.roomId) || []) : [];
    else arr = byMode[p.mode];
    send(p, { type: "snapshot", st: now, players: arr });
  }

  for (const [, p] of players) {
    if (p.state) p.state.teleport = false;
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Car game server running at http://localhost:${PORT}`);
});
