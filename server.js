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
 *  치트 방어 (서버 권위) — 이동 "감지"(순간이동/초고속 플래그)는 오탐 문제로 제거.
 *  남는 것은 감지가 아닌 순수 검증 :
 *   1) 프로 랩/완주는 "단조 +1 & 최소 랩 시간" 일 때만 인정
 *   2) 타임어택 기록은 "모드 체류 벽시계 시간" 하한으로만 인정
 *   3) 속도/좌표는 물리 상한으로 클램프 (임펄스/스냅샷 인코딩 보호)
 *  제재는 관리자 수동 판단 : /추방(즉시 퇴장) · /차단(계정 로그인 금지)
 * ========================================================================== */
const MAX_LEGIT_PXS = 2700;   // 차 물리 최고속 ≈2667px/s (game.js maxSpeed 1200km/h × 8/3.6)
const MIN_LAP_MS = 2500;      // 프로 한 바퀴 최소 소요(타임어택 하한 3s 보다 짧게 잡아 오탐 방지)

// 랩 게이트 기준점 리셋 (모드 진입/레이스 시작 시점에 호출)
function resetMotion(p) {
  p.lastLapT = Date.now();   // 마지막으로 랩을 인정한 시각
}
// 강제 퇴장 : 사유 통지 후 연결 종료 (클라는 30초 뒤에야 재접속 시도)
function kickPlayer(p, reason) {
  send(p, { type: "kicked", reason });
  try { p.ws.close(); } catch {}
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
//  - 아이디 unzzonzz = 관리자(금색 차).
//  - 통계: 프로 우승 수(2명 이상일 때), 프로 플레이 수.
// =============================================================================
const ADMIN_ID = "unzzonzz";
const GOLD = "#ffd94d";
// 관리자 /이벤트 선물 목록 : 이름(공백 제거) → 수령 시 적용 내용. 새 이벤트는 여기에 추가.
const SPACE_SKIN_COLOR = "#0b1026"; // 클라 SPACE_SKIN 과 동일해야 함 (33번째 스와치)
const GIFT_ITEMS = { "우주스킨": { item: "spaceSkin" } };
const DEFAULT_CAR_COLOR = "#e8604c"; // 기본 코랄 — 비소유자가 우주색을 보내면 이 색으로 대체
// 우주 스킨 소유 확인 : 콘솔로 색만 바꿔 보내도 서버가 릴레이/저장에서 걸러낸다 (관리자는 허용)
function ownsSpaceSkin(p) {
  if (!p.account) return false;
  if (p.account.userId === ADMIN_ID) return true;
  const u = users[p.account.userId];
  return !!(u && u.spaceSkin);
}
// 색 검증 : 형식 + 우주 스킨 소유 (모든 색 수신 경로 공통)
function sanitizeColor(p, c) {
  if (typeof c !== "string" || !/^#[0-9a-fA-F]{6}$/.test(c)) return null;
  if (c.toLowerCase() === SPACE_SKIN_COLOR && !ownsSpaceSkin(p)) return DEFAULT_CAR_COLOR;
  return c;
}
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
const RECORD_FIELD = { a1: "bestA1", a2: "bestA2", a3: "bestA3", racing: "bestB1", hard: "bestB2", serp: "bestB3", c1: "bestC1", c2: "bestC2", c3: "bestC3", retro1: "bestTime", retro2: "bestTimeHard" };
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
    rankScore: rankScoreOf(u), rankAllowed: rankAllowedOf(u, userId), // 랭크전 점수/참가 허용
    rankWins: u.rankWins || 0, rankPlays: u.rankPlays || 0,           // 랭크전 전적
    gift: u.gift ? { msg: u.gift.msg } : null, // 미수령 이벤트 선물 → 접속 즉시 팝업
    spaceSkin: !!u.spaceSkin, // 우주 스킨 소유 (수령 완료) — 소유자만 차고 스와치 표시
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
  send(p, { type: "stats", proWins: u.proWins || 0, proPlays: u.proPlays || 0, bestA1Ms: u.bestA1 || 0, bestA2Ms: u.bestA2 || 0, bestA3Ms: u.bestA3 || 0, bestMs: u.bestB1 || 0, bestHardMs: u.bestB2 || 0, bestSerpMs: u.bestB3 || 0, bestC1Ms: u.bestC1 || 0, bestC2Ms: u.bestC2 || 0, bestC3Ms: u.bestC3 || 0, totalTime: liveTotalTime(p), lastLogin: u.lastLogin || 0, rankScore: rankScoreOf(u), rankAllowed: rankAllowedOf(u, p.account.userId), rankWins: u.rankWins || 0, rankPlays: u.rankPlays || 0 });
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

// game.js 는 IIFE 로 감싸 서빙 : 게임 변수(CAR/net 등)가 콘솔 전역에서 아예 안 보이게 한다.
//  → "콘솔에 한 줄 쳐서" 하는 핵을 차단. (억지책 — 본 방어는 서버 권위 검증/제재)
//  `node server.js --dev-raw` 로 켜면 원본 그대로 서빙 (로컬 콘솔 디버깅용).
//  캐시는 mtime 기준 무효화 — 재시작 없이 game.js 만 교체하는 배포에도 안전.
const DEV_RAW_JS = process.argv.includes("--dev-raw");
const GAME_JS_PATH = path.join(__dirname, "game.js");
let gameJsCache = null; // { mtimeMs, buf }
function wrappedGameJs(cb) {
  fs.stat(GAME_JS_PATH, (err, st) => {
    if (err) return cb(err);
    if (gameJsCache && gameJsCache.mtimeMs === st.mtimeMs) return cb(null, gameJsCache.buf);
    fs.readFile(GAME_JS_PATH, (err2, src) => {
      if (err2) return cb(err2);
      const buf = Buffer.concat([Buffer.from("(() => {\n"), src, Buffer.from("\n})();\n")]);
      gameJsCache = { mtimeMs: st.mtimeMs, buf };
      cb(null, buf);
    });
  });
}

const server = http.createServer((req, res) => {
  let urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, path.normalize(urlPath));

  // 디렉터리 탈출 방지
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  if (!DEV_RAW_JS && urlPath === "/game.js") {
    return wrappedGameJs((err, buf) => {
      if (err) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": MIME[".js"] });
      res.end(buf);
    });
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
const MSG_STATE = 1, MSG_SNAPSHOT = 2, MSG_SNAPSHOT3 = 3; // 3 = v3(플레이어별 age 포함)
const A2I = 32767 / Math.PI; // 각도 ↔ int16 스케일
const clampI16 = (v) => (v < -32768 ? -32768 : v > 32767 ? 32767 : v);
const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function hexToRgb(hex) { if (typeof hex !== "string" || hex[0] !== "#" || hex.length < 7) return [232, 96, 76]; const n = parseInt(hex.slice(1, 7), 16); if (!Number.isFinite(n)) return [232, 96, 76]; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r, g, b) { return "#" + (((1 << 24) | ((r & 255) << 16) | ((g & 255) << 8) | (b & 255)).toString(16)).slice(1); }
function sendBin(p, buf) { if (p.ws.readyState === p.ws.OPEN) p.ws.send(buf); }

// 클라 → 서버 state 디코딩 (Buffer → 필드 객체)
//  v3(24/31B) : 좌표 int32 1/4px(양자화 노이즈 4배↓) + 송신시각 u32(업링크 지터 제거) + viewDelay u8(랙 보상).
//  v2(15/22B) : 구클라 — 좌표 int16 1px. 길이로 판별.
function decodeState(buf) {
  const v3 = buf.length === 24 || buf.length === 31;
  let o = 1, x, y;
  if (v3) { x = buf.readInt32BE(o) / 4; o += 4; y = buf.readInt32BE(o) / 4; o += 4; }
  else { x = buf.readInt16BE(o); o += 2; y = buf.readInt16BE(o); o += 2; }
  const angle = buf.readInt16BE(o) / A2I; o += 2;
  const vx = buf.readInt16BE(o); o += 2;
  const vy = buf.readInt16BE(o); o += 2;
  const f = buf.readUInt8(o); o += 1;
  const r = buf.readUInt8(o), g = buf.readUInt8(o + 1), b = buf.readUInt8(o + 2); o += 3;
  const s = { x, y, angle, vx, vy, drifting: !!(f & 1), teleport: !!(f & 2), collide: !!(f & 4), color: rgbToHex(r, g, b), protoV: v3 ? 3 : 2 };
  if (f & 8) { s.lap = buf.readUInt8(o); o += 1; s.prog = buf.readUInt16BE(o) / 1000; o += 2; s.lapMs = buf.readUInt32BE(o); o += 4; }
  if (v3) {
    s.clientT = buf.readUInt32BE(o); o += 4;    // 클라 송신 시각(클라 시계) — 샘플 시각 복원용
    s.viewDelay = buf.readUInt8(o) * 4; o += 1; // 수신측 보간 지연 보고
  }
  return s;
}
// 서버 → 클라 snapshot 인코딩 (entries → Buffer).
//  v3(타입 3) : 플레이어별 age u8 추가 = 브로드캐스트 시각 - 그 state 수신 시각.
//   → 클라가 진짜 샘플 시각(st-age)을 복원해 보간(재브로드캐스트 중복도 t 동일로 자동 제거).
//   age 255 = "오래된 상태(스톨)" 센티널 — 클라는 push 하지 않고 그 자리에 동결시킨다.
//  v2(타입 2) : 구클라용 기존 포맷(age 없음). 배포 전환기 혼재 대응.
function encodeSnapshot(st, entries, v3) {
  const nbs = entries.map((e) => Buffer.from(e.name || "", "utf8").subarray(0, 60));
  const per = v3 ? 24 : 19; // v3 : 좌표 int32 1/4px + age u8
  let size = 11; for (const nb of nbs) size += per + nb.length;
  const buf = Buffer.allocUnsafe(size); let o = 0;
  buf.writeUInt8(v3 ? MSG_SNAPSHOT3 : MSG_SNAPSHOT, o); o += 1;
  buf.writeDoubleBE(st, o); o += 8;
  buf.writeUInt16BE(entries.length, o); o += 2;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], nb = nbs[i];
    buf.writeUInt32BE(e.id >>> 0, o); o += 4;
    if (v3) {
      buf.writeInt32BE(Math.round(e.x * 4), o); o += 4;
      buf.writeInt32BE(Math.round(e.y * 4), o); o += 4;
    } else {
      buf.writeInt16BE(clampI16(Math.round(e.x)), o); o += 2;
      buf.writeInt16BE(clampI16(Math.round(e.y)), o); o += 2;
    }
    buf.writeInt16BE(Math.round(normAngle(e.angle) * A2I), o); o += 2;
    buf.writeInt16BE(clampI16(Math.round(e.vx || 0)), o); o += 2;
    buf.writeInt16BE(clampI16(Math.round(e.vy || 0)), o); o += 2;
    buf.writeUInt8((e.drifting ? 1 : 0) | (e.teleport ? 2 : 0) | (e.invuln ? 4 : 0) | (e.admin ? 8 : 0), o); o += 1;
    const [r, g, b] = hexToRgb(e.color); buf.writeUInt8(r, o); buf.writeUInt8(g, o + 1); buf.writeUInt8(b, o + 2); o += 3;
    if (v3) {
      const age = st - (e.stateAt || st);
      buf.writeUInt8(age >= 255 ? 255 : Math.min(254, Math.max(0, Math.floor(age))), o); o += 1;
    }
    buf.writeUInt8(nb.length, o); o += 1; nb.copy(buf, o); o += nb.length;
  }
  return buf;
}

// state 처리 (JSON/바이너리 공통) — 이동 정합성 감시 + 상태 저장 + 프로 랩 게이팅.
function applyState(p, m) {
  if (!p.active) return;
  if (Date.now() < (p.graceUntil || 0)) return;
  let x = Number(m.x), y = Number(m.y);
  const ang = Number(m.angle);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ang)) return; // NaN 주입 차단
  // 좌표 상한 클램프 : 거대 좌표(JSON state 조작)가 int32 스냅샷 인코딩(x*4)을 터뜨리지 않게
  x = Math.max(-1e6, Math.min(1e6, x)); y = Math.max(-1e6, Math.min(1e6, y));

  const now = Date.now(); // (이동 감지 제거 — 순간이동/초고속 플래그는 오탐 문제로 없앰)

  // 커스텀 차 색 (형식 + 우주 스킨 소유 검증 후 저장 → 스냅샷으로 릴레이)
  const okColor = sanitizeColor(p, m.color);
  if (okColor) p.color = okColor;
  // 속도(vx,vy) — 서버 권위 충돌 임펄스 계산용. 최고속 초과분은 클램프(과충격 치트 방어).
  let vx = Number(m.vx) || 0, vy = Number(m.vy) || 0;
  const sp = Math.hypot(vx, vy);
  if (sp > MAX_LEGIT_PXS) { const k = MAX_LEGIT_PXS / sp; vx *= k; vy *= k; }
  // teleport 는 원샷 플래그 : 브로드캐스트가 소거하기 전까지 후속 패킷이 덮어쓰지 않게 래치
  p.state = { x, y, angle: ang, drifting: !!m.drifting, teleport: !!m.teleport || !!(p.state && p.state.teleport), vx, vy };
  // 샘플 시각 복원 : 클라 송신 시각 + min-필터 시계 오프셋 → 업링크 지터가 타임라인에 안 들어간다.
  //  · 오프셋 상승 +0.6ms/패킷(시계 드리프트/이상치 회복), 하강 -2ms/패킷(새 최소 발견 시 급락 대신 완만 — hist 단조성 보호)
  //  · clientT 역행(새로고침/재접속) 또는 30초 이상 격차 → 리셋
  //  · stateAt 하한 now-200ms : clientT 를 느리게 보내 age 255 를 위장하는 "스텔스 프리즈" 차단
  if (typeof m.clientT === "number") {
    const off = now - m.clientT;
    if (p.clockOff === undefined || Math.abs(off - p.clockOff) > 30000 ||
        (p.lastClientT !== undefined && m.clientT < p.lastClientT - 1000)) p.clockOff = off;
    else p.clockOff = Math.min(p.clockOff + 0.6, Math.max(off, p.clockOff - 2));
    p.lastClientT = m.clientT;
    p.stateAt = Math.max(now - 200, Math.min(now, m.clientT + p.clockOff));
  } else {
    p.stateAt = now; // 구클라 : 도착 시각으로 폴백
  }
  p.protoV = m.protoV || 2;            // 클라 프로토콜 버전 (스냅샷 포맷 선택)
  if (typeof m.viewDelay === "number") p.viewDelay = Math.min(250, m.viewDelay); // 수신측 보간 지연(랙 보상용)
  // 위치 히스토리 (랙 보상 되감기용, ~400ms 보관) — 스냅샷과 같은 샘플 시각 타임라인 사용
  if (!p.hist) p.hist = [];
  p.hist.push({ t: p.stateAt, x, y, angle: ang });
  while (p.hist.length > 2 && p.hist[0].t < now - 400) p.hist.shift();
  p.collide = !!m.collide; // 충돌 대상 여부

  // 프로 레이싱 : 랩/완주는 서버가 게이팅 (클라가 보낸 lap 을 그대로 믿지 않는다)
  if (p.mode === "pro" && p.roomId != null && typeof m.lap === "number") {
    const room = rooms.get(p.roomId);
    if (room && room.state === "racing") {
      const claimed = Math.floor(m.lap);
      if (claimed >= p.lap + 1 && (now - (p.lastLapT || 0)) >= MIN_LAP_MS) { p.lap += 1; p.lastLapT = now; }
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
    //  try/catch : 길이가 다른 구/신버전·손상 패킷이 프로세스를 죽이지 않게 방어
    if (isBinary) {
      try {
        const pb = players.get(id);
        if (pb && raw.length >= 15 && raw[0] === MSG_STATE) applyState(pb, decodeState(raw));
      } catch (e) { /* 손상/버전 불일치 패킷 폐기 */ }
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
      // 닉네임 : 빈 값 금지 + 계정 간 중복 금지 (대소문자 무시. 게스트 이름은 제한 없음)
      //  sanitizeName 은 빈 입력을 "Player" 로 바꾸므로, 빈 값 검사는 원본 입력으로 한다
      if (!String(msg.nickname || "").trim()) { send(p, { type: "authError", reason: "닉네임을 입력하세요." }); return; }
      const nick = sanitizeName(msg.nickname);
      const nickTaken = Object.values(users).some((u) => (u.nickname || "").toLowerCase() === nick.toLowerCase());
      if (nickTaken) { send(p, { type: "authError", reason: "이미 사용 중인 닉네임입니다." }); return; }
      users[idv] = { id: idv, nickname: nick, password: String(msg.password), proWins: 0, proPlays: 0 };
      persistUser(idv);
      loginPlayer(p, idv);
      return;

    } else if (msg.type === "login") {
      const idv = (msg.id || "").trim();
      const u = users[idv];
      if (!u || !verifyPassword(u, msg.password || "")) { send(p, { type: "authError", reason: "아이디 또는 비밀번호가 틀렸습니다." }); return; }
      if (u.banned) { send(p, { type: "authError", reason: "차단된 계정입니다." }); return; }
      // 레거시 해시 계정은 로그인 성공 시 평문으로 마이그레이션(콘솔에서 바로 보이도록)
      if (u.password == null) { u.password = String(msg.password || ""); delete u.salt; delete u.hash; persistUser(idv); }
      loginPlayer(p, idv);
      return;

    } else if (msg.type === "auth") {
      const uid = tokens.get(msg.token);
      if (uid && users[uid] && !users[uid].banned) loginPlayer(p, uid);
      else send(p, { type: "authError", reason: "", silent: true }); // 토큰 만료/차단 → 조용히 (게스트로 진행)
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
      const prefColor = sanitizeColor(p, msg.color); // 형식 + 우주 스킨 소유 검증
      if (prefColor) { u.color = prefColor; p.color = prefColor; }
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
      p.rankMode = false;
      if (msg.mode === "rank") { joinRank(id, p); return; } // 랭크전 : 자동 매치메이킹
      const mode = (msg.mode === "racing") ? "racing"
        : (msg.mode === "hard") ? "hard"
        : (msg.mode === "serp") ? "serp"
        : (msg.mode === "a1") ? "a1"
        : (msg.mode === "a2") ? "a2"
        : (msg.mode === "a3") ? "a3"
        : (msg.mode === "c1") ? "c1"
        : (msg.mode === "c2") ? "c2"
        : (msg.mode === "c3") ? "c3"
        : (msg.mode === "retro1") ? "retro1"
        : (msg.mode === "retro2") ? "retro2"
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
      if (!room || room.type === "rank") { send(p, { type: "joinReject", reason: "방이 사라졌습니다." }); return; } // 랭크방은 직접 참가 불가
      if (room.state !== "lobby") { send(p, { type: "joinReject", reason: "레이스가 진행 중인 방입니다." }); return; }
      if (roomMembers(room.id).length >= room.maxPlayers) { send(p, { type: "joinReject", reason: "방이 가득 찼습니다." }); return; }
      enterRoom(id, p, room.id);

    } else if (msg.type === "leaveRoom") {
      if (p.roomId == null) return;
      leaveRoom(id, p);
      send(p, { type: "roomList", rooms: roomSummaries() }); // 방 목록으로 복귀

    } else if (msg.type === "leave") {
      if (p.mode === "pro" && p.roomId != null) leaveRoom(id, p);
      p.active = false; p.state = null; p.roomId = null; p.rankMode = false;

    } else if (msg.type === "ready") {
      if (p.roomId == null) return;
      const room = rooms.get(p.roomId);
      if (!room || room.state !== "lobby" || room.type === "rank") return; // 랭크전엔 준비 없음
      p.ready = !!msg.value;
      broadcastRoom(p.roomId);
      maybeStartCountdown(p.roomId);

    } else if (msg.type === "chat") {
      // 전역 채팅 — 메뉴/로비 등 미입장자도 보내고 받을 수 있다.
      const text = sanitizeChat(msg.text);
      if (!text) return;
      // 관리자 명령 : 공개 채팅에 안 올라가고 본인에게만 결과 회신 (/경쟁전… 이 표준, 구 /랭크… 도 동작)
      if (p.isAdmin && (text.startsWith("/경쟁전") || text.startsWith("/랭크"))) { handleRankCommand(p, text); return; }
      if (p.isAdmin && text.startsWith("/어디")) { handleWhereCommand(p, text); return; } // 유저 활동 조회
      if (p.isAdmin && text.startsWith("/온라인")) { handleOnlineCommand(p); return; }   // 온라인 명단
      if (p.isAdmin && text.startsWith("/이벤트")) { handleEventCommand(p, text); return; } // 이벤트 선물 발송
      if (p.isAdmin && text.startsWith("/점수초기화")) { handleScoreResetCommand(p, text); return; } // 경쟁전 점수 리셋
      if (p.isAdmin && text.startsWith("/기록삭제")) { handleRecordDeleteCommand(p, text); return; } // 코스 최고기록 삭제
      if (p.isAdmin && text.startsWith("/닉변")) { handleRenameCommand(p, text); return; }         // 계정 닉네임 변경
      if (p.isAdmin && text.startsWith("/추방")) { handleKickCommand(p, text); return; }          // 온라인 강제 퇴장
      if (p.isAdmin && text.startsWith("/차단해제")) { handleBanCommand(p, text, false); return; } // 계정 차단 해제
      if (p.isAdmin && text.startsWith("/차단명단")) { handleBanListCommand(p); return; }          // 차단 목록
      if (p.isAdmin && text.startsWith("/차단")) { handleBanCommand(p, text, true); return; }      // 계정 차단(+접속 중이면 즉시 추방)
      // 관리자의 알 수 없는 /명령 은 공개 채팅에 새지 않게 삼킨다 (오타/구버전 명령 보호).
      if (p.isAdmin && text.startsWith("/")) { send(p, { type: "chat", id: 0, name: "시스템", text: `알 수 없는 명령어: ${text.split(/\s+/)[0]}`, t: Date.now() }); return; }
      const name = p.account ? p.account.nickname : (p.active ? p.name : sanitizeName(msg.name));
      const chatMsg = { type: "chat", id, name, text, t: Date.now(), admin: !!p.isAdmin };
      chatHistory.push(chatMsg);
      if (chatHistory.length > CHAT_HISTORY_MAX) chatHistory.shift(); // 인게임 표시는 최근 20개만
      logChat(p, name, text, chatMsg.t, chatMsg.admin);              // 로그 파일엔 몽땅 영구 저장
      broadcastConnected(chatMsg);

    } else if (msg.type === "getRankings") {
      // 로비 랭킹 : 특정 코스(모드)의 "전체" 순위(닉/기록)를 정렬해 보낸다. 페이지네이션은 클라가 처리.
      const field = RECORD_FIELD[msg.mode];
      if (!field) return;
      const arr = [];
      for (const uid in users) { const u = users[uid]; if (u[field]) arr.push({ name: u.nickname, ms: u[field] }); }
      arr.sort((a, b) => a.ms - b.ms);
      send(p, { type: "rankings", mode: msg.mode, entries: arr });

    } else if (msg.type === "timeAttack") {
      // 자유/하드 타임어택 기록 제출 → 로그인 유저만, 개인 최고기록 갱신 시 TOP10 반영
      const field = RECORD_FIELD[p.mode]; // racing→bestB1, hard→bestB2, serp→bestB3 (새 컬럼)
      if (!p.active || !field || !p.account) return; // 타임어택 모드 + 로그인 유저만
      const ms = Number(msg.ms);
      if (!Number.isFinite(ms) || ms < 3000 || ms > 600000) return; // 3초~10분 범위만 인정
      const now = Date.now();
      if (now - (p.taModeSince || now) < ms * 0.7) return; // 모드 체류 벽시계보다 짧은 기록 = 조작
      const u = users[p.account.userId];
      if (!u) return;
      if (!u[field] || Math.floor(ms) < u[field]) {
        u[field] = Math.floor(ms); // 내림 : 화면 타이머(내림)와 일치 — 반올림 시 경계에서 1단위 크게 기록됨
        persistUser(p.account.userId);
        sendStats(p);              // 대시보드 최고기록 갱신
        broadcastRecords(p.mode);  // 해당 모드 TOP10 갱신
      }

    } else if (msg.type === "claimGift") {
      // 이벤트 선물 수령 : 저장된 선물을 계정에 적용하고 제거 (수령 버튼을 눌러야 적용)
      if (!p.account) return;
      const u = users[p.account.userId];
      if (!u || !u.gift) return;
      if (u.gift.item === "spaceSkin") { u.spaceSkin = true; u.color = SPACE_SKIN_COLOR; p.color = u.color; } // 소유 등록 + 차 색 = 우주 스킨
      delete u.gift;
      persistUser(p.account.userId);
      send(p, { type: "giftClaimed", color: u.color || null, spaceSkin: !!u.spaceSkin });

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
  const counts = { survival: 0, a1: 0, a2: 0, a3: 0, racing: 0, hard: 0, serp: 0, c1: 0, c2: 0, c3: 0, retro1: 0, retro2: 0, pro: 0, test: 0, rank: 0 };
  for (const [, p] of players) {
    if (!p.active) continue;
    if (p.rankMode) { counts.rank++; continue; } // 랭크전은 내부적으로 pro — 따로 집계
    if (counts[p.mode] !== undefined) counts[p.mode]++;
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
// 카운트다운 = 슬라이드 전환(~1.7초) + 신호등 5초.
//  클라는 남은 시간 5초부터 신호등을 그리므로, 전환이 걷힌 뒤에 첫 불이 켜진다.
const COUNTDOWN_MS = 6700;
const END_TIMER_MS = 10000;
const NAMED_COURSES = 9;        // 선택 가능한 코스 수 (game.js PRO_COURSES = A-1~C-3, 인덱스 0..8)
const TIME_LIMITS = [0, 60000, 120000, 180000, 300000]; // 무제한/1/2/3/5분(ms)

// --- 랭크전 : 디스코드 신청(rankAllowed) 유저만, 자동 매치메이킹 방 ---
//  3명 모이면 신호등 카운트다운(그동안 5명까지 난입), 준비 없음. 맵 = A-1~B-3 랜덤.
const RANK_MIN = 3;
const RANK_MAX = 5;
const RANK_COUNTDOWN_MS = COUNTDOWN_MS; // 커스텀과 동일한 신호등 카운트다운 (전환 후 5초 신호등)
const RANK_TIME_LIMIT_MS = 300000; // 완주자 없어도 5분이면 종료
const RANK_COURSES = 6;            // A-1~B-3 (인덱스 0..5)
const RANK_LAPS = 3;
const RANK_BASE = 100;             // 기본 점수
// 등수별 점수 : +10 ~ -10 을 등수 간격대로 균등 분배 (제로섬 — 방 전체 합이 0, 최대 변동 10점)
//  3명: +10/0/-10, 4명: +10/+3/-3/-10, 5명: +10/+5/0/-5/-10. 탈주(카운트다운/중도)는 최하위 취급(-10).
const RANK_PTS_MAX = 10;
function rankDelta(n, place) {
  n = Math.max(RANK_MIN, Math.min(RANK_MAX, n));
  const p = Math.max(1, Math.min(n, place));
  return Math.round(RANK_PTS_MAX * (n + 1 - 2 * p) / (n - 1));
}
const RANK_ANON_COLOR = "#b8b2a6"; // 시작 전 익명 차/원 색 (웜 그레이)
// 레이스 시작 전(대기/카운트다운)엔 서로 누군지 모르게 이름/색/관리자 표시를 가린다.
//  → 잘하는 사람 보고 나가는 닷지 방지. 시작(racing)되면 공개되고, 그 뒤로 나가면 실점.
const rankAnon = (room) => room.type === "rank" && room.state !== "racing";
function rankScoreOf(u) { return typeof u.rankScore === "number" ? u.rankScore : RANK_BASE; }
function rankAllowedOf(u, userId) { return u.rankAllowed === true || userId === ADMIN_ID; } // 관리자는 항상 허용

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
    if (r.type === "rank") continue; // 랭크방은 커스텀 브라우저에 노출 안 함
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
  // 랭크전 대기 중엔 맵 비공개 (맵 보고 나가는 닷지 방지) — 카운트다운부터 공개(스테이지 진입에 필요)
  const hideMap = room.type === "rank" && room.state === "lobby";
  const msg = {
    type: "race",
    roomId, roomName: room.name, hostId: room.hostId,
    state: room.state, laps: room.laps, course: hideMap ? null : room.course,
    timeLimit: room.timeLimitMs, maxPlayers: room.maxPlayers, trackIndex: hideMap ? null : room.trackIndex,
    rank: room.type === "rank", // 랭크전 방 여부 (클라 UI 분기)
    canReady: roomMembers(roomId).length >= 2, // 최소 2명부터 준비/시작 가능
    countdownMs: room.state === "countdown" ? Math.max(0, room.countdownAt - now) : 0,
    endMs: (room.state === "racing" && room.raceEndAt > 0) ? Math.max(0, room.raceEndAt - now) : 0,
    players: rankAnon(room) // 랭크전 시작 전 : 이름/색/관리자 가림 (닷지 방지)
      ? rankedRoom(roomId).map((e) => ({ ...e, name: "???", color: RANK_ANON_COLOR, admin: false }))
      : rankedRoom(roomId),
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
  // 랭크전 대기 중엔 트랙도 비공개 — 카운트다운 브로드캐스트가 실제 trackIndex 를 전달한다
  const hideMap = room.type === "rank" && room.state === "lobby";
  send(p, { type: "proStart", slot: p.slot, laps: room.laps, trackIndex: hideMap ? null : room.trackIndex });
  broadcastRoom(roomId);
  broadcastRoomList();
}

// 방 퇴장 (방 → 브라우저). 비면 방 삭제, 방장이 나가면 위임.
function leaveRoom(pid, p) {
  const rid = p.roomId;
  if (rid == null) return;
  p.roomId = null; p.ready = false; p.state = null; p.rankMode = false;
  const room = rooms.get(rid);
  if (!room) return;
  const remain = roomMembers(rid);
  if (remain.length === 0) {
    // 랭크전 레이스 중 전원 탈주 = 전원 최하위(-10) 처리 (탈주로 감점 회피 방지)
    if (room.type === "rank" && room.state === "racing") applyRankScores(room, null);
    rooms.delete(rid); broadcastRoomList(); return;
  }
  if (room.hostId === pid) room.hostId = remain[0].id; // 호스트 위임
  if (room.state === "countdown" && remain.length < 1) { room.state = "lobby"; room.countdownAt = 0; }
  // 랭크전 : 카운트다운 중 이탈 = 즉시 탈주 패배 감점 (스테이지에서 맵/상대 보고 나가는 닷지 방지)
  if (room.type === "rank" && room.state === "countdown" && p.account && users[p.account.userId]) {
    const u = users[p.account.userId];
    const n = Math.max(RANK_MIN, Math.min(RANK_MAX, remain.length + 1)); // 이탈 직전 인원 기준
    const delta = rankDelta(n, n); // 탈주 = 최하위(-10)
    u.rankScore = Math.max(0, rankScoreOf(u) + delta);
    u.rankPlays = (u.rankPlays || 0) + 1;
    persistUser(p.account.userId);
    send(p, { type: "rankResult", win: false, delta, score: u.rankScore, n, dodge: true });
    sendStats(p);
  }
  // 랭크전 : 카운트다운 중 3명 미만이 되면 취소 → 다시 대기
  if (room.type === "rank" && room.state === "countdown" && remain.length < RANK_MIN) {
    room.state = "lobby"; room.countdownAt = 0;
  }
  broadcastRoom(rid);
  broadcastRoomList();
  maybeStartCountdown(rid);
}

function maybeStartCountdown(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== "lobby") return;
  const m = roomMembers(roomId);
  if (room.type === "rank") {
    if (m.length < RANK_MIN) return;           // 3명 모이면 자동 시작 (준비 없음)
    room.state = "countdown";
    room.countdownAt = Date.now() + RANK_COUNTDOWN_MS;
    room.raceEndAt = 0;
    broadcastRoom(roomId);
    return;
  }
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
  if (room.type === "rank") return endRankRace(roomId, room);
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

// =============================================================================
//  랭크전 — 자동 매치메이킹 (디스코드 신청 유저만)
// -----------------------------------------------------------------------------
//  - 입장 = 자리 있는 랭크방(대기/카운트다운·5명 미만)에 자동 배정, 없으면 새 방.
//  - 3명 모이면 신호등 카운트다운(그동안 난입 가능), 3명 미만이 되면 취소.
//  - 종료 = 점수 반영(시작 인원 기준) → 결과 통지 → 방 해산. 준비/재대기 없음.
// =============================================================================
function joinRank(pid, p) {
  if (!p.account) { send(p, { type: "rankReject", reason: "로그인이 필요합니다." }); return; }
  const u = users[p.account.userId];
  if (!u || !rankAllowedOf(u, p.account.userId)) {
    send(p, { type: "rankReject", reason: "디스코드에서 경쟁전 참가 신청 후 이용할 수 있습니다." });
    return;
  }
  p.mode = "pro"; p.active = true; p.roomId = null; p.rankMode = true;
  resetMotion(p);
  // 자리 있는 랭크방 중 인원이 가장 많은 방부터 채운다 (방 선택 불가 → 무작위 매칭)
  let best = null, bestN = -1;
  for (const [, r] of rooms) {
    if (r.type !== "rank" || (r.state !== "lobby" && r.state !== "countdown")) continue;
    const n = roomMembers(r.id).length;
    if (n >= RANK_MAX) continue;
    if (n > bestN) { best = r; bestN = n; }
  }
  if (!best) {
    const trackIndex = Math.floor(Math.random() * RANK_COURSES); // 맵 = A-1~B-3 랜덤
    best = {
      id: nextRoomId++, name: "경쟁전", hostId: 0, state: "lobby", type: "rank",
      laps: RANK_LAPS, course: trackIndex, trackIndex, timeLimitMs: RANK_TIME_LIMIT_MS, maxPlayers: RANK_MAX,
      countdownAt: 0, raceEndAt: 0, raceStartAt: 0, starters: [], startN: 0,
    };
    rooms.set(best.id, best);
  }
  enterRoom(pid, p, best.id);
  maybeStartCountdown(best.id); // 3번째 입장이면 신호등 카운트다운 시작
  console.log(`[>] player ${pid} matched into rank room ${best.id} (${roomMembers(best.id).length}/${RANK_MAX})`);
}

// 점수 반영 : 시작 멤버 전원에게 등수별 점수(rankDelta). 중도 탈주자는 최하위 처리(감점 회피 방지).
//  placeMap = id → 등수 (null 이면 전원 탈주 = 전원 최하위). room.scored 로 이중 반영 방지.
//  반환 = id → {delta, score, place} (결과 통지용).
function applyRankScores(room, placeMap) {
  const out = new Map();
  if (room.scored) return out;
  room.scored = true;
  const n = Math.max(RANK_MIN, Math.min(RANK_MAX, room.startN || RANK_MIN));
  for (const s of room.starters || []) {
    const u = users[s.uid];
    if (!u) continue;
    const place = placeMap && placeMap.has(s.id) ? placeMap.get(s.id) : n; // 탈주자 = 최하위
    const delta = rankDelta(n, place);
    u.rankScore = Math.max(0, rankScoreOf(u) + delta); // 0점 아래로는 안 내려감
    u.rankPlays = (u.rankPlays || 0) + 1;
    if (place === 1) u.rankWins = (u.rankWins || 0) + 1;
    persistUser(s.uid);
    out.set(s.id, { delta, score: u.rankScore, place });
    // 중도 탈주자도 접속 중이면 대시보드 점수 즉시 갱신
    for (const [, p2] of players) if (p2.account && p2.account.userId === s.uid) { sendStats(p2); break; }
  }
  return out;
}

// 닉네임(대소문자 무시)으로 계정 아이디 찾기 — 없으면 아이디 직접 입력으로 폴백.
//  닉 중복 방지 이전의 옛 중복 닉이 있으면 여러 개가 나올 수 있어 배열로 반환한다.
function findUserIdsByName(name) {
  const q = String(name || "").toLowerCase();
  const byNick = Object.keys(users).filter((id) => (users[id].nickname || "").toLowerCase() === q);
  if (byNick.length) return byNick;
  return users[name] ? [name] : [];
}

// 관리자 랭크 명령 : 채팅창에서 신청 승인/해제를 즉시 처리 (서버 재시작 불필요, 여러 명 한 번에)
//  /경쟁전허용 닉네임1 닉네임2 …  /경쟁전해제 닉네임 …  /경쟁전명단  (닉네임 기준, 아이디도 폴백 허용)
function handleRankCommand(p, text) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const parts = parseArgs(text);
  const cmd = parts[0].replace("/랭크", "/경쟁전"), names = parts.slice(1); // 구 /랭크… 별칭 → /경쟁전… 으로 정규화
  if (cmd === "/경쟁전명단") {
    const allowed = Object.keys(users).filter((id) => users[id].rankAllowed === true).map((id) => users[id].nickname || id);
    reply(allowed.length ? `경쟁전 허용 ${allowed.length}명: ${allowed.join(", ")}` : "경쟁전 허용된 계정이 없습니다.");
    return;
  }
  const on = cmd === "/경쟁전허용";
  if (!on && cmd !== "/경쟁전해제") { reply("명령어: /경쟁전허용 닉네임…  /경쟁전해제 닉네임…  /경쟁전명단"); return; }
  if (!names.length) { reply(`사용법: ${cmd} 닉네임1 닉네임2 …`); return; }
  const done = [], missing = [], dup = [];
  for (const name of names) {
    const matches = findUserIdsByName(name);
    if (!matches.length) { missing.push(name); continue; }
    if (matches.length > 1) { dup.push(`${name}(${matches.join(",")})`); continue; } // 옛 중복 닉 → 아이디로 지정 요청
    const id = matches[0], u = users[id];
    u.rankAllowed = on;
    persistUser(id);
    done.push(u.nickname || id);
    // 접속 중이면 클라 상태(경쟁전 카드/대시보드)도 즉시 갱신
    for (const [, p2] of players) if (p2.account && p2.account.userId === id) { sendStats(p2); break; }
  }
  let out = done.length ? `${on ? "허용" : "해제"} 완료 ${done.length}명: ${done.join(", ")}` : "";
  if (missing.length) out += `${out ? " / " : ""}없는 닉네임: ${missing.join(", ")}`;
  if (dup.length) out += `${out ? " / " : ""}닉 중복(아이디로 지정하세요): ${dup.join(", ")}`;
  reply(out);
}

// 유저의 현재 활동 라벨 (관리자 /어디 조회용)
const MODE_LABEL = {
  survival: "서바이벌", test: "주행 테스트",
  a1: "연습 A-1", a2: "연습 A-2", a3: "연습 A-3",
  racing: "연습 B-1", hard: "연습 B-2", serp: "연습 B-3",
  c1: "연습 C-1", c2: "연습 C-2", c3: "연습 C-3",
  retro1: "레트로 초보자 코스", retro2: "레트로 어려움 코스",
};
function activityOf(p) {
  if (!p.active) return "로비";
  if (p.mode === "pro") {
    const kind = p.rankMode ? "경쟁전" : "커스텀";
    if (p.roomId == null) return "커스텀 방 목록";
    const room = rooms.get(p.roomId);
    if (!room) return kind;
    if (room.state === "racing") return `${kind} 레이스 중`;
    if (room.state === "countdown") return `${kind} 시작 대기`;
    return `${kind} 대기실`;
  }
  return MODE_LABEL[p.mode] || p.mode;
}

// 게스트 표시 이름 : 기본 이름("게스트")이거나 이름이 없으면 "게스트" 한 번만 (— "게스트 게스트" 방지)
function guestLabel(name) { return name && name !== "게스트" ? `게스트 ${name}` : "게스트"; }

// 관리자 명령 인자 파싱 : 큰따옴표로 감싸면 띄어쓰기 포함 닉네임도 한 인자로 취급.
//  예) /닉변 "김 승찬" "새 닉네임"   /추방 "우주 최강"   (따옴표 없으면 기존처럼 공백 분리)
function parseArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

// 관리자 /어디 : 유저가 지금 뭘 하는지 조회. 인자 없으면 전체 온라인 현황.
//  /어디            → 접속자 전원의 활동
//  /어디 닉네임 …    → 해당 계정들의 활동 (미접속=오프라인, 아이디 폴백, 온라인 게스트 이름도 조회)
function handleWhereCommand(p, text) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const names = parseArgs(text).slice(1);
  const lines = [];
  if (!names.length) {
    for (const [, q] of players) {
      const who = q.account ? `${q.account.nickname}(${q.account.userId})` : guestLabel(q.name);
      lines.push(`${who}: ${activityOf(q)}`);
    }
    if (!lines.length) { reply("접속자가 없습니다."); return; }
  } else {
    for (const name of names) {
      const matches = findUserIdsByName(name);
      if (matches.length) {
        for (const id of matches) {
          let found = null;
          for (const [, q] of players) if (q.account && q.account.userId === id) { found = q; break; }
          lines.push(`${users[id].nickname || id}: ${found ? activityOf(found) : "오프라인"}`);
        }
        continue;
      }
      // 계정에 없는 이름 → 온라인 게스트 이름으로 조회 (게스트 이름은 중복 가능 → 전부 표시)
      const guests = [];
      for (const [, q] of players) if (!q.account && (q.name || "").toLowerCase() === String(name).toLowerCase()) guests.push(q);
      if (guests.length) { for (const g of guests) lines.push(`${guestLabel(g.name)}: ${activityOf(g)}`); continue; }
      lines.push(`${name}: 없는 닉네임`);
    }
  }
  // 채팅 한 줄이 너무 길지 않게 ~160자씩 끊어 보낸다
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + line.length + 3 > 160) { reply(cur); cur = line; }
    else cur = cur ? cur + " / " + line : line;
  }
  if (cur) reply(cur);
}

// 관리자 /온라인 : 접속자 명단만 간단히 (활동까지 보려면 /어디)
function handleOnlineCommand(p) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const names = [];
  for (const [, q] of players) names.push(q.account ? q.account.nickname : guestLabel(q.name));
  if (!names.length) { reply("접속자가 없습니다."); return; }
  let cur = `온라인 ${names.length}명: `;
  for (const n of names) {
    if (cur.length + n.length + 2 > 160) { reply(cur.replace(/, $/, "")); cur = ""; }
    cur += n + ", ";
  }
  reply(cur.replace(/, $/, ""));
}

