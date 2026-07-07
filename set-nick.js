// 계정 닉네임을 바꾼다 (관리자용) — users.json 을 직접 수정.
//  실행:  node set-nick.js <아이디> "<새 닉네임>"
//  ★ 실행 후 반드시:  pm2 restart car-game   (서버가 시작할 때만 파일을 읽어 반영됨)
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "users.json");

const id = process.argv[2];
const nick = (process.argv[3] || "").trim().slice(0, 12);
if (!id || !nick) {
  console.error('사용법:  node set-nick.js <아이디> "<새 닉네임>"');
  process.exit(1);
}

let users;
try { users = JSON.parse(fs.readFileSync(FILE, "utf8")); }
catch (e) { console.error("users.json 읽기 실패:", e.message); process.exit(1); }

if (!users[id]) {
  console.error(`아이디 "${id}" 를 못 찾음.\n가능한 아이디: ${Object.keys(users).join(", ") || "(없음)"}`);
  process.exit(1);
}

const old = users[id].nickname;
users[id].nickname = nick;
fs.writeFileSync(FILE, JSON.stringify(users));
console.log(`닉네임 변경 완료:  [${id}]  "${old}" -> "${nick}"`);
console.log("반영하려면 바로:  pm2 restart car-game");
