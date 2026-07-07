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

// .env 파일이 있으면 환경변수로 로드(로컬/자체서버용). 없거나 dotenv 미설치여도 무해.
//  운영 플랫폼(Render 등)은 대시보드 환경변수를 쓰므로 .env 없이도 동작한다.
try { require("dotenv").config(); } catch {}

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { Redis } = require("@upstash/redis");

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

/* =============================================================================
 *  안티치트 (서버 권위) — 콘솔에서 CAR 를 조작해도 서버가 결과를 안 믿게 한다.
 *   1) 위치 스트림의 이동 속도가 물리 한계를 넘으면(순간이동/초고속) 플래그
 *   2) 프로 랩/완주는 "단조 +1 & 최소 랩 시간 & 미플래그" 일 때만 인정
 *   3) 타임어택 기록은 "모드 체류 벽시계 시간" 하한 + 미플래그로만 인정
 *  ※ 완전한 서버 권위(체크포인트 기반)는 트랙 지오메트리 포팅이 필요 — 후속 단계.
 * ========================================================================== */
const MAX_LEGIT_PXS = 2700;   // 차 물리 최고속 ≈2667px/s (game.js maxSpeed 1200km/h × 8/3.6)
const SPEED_LIMIT = MAX_LEGIT_PXS * 1.6; // 구간 평균속도 상한 (지터/외삽 여유 60%)
const JUMP_CAP = 2000;        // 한 패킷 변위 상한 — 단발 순간이동 즉시 감지
const SPEED_WINDOW_MS = 300;  // 평균속도 평가 창
const FLAG_HOLD_MS = 3000;    // 위반 후 이 시간 동안 랩/기록 인정 보류
const MIN_LAP_MS = 2500;      // 프로 한 바퀴 최소 소요(타임어택 하한 3s 보다 짧게 잡아 오탐 방지)

// 이동 감시 기준점 리셋 (모드 진입/레이스 시작 등 "정상 순간이동" 시점에 호출)
function resetMotion(p) {
  p.lastPos = null;          // 직전 위치 {x,y,t}
  p.spdAcc = 0; p.spdT0 = 0; // 구간 누적 이동거리 / 창 시작 시각
  p.lastLapT = Date.now();   // 마지막으로 랩을 인정한 시각
}
// 비정상 이동 감지 → 잠시 랩/기록 인정 보류 + 로그 (첫 위반과 20회마다만 출력)
function flagCheat(p, now, reason) {
  p.flagUntil = now + FLAG_HOLD_MS;
  p.cheatFlags = (p.cheatFlags || 0) + 1;
  if (p.cheatFlags === 1 || p.cheatFlags % 20 === 0) {
    console.warn(`[anticheat] player "${p.name || "?"}" flagged (${reason}) x${p.cheatFlags}`);
  }
}

/* =============================================================================
 *  서버 권위 충돌(진짜 밀치기) — 클라가 보고한 위치+속도로 서버가 직접 판정한다.
 *   · 히트박스: 자동차 실제 사각형(OBB), 분리축정리(SAT)로 겹침·법선 계산
 *   · 반응: 등질량 2체 충돌 임펄스(운동량 전달 + 반발) → 양쪽에 "bump" 로 통지
 *   → 두 클라가 같은 임펄스를 받으므로, 들이받으면 상대가 실제로 밀려나고 일관된다.
 *   (위치 겹침 방지는 클라가 즉시 처리, 속도/운동량 변화는 서버가 권위)
 * ========================================================================== */
const COLLISION_ENABLED = false; // ★ 물리 충돌/밀치기 임시 OFF — true 로 바꾸면 다시 켜짐
const CAR_HL = 27.6, CAR_HW = 13.2; // 히트박스 반길이/반폭 = 시각 차체 크기(game.js drawCar 1.15배 반영, L=38)
const BUMP_RESTITUTION = 0.3;    // 반발계수(0=완전 비탄성, 1=완전 탄성)
const BUMP_COOLDOWN_MS = 110;    // 같은 쌍 재충돌 최소 간격(임펄스 스팸 방지)
const BUMP_MIN_J = 12;           // 이보다 작은 임펄스는 무시(미세 접촉)
const bumpCooldowns = new Map(); // "idA:idB" -> 만료시각
const pairKey = (a, b) => (a < b ? a + ":" + b : b + ":" + a);