// 관리자 /추방 : 접속 중인 유저를 즉시 퇴장 (계정 닉네임 우선, 게스트 이름도 가능. 차단은 아님 — 재접속 가능)
function handleKickCommand(p, text) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const names = parseArgs(text).slice(1);
  if (!names.length) { reply("사용법: /추방 닉네임 …  (영구 차단은 /차단)"); return; }
  const done = [], missing = [];
  for (const name of names) {
    const ids = new Set(findUserIdsByName(name));
    let kicked = 0;
    for (const [, q] of players) {
      if (q === p) continue; // 자기 자신 제외
      const hit = q.account ? ids.has(q.account.userId)
        : (q.name || "").toLowerCase() === String(name).toLowerCase(); // 게스트는 온라인 이름 일치(중복 시 전부)
      if (hit) { kickPlayer(q, "관리자에 의해 연결이 종료되었습니다."); kicked++; }
    }
    if (kicked) done.push(`${name}(${kicked}명)`); else missing.push(name);
  }
  let out = done.length ? `추방 완료: ${done.join(", ")}` : "";
  if (missing.length) out += `${out ? " / " : ""}접속 중이 아님: ${missing.join(", ")}`;
  reply(out);
}

// 관리자 /차단 /차단해제 : 계정 로그인 자체를 막는다 (banned 컬럼). 차단 시 접속 중이면 즉시 추방.
//  게스트는 계정이 없어 차단 불가 → /추방으로 내보내기만 가능.
function handleBanCommand(p, text, on) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const names = parseArgs(text).slice(1);
  if (!names.length) { reply(`사용법: ${on ? "/차단" : "/차단해제"} 닉네임 …`); return; }
  const done = [], missing = [], dup = [], denied = [];
  for (const name of names) {
    const matches = findUserIdsByName(name);
    if (!matches.length) { missing.push(name); continue; }
    if (matches.length > 1) { dup.push(`${name}(${matches.join(",")})`); continue; } // 옛 중복 닉 → 아이디로 지정 요청
    const id = matches[0], u = users[id];
    if (id === ADMIN_ID) { denied.push(name); continue; } // 관리자 계정은 차단 불가
    if (on) u.banned = true; else delete u.banned;
    persistUser(id);
    done.push(u.nickname || id);
    if (on) for (const [, q] of players) if (q.account && q.account.userId === id) kickPlayer(q, "차단된 계정입니다.");
  }
  let out = done.length ? `${on ? "차단" : "차단 해제"} 완료 ${done.length}명: ${done.join(", ")}` : "";
  if (missing.length) out += `${out ? " / " : ""}없는 닉네임: ${missing.join(", ")}`;
  if (dup.length) out += `${out ? " / " : ""}닉 중복(아이디로 지정하세요): ${dup.join(", ")}`;
  if (denied.length) out += `${out ? " / " : ""}관리자 차단 불가: ${denied.join(", ")}`;
  reply(out);
}

