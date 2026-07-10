// 유저 정보 JSON 조회 (터미널용, 읽기 전용 — 서버 실행 중에도 안전)
//   node scripts/users.js                → 전체 유저를 JSON 으로 출력
//   node scripts/users.js 닉네임|아이디 …  → 해당 유저만 (닉네임 대소문자 무시, 아이디 폴백)
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
  const users = await loadUsers();
  const queries = process.argv.slice(2);

  let out = users;
  if (queries.length) {
    out = {};
    for (const q of queries) {
      const ql = q.toLowerCase();
      const hits = Object.keys(users).filter(
        (id) => id === q || (users[id].nickname || "").toLowerCase() === ql
      );
      if (!hits.length) console.error(`(없는 닉네임/아이디: ${q})`);
      for (const id of hits) out[id] = users[id];
    }
  }

  console.error(`저장소: ${useRedis ? "Upstash Redis" : "users.json"} · ${Object.keys(out).length}명`); // stderr — 파이프해도 JSON 만 남게
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error("실패:", e.message); process.exit(1); });