// 두 자동차 사각형(OBB)의 최소 분리 벡터(MTV). 겹치면 {nx,ny,depth}(A→밀려날 방향), 아니면 null.
function carMTV(ax, ay, aAng, bx, by, bAng) {
  const aC = Math.cos(aAng), aS = Math.sin(aAng), bC = Math.cos(bAng), bS = Math.sin(bAng);
  const axes = [{ x: aC, y: aS }, { x: -aS, y: aC }, { x: bC, y: bS }, { x: -bS, y: bC }];
  const dx = bx - ax, dy = by - ay;
  let minOv = Infinity, nx = 0, ny = 0;
  for (const ax0 of axes) {
    const aR = CAR_HL * Math.abs(ax0.x * aC + ax0.y * aS) + CAR_HW * Math.abs(-ax0.x * aS + ax0.y * aC);
    const bR = CAR_HL * Math.abs(ax0.x * bC + ax0.y * bS) + CAR_HW * Math.abs(-ax0.x * bS + ax0.y * bC);
    const proj = dx * ax0.x + dy * ax0.y, ov = aR + bR - Math.abs(proj);
    if (ov <= 0) return null;                       // 분리축 존재 → 충돌 아님
    if (ov < minOv) { minOv = ov; const s = proj >= 0 ? -1 : 1; nx = ax0.x * s; ny = ax0.y * s; }
  }
  return { nx, ny, depth: minOv };
}

// 한 그룹(같은 방/모드에서 충돌 대상인 차들)의 쌍별 충돌을 풀어 각 차에 임펄스 통지
function resolveCarCollisions(list, now) {
  const impulses = new Map(); // id -> {vx,vy}
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j], sa = A.p.state, sb = B.p.state;
      const mtv = carMTV(sa.x, sa.y, sa.angle, sb.x, sb.y, sb.angle);
      if (!mtv) continue;
      const key = pairKey(A.id, B.id);
      if (now < (bumpCooldowns.get(key) || 0)) continue;      // 쿨다운 중
      const nx = mtv.nx, ny = mtv.ny;
      const vrel = ((sa.vx || 0) - (sb.vx || 0)) * nx + ((sa.vy || 0) - (sb.vy || 0)) * ny;
      if (vrel >= 0) continue;                                 // 멀어지는 중 → 반응 없음
      let J = -(1 + BUMP_RESTITUTION) * vrel / 2;              // 등질량 임펄스 스칼라
      if (J < BUMP_MIN_J) continue;                            // 미세 접촉 무시
      if (J > MAX_LEGIT_PXS) J = MAX_LEGIT_PXS;                // 과도 임펄스 상한(치트 방어)
      const ia = impulses.get(A.id) || { vx: 0, vy: 0 }; ia.vx += J * nx; ia.vy += J * ny; impulses.set(A.id, ia);
      const ib = impulses.get(B.id) || { vx: 0, vy: 0 }; ib.vx -= J * nx; ib.vy -= J * ny; impulses.set(B.id, ib);
      bumpCooldowns.set(key, now + BUMP_COOLDOWN_MS);
    }
  }
  for (const [id, imp] of impulses) {
    const p = players.get(id);
    if (!p || !p.state) continue;
    p.state.vx = (p.state.vx || 0) + imp.vx;                  // 서버 저장 속도에도 반영(다음 틱 안정화)
    p.state.vy = (p.state.vy || 0) + imp.vy;
    send(p, { type: "bump", vx: Math.round(imp.vx), vy: Math.round(imp.vy) });
  }
}

// 프로 맵 풀 : 서버가 인덱스만 정하고, 클라가 같은 인덱스로 동일 트랙을 생성한다.
//  (game.js 의 PRO_COURSES = A-1~B-3 6종과 일치. 실제 선택 범위는 NAMED_COURSES)
const PRO_RECIPE_COUNT = 9;

// =============================================================================
//  계정 / 로그인 (users.json 영속 저장, Node 내장 crypto 로 비밀번호 해시)
// -----------------------------------------------------------------------------
//  - 회원가입: 아이디 / 닉네임 / 비밀번호(숫자 4자리)
//  - 로그인: 아이디 + 비밀번호 → 토큰 발급(메모리). 토큰으로 새로고침 시 자동 로그인.
//  - 아이디 seungchan0911 = 관리자(금색 차).
//  - 통계: 프로 우승 수(2명 이상일 때), 프로 플레이 수.
// =============================================================================
const ADMIN_ID = "seungchan0911";
const GOLD = "#ffd94d";
const USERS_FILE = path.join(__dirname, "users.json");

// 영속 저장 : 환경변수가 있으면 Upstash Redis, 없으면 로컬 users.json 파일로 폴백.
//  메모리 캐시(users)를 두고 동기 읽기 + 변경 시 write-through 한다.
const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = useRedis
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })
  : null;
const USER_SET = "cargame:userids";
const userKey = (id) => "cargame:user:" + id;

let users = {}; // 메모리 캐시 (id -> {id,nickname,salt,hash,proWins,proPlays})

// 시작 시 저장소에서 계정을 캐시로 적재
async function hydrateUsers() {
  if (!useRedis) {
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { users = {}; }
    return;
  }
  try {
    const ids = (await redis.smembers(USER_SET)) || [];
    for (const id of ids) {
      const u = await redis.get(userKey(id)); // @upstash/redis 가 JSON 자동 파싱
      if (u) users[id] = u;
    }
    console.log(`[redis] loaded ${Object.keys(users).length} users`);
  } catch (e) {
    console.error("[redis] hydrate failed:", e.message);
  }
}