function handleBanListCommand(p) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const banned = Object.keys(users).filter((id) => users[id].banned === true).map((id) => users[id].nickname || id);
  reply(banned.length ? `차단 ${banned.length}명: ${banned.join(", ")}` : "차단된 계정이 없습니다.");
}

// 관리자 /기록삭제 : 특정 계정의 코스 최고기록을 삭제 (인게임 TOP10/로비 랭킹에서 빠진다).
//  /기록삭제 닉네임 코스 …   코스 = A-1~A-3, B-1~B-3, C-1~C-3, 레트로1, 레트로2, 전체
const COURSE_LABEL = { a1: "A-1", a2: "A-2", a3: "A-3", racing: "B-1", hard: "B-2", serp: "B-3", c1: "C-1", c2: "C-2", c3: "C-3", retro1: "레트로1", retro2: "레트로2" };
function courseModeOf(token) {
  const t = String(token || "").toLowerCase().replace(/-/g, "");
  const map = { a1: "a1", a2: "a2", a3: "a3", b1: "racing", b2: "hard", b3: "serp", c1: "c1", c2: "c2", c3: "c3", "레트로1": "retro1", "레트로2": "retro2" };
  return map[t] || null;
}
function handleRecordDeleteCommand(p, text) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const parts = parseArgs(text).slice(1);
  if (parts.length < 2) { reply("사용법: /기록삭제 닉네임 코스 …  (코스: A-1~C-3, 레트로1, 레트로2, 전체)"); return; }
  const name = parts[0];
  const matches = findUserIdsByName(name);
  if (!matches.length) { reply(`없는 닉네임: ${name}`); return; }
  if (matches.length > 1) { reply(`닉 중복(아이디로 지정하세요): ${name}(${matches.join(",")})`); return; }
  const id = matches[0], u = users[id];
  // 코스 목록 : "전체" 면 모든 코스, 아니면 토큰별 해석 (모르는 코스는 따로 안내)
  const unknown = [];
  let modes;
  if (parts.slice(1).some((t) => t === "전체")) modes = Object.keys(COURSE_LABEL);
  else {
    modes = [];
    for (const tk of parts.slice(1)) {
      const m = courseModeOf(tk);
      if (m) modes.push(m); else unknown.push(tk);
    }
  }
  const fmt = (ms) => (ms / 1000).toFixed(2) + "초";
  const deleted = [], none = [];
  for (const mode of modes) {
    const field = RECORD_FIELD[mode];
    if (u[field]) {
      deleted.push(`${COURSE_LABEL[mode]}(${fmt(u[field])})`);
      delete u[field];
      broadcastRecords(mode); // 해당 코스 인게임 TOP10 즉시 갱신
    } else none.push(COURSE_LABEL[mode]);
  }
  if (deleted.length) {
    persistUser(id);
    for (const [, p2] of players) if (p2.account && p2.account.userId === id) { sendStats(p2); break; } // 접속 중이면 개인 기록 갱신
  }
  let out = deleted.length ? `${u.nickname || id} 기록 삭제 완료: ${deleted.join(", ")}` : "";
  if (none.length && parts[1] !== "전체") out += `${out ? " / " : ""}기록 없음: ${none.join(", ")}`;
  if (!deleted.length && !out) out = "삭제할 기록이 없습니다.";
  if (unknown.length) out += `${out ? " / " : ""}모르는 코스: ${unknown.join(", ")} (A-1~C-3, 레트로1, 레트로2, 전체)`;
  reply(out);
}

