// users.json 을 터미널에서 보기 좋은 표로 출력한다 (비밀번호/토큰은 표시 안 함).
//  실행:  node view-users.js            (기본: 마지막 접속 최신순)
//  정렬:  node view-users.js best       코스 A 기록 빠른순
//         node view-users.js hard       코스 B 기록 빠른순
//         node view-users.js serp       코스 C 기록 빠른순
//         node view-users.js time       총 접속시간 많은순
//         node view-users.js wins       프로 우승 많은순
//         node view-users.js name       닉네임순
const fs = require("fs");
const path = require("path");

let users;
try { users = JSON.parse(fs.readFileSync(path.join(__dirname, "users.json"), "utf8")); }
catch (e) { console.error("users.json 을 못 읽었어요:", e.message); process.exit(1); }

const rows = Object.values(users);
if (!rows.length) { console.log("계정이 없어요."); process.exit(0); }

// --- 포맷터 ---
const fmtRace = (ms) => {                        // ms → mm:ss.cs
  if (!ms) return "-";
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(m)}:${p(s)}.${p(cs)}`;
};
const fmtDur = (ms) => {                          // ms → "N시간 M분"
  if (!ms) return "-";
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
};
const fmtDate = (ms) => {                          // ms epoch → "YYYY-MM-DD HH:MM" (한국시간 KST 고정)
  if (!ms) return "-";
  // 서버 시간대가 UTC 여도 한국시간으로 보이게 : UTC+9 offset 후 getUTC* 로 읽는다(한국은 DST 없음)
  const d = new Date(ms + 9 * 3600 * 1000), p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};

// 한글(전각)은 2칸으로 세어 정렬을 맞춘다
const dispW = (s) => { let w = 0; for (const ch of String(s)) w += (ch.codePointAt(0) > 0x2E80 ? 2 : 1); return w; };
const padR = (s, w) => String(s) + " ".repeat(Math.max(0, w - dispW(s)));
const padL = (s, w) => " ".repeat(Math.max(0, w - dispW(s))) + String(s);

// --- 정렬 ---
const key = process.argv[2] || "last";
const sorters = {
  best: (a, b) => (a.bestTime || 1e12) - (b.bestTime || 1e12),
  hard: (a, b) => (a.bestTimeHard || 1e12) - (b.bestTimeHard || 1e12),
  serp: (a, b) => (a.bestTimeSerp || 1e12) - (b.bestTimeSerp || 1e12),
  time: (a, b) => (b.totalTime || 0) - (a.totalTime || 0),
  wins: (a, b) => (b.proWins || 0) - (a.proWins || 0),
  last: (a, b) => (b.lastLogin || 0) - (a.lastLogin || 0),
  name: (a, b) => String(a.nickname).localeCompare(String(b.nickname), "ko"),
};
rows.sort(sorters[key] || sorters.last);

// --- 표 ---
const cols = [
  { h: "아이디", get: (u) => u.id || "-", pad: padR },
  { h: "닉네임", get: (u) => u.nickname || "-", pad: padR },
  { h: "코스A", get: (u) => fmtRace(u.bestTime), pad: padL },
  { h: "코스B", get: (u) => fmtRace(u.bestTimeHard), pad: padL },
  { h: "코스C", get: (u) => fmtRace(u.bestTimeSerp), pad: padL },
  { h: "우승", get: (u) => String(u.proWins || 0), pad: padL },
  { h: "플레이", get: (u) => String(u.proPlays || 0), pad: padL },
  { h: "접속시간", get: (u) => fmtDur(u.totalTime), pad: padL },
  { h: "마지막 접속", get: (u) => fmtDate(u.lastLogin), pad: padL },
];
const width = cols.map((c) => Math.max(dispW(c.h), ...rows.map((u) => dispW(c.get(u)))));
const line = (cells) => cells.map((c, i) => cols[i].pad(c, width[i])).join("  ");

console.log(`\n총 ${rows.length}명  ·  정렬: ${key}  (best/hard/serp/time/wins/name 으로 바꿀 수 있어요)\n`);
console.log(line(cols.map((c) => c.h)));
console.log(width.map((w) => "-".repeat(w)).join("  "));
for (const u of rows) console.log(line(cols.map((c) => c.get(u))));
console.log("");
