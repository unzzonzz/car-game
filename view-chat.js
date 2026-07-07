// 채팅 로그(chat-log.jsonl)를 터미널에서 시간 / 아이디 / 닉네임 / 메시지로 본다.
//  실행:  node view-chat.js             (전체, 오래된→최신 순)
//         node view-chat.js 100         (마지막 100개만)
//         node view-chat.js find 안녕    ("안녕" 이 들어간 메시지만)
//         node view-chat.js id unzzonzz (특정 로그인 아이디만)
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "chat-log.jsonl");
let raw;
try { raw = fs.readFileSync(FILE, "utf8"); }
catch (e) { console.error("채팅 로그가 없어요 (아직 채팅이 없거나 서버 미가동):", e.message); process.exit(1); }

let rows = raw.split("\n").filter(Boolean)
  .map((ln) => { try { return JSON.parse(ln); } catch { return null; } })
  .filter(Boolean);
if (!rows.length) { console.log("채팅 기록이 없어요."); process.exit(0); }

// --- 필터 / 제한 ---
const a = process.argv[2];
let title = "전체";
if (a === "find" && process.argv[3]) {
  const term = process.argv.slice(3).join(" ");
  rows = rows.filter((r) => String(r.text).includes(term));
  title = `"${term}" 포함`;
} else if (a === "id" && process.argv[3]) {
  const uid = process.argv[3];
  rows = rows.filter((r) => (r.uid || "") === uid);
  title = `아이디 ${uid}`;
} else if (a && /^\d+$/.test(a)) {
  const n = parseInt(a, 10);
  rows = rows.slice(-n);
  title = `마지막 ${n}개`;
}
if (!rows.length) { console.log(`조건(${title})에 맞는 채팅이 없어요.`); process.exit(0); }

// --- 포맷터 (한국시간 KST 고정) ---
const fmtDate = (ms) => {
  if (!ms) return "-";
  const d = new Date(ms + 9 * 3600 * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
// 한글(전각)은 2칸으로 세어 정렬을 맞춘다
const dispW = (s) => { let w = 0; for (const ch of String(s)) w += (ch.codePointAt(0) > 0x2E80 ? 2 : 1); return w; };
const padR = (s, w) => String(s) + " ".repeat(Math.max(0, w - dispW(s)));

// --- 출력 ---
const idOf = (r) => r.uid || "게스트";
const idW = Math.max(dispW("아이디"), ...rows.map((r) => dispW(idOf(r))));
const nickW = Math.max(dispW("닉네임"), ...rows.map((r) => dispW(r.name || "-")));

console.log(`\n채팅 ${rows.length}개  ·  ${title}  (사용법: node view-chat.js [개수] | find <말> | id <아이디>)\n`);
console.log(`${padR("시간", 19)}  ${padR("아이디", idW)}  ${padR("닉네임", nickW)}  메시지`);
console.log(`${"-".repeat(19)}  ${"-".repeat(idW)}  ${"-".repeat(nickW)}  ${"-".repeat(24)}`);
for (const r of rows) {
  const mark = r.admin ? "[관리자] " : "";
  console.log(`${padR(fmtDate(r.t), 19)}  ${padR(idOf(r), idW)}  ${padR(r.name || "-", nickW)}  ${mark}${r.text}`);
}
console.log("");