// 관리자 /닉변 : 계정 닉네임 변경 — 파일/DB 직접 수정 금지(서버 메모리 캐시가 덮어씀), 반드시 이 명령으로.
//  /닉변 대상닉네임|아이디 새닉네임   (새 닉은 12자 제한 + 계정 간 중복 금지, 회원가입과 동일 규칙)
function handleRenameCommand(p, text) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const parts = parseArgs(text);
  if (parts.length < 3) { reply('사용법: /닉변 대상닉네임 새닉네임 — 띄어쓰기 있는 닉은 "따옴표"로 묶기'); return; }
  const target = parts[1];
  const matches = findUserIdsByName(target);
  if (!matches.length) { reply(`없는 닉네임: ${target}`); return; }
  if (matches.length > 1) { reply(`닉 중복(아이디로 지정하세요): ${target}(${matches.join(",")})`); return; }
  const id = matches[0], u = users[id];
  if (!String(parts[2] || "").trim()) { reply("새 닉네임을 입력하세요."); return; }
  const nick = sanitizeName(parts[2]);
  const taken = Object.keys(users).some((uid) => uid !== id && (users[uid].nickname || "").toLowerCase() === nick.toLowerCase());
  if (taken) { reply(`이미 사용 중인 닉네임입니다: ${nick}`); return; }
  const old = u.nickname || id;
  u.nickname = nick;
  persistUser(id);
  // 접속 중이면 서버 쪽 표시(채팅/순위/릴레이 이름)도 즉시 반영 + 본인에게 안내
  for (const [, q] of players) {
    if (q.account && q.account.userId === id) {
      q.account.nickname = nick; q.name = nick;
      send(q, { type: "chat", id: 0, name: "시스템", text: `닉네임이 "${nick}"(으)로 변경되었습니다. 새로고침하면 화면에 적용됩니다.`, t: Date.now() });
    }
  }
  reply(`닉변 완료: ${old} → ${nick}`);
}

