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
const TICK_RATE = 30;       // 초당 스냅샷 브로드캐스트 횟수
const COLLISION_HZ = 60;    // 초당 충돌 판정 횟수 (브로드캐스트보다 잦게 → 터널링 완화)

// 판정용 월드/차량 상수 (클라이언트 game.js 의 값과 반드시 일치)
const MAP_SIZE = 5000;
const CAR_LEN = 38;
const CAR_WID = 18;
const INVULN_MS = 1500;     // 부활 후 무적 시간 (이 동안 죽지도 죽이지도 못함)
const GRACE_MS = 500;       // 부활 직후 클라이언트의 옛 위치 전송을 무시하는 시간
const TELEPORT_DIST = 200;  // 한 틱에 이 이상 움직이면 텔레포트로 간주(스윕 생략)

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
// id -> { ws, state }   state = { x, y, angle, drifting }
const players = new Map();

wss.on("connection", (ws) => {
  const id = nextId++;
  players.set(id, { ws, state: null });

  // heartbeat : 클라이언트가 살아있는지 추적 (프록시가 유휴 연결을 끊는 것 방지)
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // 접속한 클라이언트에게 자신의 id 를 알려준다
  ws.send(JSON.stringify({ type: "welcome", id }));
  console.log(`[+] player ${id} connected (total ${players.size})`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "state") {
      const p = players.get(id);
      if (!p) return;
      // 부활 직후 유예 시간 동안엔 클라이언트가 아직 텔레포트를 반영하기 전
      // 옛 위치를 보낼 수 있으므로 무시한다(서버가 정한 부활 위치 유지).
      if (Date.now() < (p.graceUntil || 0)) return;
      // 이동은 클라이언트 권위 — 위치는 신뢰해 저장(충돌 판정만 서버가 함)
      p.state = {
        x: msg.x, y: msg.y, angle: msg.angle,
        drifting: !!msg.drifting,
        teleport: !!msg.teleport, // 벽 리스폰 등으로 순간이동했음을 알림
      };
    }
  });

  ws.on("close", () => {
    players.delete(id);
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

// 다른 플레이어들로부터 가장 멀리 떨어진 부활 위치를 고른다(서버가 모든 좌표를 앎)
function pickSpawn(selfId) {
  const margin = 250, safe = 700;
  let best = { x: MAP_SIZE / 2, y: MAP_SIZE / 2 }, bestD = -1;
  for (let i = 0; i < 30; i++) {
    const x = margin + Math.random() * (MAP_SIZE - 2 * margin);
    const y = margin + Math.random() * (MAP_SIZE - 2 * margin);
    let minD = Infinity;
    for (const [id, p] of players) {
      if (id === selfId || !p.state) continue;
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
function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const [, p] of players) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

// 사망 처리 : 부활 위치 결정 → 본인에게 통지 → 모두에게 폭발 통지
function killPlayer(victimId, victim, killerId) {
  const deathX = victim.state.x, deathY = victim.state.y;
  const spawn = pickSpawn(victimId);

  // 서버 상태를 부활 위치로 즉시 이동 + 무적/유예 부여
  victim.state.x = spawn.x;
  victim.state.y = spawn.y;
  victim.state.angle = spawn.angle;
  victim.state.teleport = true;       // 다음 스냅샷에서 클라들이 슬라이드 없이 스냅
  victim.invulnUntil = Date.now() + INVULN_MS;
  victim.graceUntil = Date.now() + GRACE_MS;
  victim.prevHead = headOf(victim.state); // 스윕 궤적 리셋(텔레포트 경로 오판 방지)

  // 본인에게 "여기서 부활하라" 통지 (권위 위치)
  send(victim, { type: "death", x: spawn.x, y: spawn.y, angle: spawn.angle });
  // 모두에게 폭발 통지 (죽은 자리, 죽은 차 색은 클라가 victimId 로 계산)
  broadcast({ type: "killed", victimId, killerId, x: deathX, y: deathY });
}

// 충돌 판정 1틱
function runCollisions() {
  const now = Date.now();

  // 판정 대상 : 상태가 있고 무적이 아닌 플레이어
  const live = [];
  for (const [id, p] of players) {
    if (!p.state) continue;
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

      if (aHitB && !bHitA) { killPlayer(B.id, B.p, A.id); dead.add(B.id); }
      else if (bHitA && !aHitB) { killPlayer(A.id, A.p, B.id); dead.add(A.id); }
      // 둘 다 명중 = 정면 무승부 → 아무도 죽지 않음
    }
  }

  // 다음 틱 스윕을 위해 머리 위치 갱신
  for (const [, p] of players) {
    if (p.curHead) p.prevHead = p.curHead;
  }
}

setInterval(runCollisions, 1000 / COLLISION_HZ);

// --- 브로드캐스트 루프 ------------------------------------------------------
//  모든 플레이어의 최신 상태를 모아 30Hz 로 전송한다.
setInterval(() => {
  const now = Date.now();
  const snapshot = [];
  for (const [id, p] of players) {
    if (!p.state) continue;
    snapshot.push({
      id,
      x: p.state.x, y: p.state.y, angle: p.state.angle,
      drifting: p.state.drifting,
      teleport: !!p.state.teleport,       // 1회성 스냅 신호
      invuln: now < (p.invulnUntil || 0), // 원격 무적 표시(깜빡임)용
    });
  }
  broadcast({ type: "snapshot", players: snapshot });

  // teleport 는 1회성 → 보낸 뒤 해제
  for (const [, p] of players) {
    if (p.state) p.state.teleport = false;
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Car game server running at http://localhost:${PORT}`);
});