let saveTimer = null;
// 한 명의 계정 변경을 영속화 (Redis 또는 파일)
function persistUser(id) {
  if (!users[id]) return;
  if (useRedis) {
    redis.set(userKey(id), users[id]).catch((e) => console.error("[redis] set:", e.message));
    redis.sadd(USER_SET, id).catch(() => {});
  } else {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => fs.writeFile(USERS_FILE, JSON.stringify(users), () => {}), 200);
  }
}
function hashPw(pw, salt) { return crypto.scryptSync(String(pw), salt, 32).toString("hex"); }
// 비밀번호 검증 : 평문 저장(신규)이 있으면 그걸로, 없으면 레거시 해시(salt+hash)와 비교.
//  → 예전에 해시로 가입한 계정도 그대로 로그인되고, 로그인 성공 시 평문으로 옮겨진다.
function verifyPassword(u, pw) {
  if (u.password != null) return String(pw) === String(u.password);
  if (u.salt && u.hash) return hashPw(pw, u.salt) === u.hash;
  return false;
}
// 새 비밀번호 정책 : 8~64자, 공백 없음, 영문·숫자·특수기호를 각각 1개 이상 포함.
function validPassword(pw) {
  pw = String(pw || "");
  return pw.length >= 8 && pw.length <= 64 && !/\s/.test(pw)
    && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}
const PW_RULE_MSG = "비밀번호는 8자 이상, 영문·숫자·특수기호를 모두 포함해야 합니다.";