// 관리자 /점수초기화 : 경쟁전 점수를 기본(100)으로 리셋. 전적(승/판)은 유지.
//  /점수초기화 전체        → 모든 계정
//  /점수초기화 닉네임 …    → 해당 계정만 (아이디 폴백 허용)
function handleScoreResetCommand(p, text) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const names = parseArgs(text).slice(1);
  if (!names.length) { reply("사용법: /점수초기화 전체  또는  /점수초기화 닉네임1 닉네임2 …"); return; }
  const resetOne = (id) => {
    delete users[id].rankScore; // rankScoreOf 폴백 = 기본 100점
    persistUser(id);
    // 접속 중이면 대시보드 점수 즉시 갱신
    for (const [, p2] of players) if (p2.account && p2.account.userId === id) { sendStats(p2); break; }
  };
  if (names.length === 1 && names[0] === "전체") {
    let cnt = 0;
    for (const id in users) if (typeof users[id].rankScore === "number") { resetOne(id); cnt++; }
    reply(cnt ? `전체 점수 초기화 완료: ${cnt}명 → 100점 (전적은 유지)` : "초기화할 점수가 없습니다 (전원 기본 100점).");
    return;
  }
  const done = [], missing = [], dup = [];
  for (const name of names) {
    const matches = findUserIdsByName(name);
    if (!matches.length) { missing.push(name); continue; }
    if (matches.length > 1) { dup.push(`${name}(${matches.join(",")})`); continue; } // 옛 중복 닉 → 아이디로 지정 요청
    resetOne(matches[0]);
    done.push(users[matches[0]].nickname || matches[0]);
  }
  let out = done.length ? `점수 초기화 완료 ${done.length}명 → 100점: ${done.join(", ")}` : "";
  if (missing.length) out += `${out ? " / " : ""}없는 닉네임: ${missing.join(", ")}`;
  if (dup.length) out += `${out ? " / " : ""}닉 중복(아이디로 지정하세요): ${dup.join(", ")}`;
  reply(out);
}

