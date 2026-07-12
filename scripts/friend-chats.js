// 친구 채팅 로그 조회 (터미널용, 읽기 전용 — 서버 실행 중에도 안전)
//   node scripts/friend-chats.js                  → 친구 채팅 전체
//   node scripts/friend-chats.js 닉네임|아이디 …    → 해당 발신자만
//   node scripts/friend-chats.js --tail 50        → 최근 50줄만
//   node scripts/friend-chats.js --all            → 전체/친구 채팅 모두 (친구는 [친구] 표시)
// 친구 채팅은 chat-log.jsonl 에 "[친구] " 접두어로 기록된다.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "chat-log.jsonl");
if (!fs.existsSync(FILE)) {
  console.error("chat-log.jsonl 이 없습니다 (아직 채팅 로그가 기록되지 않음).");
  process.exit(1);
}

const args = process.argv.slice(2);
const showAll = args.includes("--all");
let tail = 0;
const ti = args.indexOf("--tail");
if (ti >= 0) tail = parseInt(args[ti + 1], 10) || 100;
const names = args.filter((a, i) => !a.startsWith("--") && (ti < 0 || i !== ti + 1)).map((s) => s.toLowerCase());

const fmt = (t) => {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
};

let rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
}).filter(Boolean);

// 친구 채팅만 (--all 이면 전체)
if (!showAll) rows = rows.filter((r) => typeof r.text === "string" && r.text.startsWith("[친구] "));
// 발신자 필터 (닉네임 또는 아이디, 대소문자 무시)
if (names.length) {
  rows = rows.filter((r) =>
    names.includes(String(r.name || "").toLowerCase()) || names.includes(String(r.uid || "").toLowerCase()));
}
if (tail > 0) rows = rows.slice(-tail);

if (!rows.length) { console.log("표시할 채팅이 없습니다."); process.exit(0); }
console.log(`${showAll ? "전체" : "친구"} 채팅 ${rows.length}줄${names.length ? ` (발신자: ${names.join(", ")})` : ""}\n`);
for (const r of rows) {
  const friend = typeof r.text === "string" && r.text.startsWith("[친구] ");
  const text = friend ? r.text.slice(5) : r.text;
  const who = r.uid ? `${r.name}(${r.uid})` : `${r.name} [게스트]`;
  console.log(`${fmt(r.t)}  ${showAll && friend ? "[친구] " : ""}${who}${r.admin ? " [관리자]" : ""}: ${text}`);
}