// 타임어택 TOP10 : 각 유저의 개인 최고기록 필드에서 파생 (모드별로 필드가 다름).
//  → 로그인 유저만 기록되고, 유저당 최고 1개만 랭크된다.
//  연습코스는 각자 새 컬럼에 기록한다 : A-1~3=bestA1/A2/A3, B-1~3=bestB1/B2/B3.
//  옛 기록(bestTime=자유, bestTimeHard=하드)은 건드리지 않고 그대로 보존한다.
const RECORD_FIELD = { a1: "bestA1", a2: "bestA2", a3: "bestA3", racing: "bestB1", hard: "bestB2", serp: "bestB3", c1: "bestC1", c2: "bestC2", c3: "bestC3" };
function topRecordsList(field) {
  const arr = [];
  for (const id in users) {
    const u = users[id];
    if (u[field]) arr.push({ name: u.nickname, ms: u[field] });
  }
  arr.sort((a, b) => a.ms - b.ms);
  return arr.slice(0, 10);
}
function broadcastRecords(mode) {
  const field = RECORD_FIELD[mode];
  if (!field) return;
  const payload = JSON.stringify({ type: "topRecords", records: topRecordsList(field) });
  for (const [, p] of players) {
    if (p.active && p.mode === mode && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

// 토큰 : users.token 에 영속 저장 → 서버 재시작해도 자동 로그인 유지(세션 만료 없음).
const tokens = new Map(); // token -> userId (users 에서 복원)
function rebuildTokens() {
  tokens.clear();
  for (const id in users) if (users[id].token) tokens.set(users[id].token, id);
}

// 로그인 확정 : p 에 계정 정보 부착 + authOk 통지
function loginPlayer(p, userId) {
  const u = users[userId];
  if (!u) return;
  if (!u.token) { u.token = crypto.randomBytes(16).toString("hex"); persistUser(userId); } // 영구 토큰
  tokens.set(u.token, userId);
  p.account = { userId, nickname: u.nickname, isAdmin: userId === ADMIN_ID };
  p.isAdmin = p.account.isAdmin;
  p.name = u.nickname;
  p.loginAt = Date.now();
  if (u.color) p.color = u.color; // 계정에 저장된 차 색 → 즉시 릴레이에 반영
  u.lastLogin = Date.now(); // "마지막 접속" = 마지막 활동 시각(접속 순간)
  persistUser(userId);
  send(p, {
    type: "authOk", id: userId, nickname: u.nickname, isAdmin: p.isAdmin,
    token: u.token, proWins: u.proWins || 0, proPlays: u.proPlays || 0,
    bestA1Ms: u.bestA1 || 0, bestA2Ms: u.bestA2 || 0, bestA3Ms: u.bestA3 || 0,
    bestMs: u.bestB1 || 0, bestHardMs: u.bestB2 || 0, bestSerpMs: u.bestB3 || 0,
    bestC1Ms: u.bestC1 || 0, bestC2Ms: u.bestC2 || 0, bestC3Ms: u.bestC3 || 0, totalTime: liveTotalTime(p),
    color: u.color || null, settings: u.settings || null, // 계정에 저장된 차 색 + 설정 복원
    lastLogin: u.lastLogin, // 마지막 활동 시각
  });
}

// 접속 시간을 평생 누적(user.totalTime)에 반영하고 기준시각 리셋
function flushConnectedTime(p) {
  if (!p.account || !p.loginAt) return;
  const u = users[p.account.userId];
  if (!u) return;
  u.totalTime = (u.totalTime || 0) + (Date.now() - p.loginAt);
  p.loginAt = Date.now();
  u.lastLogin = Date.now(); // "마지막 접속" = 마지막 활동 시각 : 접속 중이면 계속 최신으로 갱신
  persistUser(p.account.userId);
}

// 현재 진행 중인 세션까지 포함한 "실시간 평생 접속 시간".
//  클라는 이 값을 수신 시각 기준으로 라이브 증가시키므로 이중 계산이 없다.
function liveTotalTime(p) {
  if (!p.account) return 0;
  const u = users[p.account.userId];
  if (!u) return 0;
  return (u.totalTime || 0) + (p.loginAt ? (Date.now() - p.loginAt) : 0);
}

// 통계(우승/플레이/최고기록/누적접속) 전송
function sendStats(p) {
  if (!p.account) return;
  const u = users[p.account.userId];
  if (!u) return;
  send(p, { type: "stats", proWins: u.proWins || 0, proPlays: u.proPlays || 0, bestA1Ms: u.bestA1 || 0, bestA2Ms: u.bestA2 || 0, bestA3Ms: u.bestA3 || 0, bestMs: u.bestB1 || 0, bestHardMs: u.bestB2 || 0, bestSerpMs: u.bestB3 || 0, bestC1Ms: u.bestC1 || 0, bestC2Ms: u.bestC2 || 0, bestC3Ms: u.bestC3 || 0, totalTime: liveTotalTime(p), lastLogin: u.lastLogin || 0 });
}

// --- 정적 파일 서버 ---------------------------------------------------------
const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
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

/* =============================================================================
 *  바이너리 프로토콜 — 고빈도 메시지(클라→서버 state / 서버→클라 snapshot)만 바이너리(빅엔디안).
 *   나머지(chat/auth/room/race 등)는 JSON. state≈22B(JSON ~110), snapshot≈27B/명(JSON ~140) → ~5배↓.
 * ========================================================================== */
const MSG_STATE = 1, MSG_SNAPSHOT = 2;
const A2I = 32767 / Math.PI; // 각도 ↔ int16 스케일
const clampI16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function hexToRgb(hex) { if (typeof hex !== "string" || hex[0] !== "#" || hex.length < 7) return [232, 96, 76]; const n = parseInt(hex.slice(1, 7), 16); if (!Number.isFinite(n)) return [232, 96, 76]; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return "#" + (((1 << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)).toString(16)).slice(1); }
function sendBin(p, buf) { if (p.ws.readyState === p.ws.OPEN) p.ws.send(buf); }

// 클라 → 서버 state 디코딩 (Buffer → 필드 객체)
function decodeState(buf) {
  let o = 1;
  const x = buf.readInt16BE(o); o += 2;
  const y = buf.readInt16BE(o); o += 2;
  const angle = buf.readInt16BE(o) / A2I; o += 2;
  const vx = buf.readInt16BE(o); o += 2;
  const vy = buf.readInt16BE(o); o += 2;
  const f = buf.readUInt8(o); o += 1;
  const r = buf.readUInt8(o), g = buf.readUInt8(o + 1), b = buf.readUInt8(o + 2); o += 3;
  const s = { x, y, angle, vx, vy, drifting: !!(f & 1), teleport: !!(f & 2), collide: !!(f & 4), color: rgbToHex(r, g, b) };
  if (f & 8) { s.lap = buf.readUInt8(o); o += 1; s.prog = buf.readUInt16BE(o) / 1000; o += 2; s.lapMs = buf.readUInt32BE(o); o += 4; }
  return s;
}
// 서버 → 클라 snapshot 인코딩 (entries → Buffer). per player 19B + 이름 UTF-8.
function encodeSnapshot(st, entries) {
  const nbs = entries.map((e) => Buffer.from(e.name || "", "utf8").subarray(0, 60));
  let size = 11; for (const nb of nbs) size += 19 + nb.length;
  const buf = Buffer.allocUnsafe(size); let o = 0;
  buf.writeUInt8(MSG_SNAPSHOT, o); o += 1;
  buf.writeDoubleBE(st, o); o += 8;
  buf.writeUInt16BE(entries.length, o); o += 2;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], nb = nbs[i];
    buf.writeUInt32BE(e.id >>> 0, o); o += 4;
    buf.writeInt16BE(clampI16(Math.round(e.x)), o); o += 2;
    buf.writeInt16BE(clampI16(Math.round(e.y)), o); o += 2;
    buf.writeInt16BE(Math.round(normAngle(e.angle) * A2I), o); o += 2;
    buf.writeInt16BE(clampI16(Math.round(e.vx || 0)), o); o += 2;
    buf.writeInt16BE(clampI16(Math.round(e.vy || 0)), o); o += 2;
    buf.writeUInt8((e.drifting ? 1 : 0) | (e.teleport ? 2 : 0) | (e.invuln ? 4 : 0) | (e.admin ? 8 : 0), o); o += 1;
    const [r, g, b] = hexToRgb(e.color); buf.writeUInt8(r, o); buf.writeUInt8(g, o + 1); buf.writeUInt8(b, o + 2); o += 3;
    buf.writeUInt8(nb.length, o); o += 1; nb.copy(buf, o); o += nb.length;
  }
  return buf;
}

// state 처리 (JSON/바이너리 공통) — 이동 정합성 감시 + 상태 저장 + 프로 랩 게이팅.
function applyState(p, m) {
  if (!p.active) return;
  if (Date.now() < (p.graceUntil || 0)) return;
  const x = Number(m.x), y = Number(m.y), ang = Number(m.angle);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ang)) return; // NaN 주입 차단

  // --- 이동 정합성 감시 : 순간이동/초고속이면 플래그(랩·기록 인정 보류) ---
  const now = Date.now();
  if (p.lastPos) {
    const seg = Math.hypot(x - p.lastPos.x, y - p.lastPos.y);
    if (seg > JUMP_CAP) flagCheat(p, now, "jump"); // 단발 순간이동
    if (p.spdT0 === 0) p.spdT0 = p.lastPos.t;
    p.spdAcc += seg;
    const winMs = now - p.spdT0;
    if (winMs >= SPEED_WINDOW_MS) {              // 창이 차면 평균속도 평가
      if (p.spdAcc / (winMs / 1000) > SPEED_LIMIT) flagCheat(p, now, "speed");
      p.spdAcc = 0; p.spdT0 = now;
    }
  }
  p.lastPos = { x, y, t: now };
  const flagged = now < (p.flagUntil || 0);

  // 커스텀 차 색 (형식 검증 후 저장 → 스냅샷으로 릴레이)
  if (typeof m.color === "string" && /^#[0-9a-fA-F]{6}$/.test(m.color)) p.color = m.color;
  // 속도(vx,vy) — 서버 권위 충돌 임펄스 계산용. 최고속 초과분은 클램프(과충격 치트 방어).
  let vx = Number(m.vx) || 0, vy = Number(m.vy) || 0;
  const sp = Math.hypot(vx, vy);
  if (sp > MAX_LEGIT_PXS) { const k = MAX_LEGIT_PXS / sp; vx *= k; vy *= k; }
  p.state = { x, y, angle: ang, drifting: !!m.drifting, teleport: !!m.teleport, vx, vy };
  p.collide = !!m.collide && !flagged; // 충돌 대상 여부(플래그된 차는 충돌 제외)

  // 프로 레이싱 : 랩/완주는 서버가 게이팅 (클라가 보낸 lap 을 그대로 믿지 않는다)
  if (p.mode === "pro" && p.roomId != null && typeof m.lap === "number") {
    const room = rooms.get(p.roomId);
    if (room && room.state === "racing") {
      const claimed = Math.floor(m.lap);
      if (claimed >= p.lap + 1 && !flagged && (now - (p.lastLapT || 0)) >= MIN_LAP_MS) { p.lap += 1; p.lastLapT = now; }
      if (typeof m.prog === "number") p.prog = Math.max(p.lap, Math.min(p.lap + 1, m.prog));
      if (typeof m.lapMs === "number" && m.lapMs >= 0) p.lapMs = m.lapMs;
      if (!p.finished && p.lap >= room.laps) {
        p.finished = true; p.finishTime = Date.now();
        const cand = Date.now() + END_TIMER_MS;
        room.raceEndAt = room.raceEndAt > 0 ? Math.min(room.raceEndAt, cand) : cand;
        broadcastRoom(p.roomId);
      }
    }
  }
}