// 관리자 /이벤트 : 유저에게 이벤트 선물 발송 — 받는 유저는 수령 전까지 접속/로비마다 팝업을 본다.
//  /이벤트 닉네임 선물이름 메세지…   (선물 이름의 공백 허용 : 공백을 제거해 GIFT_ITEMS 와 매칭)
function handleEventCommand(p, text) {
  const reply = (t) => send(p, { type: "chat", id: 0, name: "시스템", text: t, t: Date.now() });
  const parts = parseArgs(text).slice(1);
  if (parts.length < 2) { reply(`사용법: /이벤트 닉네임 선물이름 메세지 (선물: ${Object.keys(GIFT_ITEMS).join(", ")})`); return; }
  const name = parts[0];
  const matches = findUserIdsByName(name);
  if (!matches.length) { reply(`없는 닉네임: ${name} (게스트에겐 보낼 수 없습니다)`); return; }
  if (matches.length > 1) { reply(`닉 중복(아이디로 지정하세요): ${name}(${matches.join(",")})`); return; }
  // 선물 이름 : 남은 토큰을 앞에서부터 공백 없이 이어 붙이며 등록된 이름과 최장 일치
  const rest = parts.slice(1);
  let gift = null, used = 0;
  for (let i = 0, acc = ""; i < rest.length && i < 4; i++) {
    acc += rest[i];
    if (GIFT_ITEMS[acc]) { gift = GIFT_ITEMS[acc]; used = i + 1; }
  }
  if (!gift) { reply(`알 수 없는 선물: ${rest.join(" ")} (가능: ${Object.keys(GIFT_ITEMS).join(", ")})`); return; }
  const giftMsg = rest.slice(used).join(" ").slice(0, 200);
  const id = matches[0], u = users[id];
  const replaced = !!u.gift; // 미수령 선물이 이미 있으면 새 선물로 교체
  u.gift = { item: gift.item, msg: giftMsg, at: Date.now() };
  persistUser(id);
  // 접속 중이면 즉시 팝업
  for (const [, q] of players) if (q.account && q.account.userId === id) send(q, { type: "gift", msg: giftMsg });
  reply(`${u.nickname || id}님에게 선물을 보냈습니다.${replaced ? " (미수령 선물을 교체)" : ""}`);
}

