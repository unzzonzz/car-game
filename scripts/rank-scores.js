// 랭크전 점수 조회 (터미널용, 읽기 전용 — 서버 실행 중에도 안전)
//   node scripts/rank-scores.js          → 랭크 관련 유저만 (허용됐거나 판수 있는)
//   node scripts/rank-scores.js --all    → 전체 유저
// 저장소는 server.js 와 동일하게 고른다 : UPSTASH 환경변수 있으면 Redis, 없으면 users.json
const fs = require("fs");
const path = require("path");

const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const USER_SET = "cargame:userids";           // server.js 와 동일한 키
const userKey = (id) => "cargame:user:" + id;

async function loadUsers() {
  if (!useRedis) {
    const file = path.join(__dirname, "..", "users.json");
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const { Redis } = require("@upstash/redis");
  const redis = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
  const users = {};
  for (const id of (await redis.smembers(USER_SET)) || []) {
    const u = await redis.get(userKey(id));
    if (u) users[id] = u;
  }
  return users;
}

(async () => {
  const all = process.argv.includes("--all");
  const users = await loadUsers();
  const rows = Object.values(users)
    .filter((u) => all || u.rankAllowed === true || (u.rankPlays || 0) > 0)
    .map((u) => ({
      id: u.id, nick: u.nickname || "-",
      score: typeof u.rankScore === "number" ? u.rankScore : 100,
      wins: u.rankWins || 0, plays: u.rankPlays || 0,
      allowed: u.rankAllowed === true,
    }))
    .sort((a, b) => b.score - a.score);

  if (!rows.length) { console.log("표시할 유저가 없습니다. (--all 로 전체 보기)"); return; }
  console.log(`저장소: ${useRedis ? "Upstash Redis" : "users.json"} · ${rows.length}명\n`);
  console.log("순위  점수   전적          허용  아이디 (닉네임)");
  rows.forEach((r, i) => {
    const record = `${r.plays}전 ${r.wins}승 ${r.plays - r.wins}패`;
    console.log(
      String(i + 1).padStart(3) + "  " +
      String(r.score).padStart(4) + "점  " +
      record.padEnd(12) + "  " +
      (r.allowed ? "O" : "X") + "    " +
      `${r.id} (${r.nick})`
    );
  });
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