// --- WebSocket 서버 ---------------------------------------------------------
const wss = new WebSocketServer({ server });

let nextId = 1;
// id -> { ws, state, active, mode, name, invulnUntil, graceUntil, prevHead }
//  active=false : 메뉴 화면(미입장). 스냅샷/판정에서 제외된다.
const players = new Map();

// 최근 채팅 보관 (새 접속자에게 즉시 전송)
const CHAT_HISTORY_MAX = 20;
const chatHistory = [];

// 채팅 전체를 append-only 로그(JSONL)에 영구 저장 : 시간 t / 아이디 uid / 닉 name / 메시지 text / admin.
//  인게임 채팅창은 최근 20개만 보여주지만, 이 파일엔 "몽땅" 남는다. → view-chat.js 로 열람.
const CHAT_LOG_FILE = path.join(__dirname, "chat-log.jsonl");
function logChat(p, name, text, t, admin) {
  const entry = { t, uid: p.account ? p.account.userId : null, name, text, admin: !!admin };
  fs.appendFile(CHAT_LOG_FILE, JSON.stringify(entry) + "\n", (err) => { if (err) console.error("[chat-log]", err.message); });
}

wss.on("connection", (ws) => {
  const id = nextId++;
  players.set(id, { ws, state: null, active: false, mode: "survival", name: "", roomId: null, account: null, isAdmin: false });

  // heartbeat : 클라이언트가 살아있는지 추적 (프록시가 유휴 연결을 끊는 것 방지)
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // 접속한 클라이언트에게 자신의 id + 최근 채팅을 알려준다
  ws.send(JSON.stringify({ type: "welcome", id }));
  if (chatHistory.length) ws.send(JSON.stringify({ type: "chatHistory", messages: chatHistory }));
  console.log(`[+] player ${id} connected (total ${players.size})`);

  ws.on("message", (raw, isBinary) => {
    // 바이너리 프레임 = 고빈도 state (JSON 파싱 없이 바로 디코딩)
    if (isBinary) {
      const pb = players.get(id);
      if (pb && raw.length && raw[0] === MSG_STATE) applyState(pb, decodeState(raw));
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const p = players.get(id);
    if (!p) return;

    if (msg.type === "signup") {
      const idv = (msg.id || "").trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(idv)) { send(p, { type: "authError", reason: "아이디는 영문/숫자 3~20자여야 합니다." }); return; }
      if (users[idv]) { send(p, { type: "authError", reason: "이미 존재하는 아이디입니다." }); return; }
      if (!validPassword(msg.password)) { send(p, { type: "authError", reason: PW_RULE_MSG }); return; }
      users[idv] = { id: idv, nickname: sanitizeName(msg.nickname), password: String(msg.password), proWins: 0, proPlays: 0 };
      persistUser(idv);
      loginPlayer(p, idv);
      return;

    } else if (msg.type === "login") {
      const idv = (msg.id || "").trim();
      const u = users[idv];
      if (!u || !verifyPassword(u, msg.password || "")) { send(p, { type: "authError", reason: "아이디 또는 비밀번호가 틀렸습니다." }); return; }
      // 레거시 해시 계정은 로그인 성공 시 평문으로 마이그레이션(콘솔에서 바로 보이도록)
      if (u.password == null) { u.password = String(msg.password || ""); delete u.salt; delete u.hash; persistUser(idv); }
      loginPlayer(p, idv);
      return;

    } else if (msg.type === "auth") {
      const uid = tokens.get(msg.token);
      if (uid && users[uid]) loginPlayer(p, uid);
      else send(p, { type: "authError", reason: "", silent: true }); // 토큰 만료 → 조용히
      return;

    } else if (msg.type === "logout") {
      flushConnectedTime(p); // 지금까지의 접속 시간 누적 반영
      if (p.account) {
        const u = users[p.account.userId];
        if (u && u.token) { tokens.delete(u.token); u.token = undefined; persistUser(p.account.userId); } // 토큰 무효화
      }
      p.account = null; p.isAdmin = false; p.loginAt = 0;
      return;

    } else if (msg.type === "changePassword") {
      if (!p.account) { send(p, { type: "pwError", reason: "로그인이 필요합니다." }); return; }
      const u = users[p.account.userId];
      if (!u) { send(p, { type: "pwError", reason: "계정을 찾을 수 없습니다." }); return; }
      if (!verifyPassword(u, msg.current || "")) { send(p, { type: "pwError", reason: "현재 비밀번호가 틀렸습니다." }); return; }
      if (!validPassword(msg.next)) { send(p, { type: "pwError", reason: PW_RULE_MSG }); return; }
      u.password = String(msg.next); delete u.salt; delete u.hash;
      persistUser(p.account.userId);
      send(p, { type: "pwOk" });
      return;

    } else if (msg.type === "savePrefs") {
      // 계정별 차 색 + 설정 영속 저장 (로그인 유저만, 값 검증 후 저장)
      if (!p.account) return;
      const u = users[p.account.userId];
      if (!u) return;
      if (typeof msg.color === "string" && /^#[0-9a-fA-F]{6}$/.test(msg.color)) { u.color = msg.color; p.color = msg.color; }
      const s = msg.settings;
      if (s && typeof s === "object") {
        const clean = (u.settings && typeof u.settings === "object") ? { ...u.settings } : {};
        if (typeof s.volume === "number" && isFinite(s.volume)) clean.volume = Math.min(1, Math.max(0, s.volume));
        if (typeof s.fov === "number" && isFinite(s.fov)) clean.fov = Math.min(100, Math.max(40, Math.round(s.fov)));
        if (typeof s.showOthers === "boolean") clean.showOthers = s.showOthers;
        if (typeof s.showSpeed === "boolean") clean.showSpeed = s.showSpeed;
        if (["tl", "tr", "bl", "br"].includes(s.hudMm)) clean.hudMm = s.hudMm;
        if (["tl", "tr", "bl", "br"].includes(s.hudChat)) clean.hudChat = s.hudChat;
        u.settings = clean;
      }
      persistUser(p.account.userId);
      return;
    }

    if (msg.type === "join") {
      p.name = p.account ? p.account.nickname : sanitizeName(msg.name);
      const mode = (msg.mode === "racing") ? "racing"
        : (msg.mode === "hard") ? "hard"
        : (msg.mode === "serp") ? "serp"
        : (msg.mode === "a1") ? "a1"
        : (msg.mode === "a2") ? "a2"
        : (msg.mode === "a3") ? "a3"
        : (msg.mode === "c1") ? "c1"
        : (msg.mode === "c2") ? "c2"
        : (msg.mode === "c3") ? "c3"
        : (msg.mode === "test") ? "test"
        : (msg.mode === "pro") ? "pro" : "survival";

      if (mode === "pro") {
        // 프로 진입 = 방 목록 화면(브라우저). 방은 따로 만들거나 골라 들어간다.
        p.mode = "pro"; p.active = true; p.roomId = null;
        resetMotion(p);
        send(p, { type: "roomList", rooms: roomSummaries() });
        console.log(`[>] player ${id} entered pro lobby browser`);
        return;
      }

      p.mode = mode; p.active = true; p.roomId = null;
      resetMotion(p);
      p.taModeSince = Date.now(); // 타임어택 기록 하한 검증 기준(모드 입장 시각)
      if (mode === "survival") {
        const spawn = pickSpawn(id);
        p.state = { x: spawn.x, y: spawn.y, angle: spawn.angle, drifting: false, teleport: true };
        p.prevHead = headOf(p.state);
        p.invulnUntil = Date.now() + INVULN_MS;
        p.graceUntil = Date.now() + GRACE_MS;
        send(p, { type: "spawn", x: spawn.x, y: spawn.y, angle: spawn.angle });
      } else { // racing/hard : 고정 맵. 타임어택 모드는 각자 TOP10 기록도 전송
        p.state = null; p.invulnUntil = 0; p.graceUntil = 0;
        const field = RECORD_FIELD[mode];
        if (field) send(p, { type: "topRecords", records: topRecordsList(field) });
      }
      console.log(`[>] player ${id} joined ${p.mode} as "${p.name}"`);

    } else if (msg.type === "createRoom") {
      if (!p.active || p.mode !== "pro" || p.roomId != null) return;
      const laps = clampInt(msg.laps, 1, 20, 3);
      const maxPlayers = clampInt(msg.maxPlayers, 2, PRO_MAX, 7); // 최소 2명
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
      const name = p.account ? p.account.nickname : (p.active ? p.name : sanitizeName(msg.name));
      const chatMsg = { type: "chat", id, name, text, t: Date.now(), admin: !!p.isAdmin };
      chatHistory.push(chatMsg);
      if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift(); // 인게임 표시는 최근 20개만
      logChat(p, name, text, chatMsg.t, chatMsg.admin);              // 로그 파일엔 몽땅 영구 저장
      broadcastConnected(chatMsg);

    } else if (msg.type === "timeAttack") {
      // 자유/하드 타임어택 기록 제출 → 로그인 유저만, 개인 최고기록 갱신 시 TOP10 반영
      const field = RECORD_FIELD[p.mode]; // racing→bestB1, hard→bestB2, serp→bestB3 (새 컬럼)
      if (!p.active || !field || !p.account) return; // 타임어택 모드 + 로그인 유저만
      const ms = Number(msg.ms);
      if (!Number.isFinite(ms) || ms < 3000 || ms > 600000) return; // 3초~10분 범위만 인정
      const now = Date.now();
      if (now < (p.flagUntil || 0)) { flagCheat(p, now, "record"); return; } // 최근 순간이동/초고속 → 거부
      if (now - (p.taModeSince || now) < ms * 0.7) return; // 모드 체류 벽시계보다 짧은 기록 = 조작
      const u = users[p.account.userId];
      if (!u) return;
      if (!u[field] || Math.round(ms) < u[field]) {
        u[field] = Math.round(ms);
        persistUser(p.account.userId);
        sendStats(p);              // 대시보드 최고기록 갱신
        broadcastRecords(p.mode);  // 해당 모드 TOP10 갱신
      }

    } else if (msg.type === "state") {
      applyState(p, msg); // (구버전/폴백) JSON state — 신규 클라는 바이너리로 보냄
    }
  });

  ws.on("close", () => {
    const pc = players.get(id);
    if (pc) {
      flushConnectedTime(pc); // 접속 종료 시점까지의 접속 시간 누적 반영
      if (pc.mode === "pro" && pc.active && pc.roomId != null) leaveRoom(id, pc);
    }
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
  const counts = { survival: 0, a1: 0, a2: 0, a3: 0, racing: 0, hard: 0, serp: 0, c1: 0, c2: 0, c3: 0, pro: 0, test: 0 };
  for (const [, p] of players) {
    if (p.active && counts[p.mode] !== undefined) counts[p.mode]++;
  }
  const payload = JSON.stringify({ type: "counts", ...counts, total: players.size }); // total = 로비 포함 전체 접속자
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
const NAMED_COURSES = 9;        // 선택 가능한 코스 수 (game.js PRO_COURSES = A-1~C-3, 인덱스 0..8)
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
    id: e.id, name: e.p.name, ready: !!e.p.ready, color: e.p.color, // 차 색(미설정 시 undefined → 클라 id색 폴백)
    lap: e.p.lap || 0, lapMs: e.p.lapMs || 0, finished: !!e.p.finished, rank: i + 1, admin: !!e.p.isAdmin,
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
    canReady: roomMembers(roomId).length >= 2, // 최소 2명부터 준비/시작 가능
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
  p.ready = false; p.lap = 0; p.lapMs = 0; p.prog = 0; p.finished = false; p.finishTime = 0;
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
  if (m.length < 2 || !m.every((e) => e.p.ready)) return; // 최소 2명 + 전원 준비
  room.state = "countdown";
  room.countdownAt = Date.now() + COUNTDOWN_MS;
  room.raceEndAt = 0;
  broadcastRoom(roomId);
  broadcastRoomList();
}

function endRoomRace(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const members = roomMembers(roomId);
  const ranked = rankedRoom(roomId);
  const counted = members.length >= 2;           // 우승 기록은 2명 이상일 때만
  const winnerId = counted && ranked.length ? ranked[0].id : null;

  for (const { id, p } of members) {
    // 로그인한 플레이어 통계 갱신(프로 플레이 +1, 우승 시 +1)
    if (p.account && users[p.account.userId]) {
      const u = users[p.account.userId];
      u.proPlays = (u.proPlays || 0) + 1;
      if (counted && id === winnerId) u.proWins = (u.proWins || 0) + 1;
      persistUser(p.account.userId);
      sendStats(p); // 대시보드 통계 갱신(우승/플레이/접속시간/최고기록)
    }
    // 다음 라운드 대비 초기화 (준비 해제, 랩/기록 리셋). 방·설정은 그대로 유지.
    p.ready = false; p.lap = 0; p.lapMs = 0; p.prog = 0; p.finished = false; p.finishTime = 0;
  }
  // 방을 처음 대기실 상태로 되돌린다 → 같은 설정으로 다시 준비하거나 나갈 수 있다
  room.state = "lobby";
  room.countdownAt = 0; room.raceEndAt = 0; room.raceStartAt = 0;
  broadcastRoom(roomId);
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
        for (const { p } of roomMembers(rid)) { p.lap = 0; p.lapMs = 0; p.prog = 0; p.finished = false; p.finishTime = 0; resetMotion(p); }
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

// 서버 권위 차량 충돌(밀치기) 틱 : 같은 방(프로)/같은 모드에서 충돌 대상 차들을 모아 판정.
setInterval(() => {
  if (!COLLISION_ENABLED) return; // 물리 충돌 임시 OFF
  const now = Date.now();
  const groups = new Map(); // 그룹키 -> [{id,p}]
  for (const [id, p] of players) {
    if (!p.active || !p.state || !p.collide) continue;
    const key = p.mode === "pro" ? (p.roomId != null ? "room:" + p.roomId : null) : "mode:" + p.mode;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, p });
  }
  for (const [, list] of groups) if (list.length >= 2) resolveCarCollisions(list, now);
  for (const [k, t] of bumpCooldowns) if (now > t) bumpCooldowns.delete(k); // 만료 쿨다운 정리
}, 1000 / COLLISION_HZ);

// --- 브로드캐스트 루프 ------------------------------------------------------
//  모드별로 활성 플레이어들의 최신 상태를 모아 30Hz 로 전송한다.
//  (서바이벌/레이싱 플레이어는 서로 보이지 않도록 분리)
setInterval(() => {
  const now = Date.now();
  const byMode = { survival: [], a1: [], a2: [], a3: [], racing: [], hard: [], serp: [], c1: [], c2: [], c3: [], test: [] };
  const byRoom = new Map(); // roomId -> entries (프로는 같은 방끼리만 본다)

  for (const [id, p] of players) {
    if (!p.active || !p.state) continue;
    const entry = {
      id, name: p.name,
      x: p.state.x, y: p.state.y, angle: p.state.angle,
      vx: Math.round(p.state.vx || 0), vy: Math.round(p.state.vy || 0), // 데드레커닝용 속도
      drifting: p.state.drifting,
      teleport: !!p.state.teleport,
      invuln: now < (p.invulnUntil || 0),
      admin: !!p.isAdmin, // 관리자 금색 차 표시용
      color: p.color,     // 커스텀 차 색 (미설정 시 undefined → 클라가 id 색 폴백)
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
    sendBin(p, encodeSnapshot(now, arr)); // 바이너리 스냅샷 (JSON 대비 ~5배↓)
  }

  for (const [, p] of players) {
    if (p.state) p.state.teleport = false;
  }
}, 1000 / TICK_RATE);

// 접속 중인 로그인 유저의 평생 접속 시간을 주기적으로 누적 저장(1분마다).
//  (연결이 오래 유지돼도 중간중간 반영되도록 — 크래시/강제종료 대비)
setInterval(() => {
  for (const [, p] of players) {
    flushConnectedTime(p);
    if (p.account && p.ws.readyState === p.ws.OPEN) sendStats(p); // 대시보드 실시간 갱신(접속시간·마지막접속)
  }
}, 60000);

// 계정 캐시를 적재하고 토큰 인덱스를 구성한 뒤 서버를 연다
hydrateUsers().then(() => {
  rebuildTokens();
  server.listen(PORT, () => {
    console.log(`Car game server running at http://localhost:${PORT} (storage: ${useRedis ? "Upstash Redis" : "files"})`);
  });
});