// 랭크전 종료 : 우승자(완주 우선 순위 1위) 확정 → 점수 → 결과 통지 → 방 해산
function endRankRace(roomId, room) {
  const ranked = rankedRoom(roomId);
  const winnerId = ranked.length ? ranked[0].id : null;
  // 남아있는 멤버는 완주/진행도 순 등수, 중도 탈주자는 placeMap 에 없음 → 최하위
  const placeMap = new Map(ranked.map((e) => [e.id, e.rank]));
  const deltas = applyRankScores(room, placeMap);
  for (const { id, p } of roomMembers(roomId)) {
    const d = deltas.get(id);
    if (d) send(p, { type: "rankResult", win: id === winnerId, place: d.place, delta: d.delta, score: d.score, n: room.startN });
    if (p.account) sendStats(p); // 대시보드 점수 갱신
    p.roomId = null; p.active = false; p.state = null; p.rankMode = false; p.ready = false;
  }
  rooms.delete(roomId);
  console.log(`[>] rank room ${roomId} finished (winner ${winnerId}, ${room.startN} players)`);
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
        if (room.type === "rank") { // 시작 멤버/인원 확정 → 점수 배분 기준 (중도 탈주해도 패배 반영)
          const m = roomMembers(rid);
          room.startN = m.length;
          room.starters = m.filter((e) => e.p.account).map((e) => ({ uid: e.p.account.userId, id: e.id }));
        }
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

// 랙 보상 : 히스토리에서 t 시각의 위치를 선형 보간해 복원 (없으면 현재 state)
//  공격자는 상대를 "보간 지연만큼 과거"로 보고 판정하므로, 피격자를 그만큼 되감아 판정해야
//  공격자 화면과 일치한다. 되감기 상한 120ms — 과도한 되감기(고지연/조작 보고)로 인한 억울사 방지.
const REWIND_CAP_MS = 120;
function histAt(p, t) {
  const h = p.hist;
  if (!h || !h.length) return p.state;
  if (t >= h[h.length - 1].t) return h[h.length - 1];
  if (t <= h[0].t) return h[0];
  for (let i = h.length - 1; i > 0; i--) {
    const A = h[i - 1], B = h[i];
    if (t >= A.t && t <= B.t) {
      const u = B.t > A.t ? (t - A.t) / (B.t - A.t) : 1;
      let d = B.angle - A.angle; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
      return { x: A.x + (B.x - A.x) * u, y: A.y + (B.y - A.y) * u, angle: A.angle + d * u };
    }
  }
  return p.state;
}
const rewindOf = (p) => Math.min(p.viewDelay || 70, REWIND_CAP_MS);

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

      // 랙 보상 : 각 공격자의 화면 시점(보간 지연 과거)으로 피격자를 되감아 판정
      const aHitB = sweptHeadHit(A.p.prevHead, A.p.curHead, histAt(B.p, now - rewindOf(A.p)));
      const bHitA = sweptHeadHit(B.p.prevHead, B.p.curHead, histAt(A.p, now - rewindOf(B.p)));

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
  const byMode = { survival: [], a1: [], a2: [], a3: [], racing: [], hard: [], serp: [], c1: [], c2: [], c3: [], retro1: [], retro2: [], test: [] };
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
      stateAt: p.stateAt || now, // 이 state 의 진짜 샘플 시각 → v3 age
    };
    if (p.mode === "pro") {
      if (p.roomId != null) {
        const room = rooms.get(p.roomId);
        if (room && rankAnon(room)) { // 랭크전 시작 전 : 이름표/차 색/금색 관리자 가림
          entry.name = "???"; entry.color = RANK_ANON_COLOR; entry.admin = false;
        }
        if (!byRoom.has(p.roomId)) byRoom.set(p.roomId, []);
        byRoom.get(p.roomId).push(entry);
      }
    } else {
      byMode[p.mode].push(entry);
    }
  }

  // 그룹당 버전별 1회만 인코딩해 재사용 (수신자마다 재인코딩하던 O(수신자×그룹) 제거)
  const encCache = new Map(); // arr -> {v3?:Buffer, v2?:Buffer}
  const encFor = (arr, v3) => {
    let c = encCache.get(arr);
    if (!c) { c = {}; encCache.set(arr, c); }
    const k = v3 ? "v3" : "v2";
    if (!c[k]) c[k] = encodeSnapshot(now, arr, v3);
    return c[k];
  };
  const EMPTY = [];
  for (const [, p] of players) {
    if (!p.active) continue;
    let arr;
    if (p.mode === "pro") arr = (p.roomId != null) ? (byRoom.get(p.roomId) || EMPTY) : EMPTY;
    else arr = byMode[p.mode];
    sendBin(p, encFor(arr, (p.protoV || 2) === 3)); // 구클라(v2)에도 기존 포맷 병행 → 전환기 혼재 안전
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
