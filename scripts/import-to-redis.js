// users.json → Upstash Redis 1회성 이전 (파일 저장 → Redis 저장으로 갈아탈 때 한 번만 실행)
//   UPSTASH_REDIS_REST_URL / _TOKEN 환경변수가 있어야 동작 (.env 또는 docker --env-file).
//   실행 : node scripts/import-to-redis.js
//   서버와 완전히 같은 키를 쓴다 : cargame:userids (셋) + cargame:user:<id>
const fs = require("fs");
const path = require("path");
try { require("dotenv").config(); } catch {}

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 환경변수가 없습니다.");
  console.error(".env 에 넣었거나 docker 라면 --env-file .env 로 넘겼는지 확인하세요.");
  process.exit(1);
}

const USER_SET = "cargame:userids";
const userKey = (id) => "cargame:user:" + id;

(async () => {
  const file = path.join(__dirname, "..", "users.json");
  if (!fs.existsSync(file)) { console.error("users.json 을 찾을 수 없습니다:", file); process.exit(1); }
  const users = JSON.parse(fs.readFileSync(file, "utf8"));
  const ids = Object.keys(users);
  if (!ids.length) { console.error("users.json 에 계정이 없습니다."); process.exit(1); }

  const { Redis } = require("@upstash/redis");
  const redis = new Redis({ url, token });

  let n = 0;
  for (const id of ids) {
    await redis.set(userKey(id), users[id]); // 서버와 동일: 유저 객체 통째 저장(JSON 자동 직렬화)
    await redis.sadd(USER_SET, id);
    n++;
    process.stdout.write(`\r  이전 중 ${n}/${ids.length} ...`);
  }
  const back = (await redis.smembers(USER_SET)) || [];
  console.log(`\n완료 : users.json ${n}명 → Redis. 현재 Redis 안 계정 수 : ${back.length}`);
  process.exit(0);
})().catch((e) => { console.error("\n실패:", e.message); process.exit(1); });
