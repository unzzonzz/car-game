"use strict";

/* =============================================================================
 *  멀티플레이어 서버
 * -----------------------------------------------------------------------------
 *  역할 1) 정적 파일(index.html, style.css, game.js) 서빙
 *  역할 2) WebSocket 으로 플레이어 상태 릴레이
 *
 *  네트워크 모델 : "클라이언트 권위 + 서버 릴레이"
 *  - 각 클라이언트가 자기 차량의 물리를 계산하고 상태(x, y, angle)를 보낸다.
 *  - 서버는 최신 상태만 저장하고, 30Hz 로 전체 스냅샷을 모두에게 브로드캐스트한다.
 *  - 서버는 물리를 계산하지 않으므로 단순/가벼움. (캐주얼 게임에 충분)
 *
 *  실행 :  node server.js   →  http://localhost:3000
 * ========================================================================== */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const TICK_RATE = 30; // 초당 스냅샷 브로드캐스트 횟수

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

  // 접속한 클라이언트에게 자신의 id 를 알려준다
  ws.send(JSON.stringify({ type: "welcome", id }));
  console.log(`[+] player ${id} connected (total ${players.size})`);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === "state") {
      const p = players.get(id);
      if (p) {
        // 신뢰하지 않는 값은 저장만 하고 검증은 생략(릴레이 모델)
        p.state = {
          x: msg.x, y: msg.y, angle: msg.angle,
          drifting: !!msg.drifting,
          name: msg.name,
        };
      }
    }
  });

  ws.on("close", () => {
    players.delete(id);
    console.log(`[-] player ${id} disconnected (total ${players.size})`);
  });

  ws.on("error", () => {}); // 비정상 종료 무시
});

// --- 브로드캐스트 루프 ------------------------------------------------------
//  모든 플레이어의 최신 상태를 모아 30Hz 로 전송한다.
setInterval(() => {
  const snapshot = [];
  for (const [id, p] of players) {
    if (p.state) snapshot.push({ id, ...p.state });
  }
  const payload = JSON.stringify({ type: "snapshot", players: snapshot });

  for (const [, p] of players) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => {
  console.log(`Car game server running at http://localhost:${PORT}`);
});
