// Upstash 의 모든 계정을 서버 파일저장 형식(users.json)으로 내보낸다.
//  실행(맥, 인터넷 되는 곳):
//    export UPSTASH_REDIS_REST_URL="https://....upstash.io"
//    export UPSTASH_REDIS_REST_TOKEN="<REST 토큰>"
//    node export-users.js
//  → 같은 폴더에 users.json 생성. 이걸 학교 서버 ~/car-game/ 로 복사하면 됨.
const { Redis } = require("@upstash/redis");
const fs = require("fs");

const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!url || !token) {
  console.error("먼저 환경변수를 설정하세요:\n  export UPSTASH_REDIS_REST_URL=\"https://...upstash.io\"\n  export UPSTASH_REDIS_REST_TOKEN=\"<토큰>\"");
  process.exit(1);
}
const redis = new Redis({ url, token });

(async () => {
  const users = {};
  // cargame:user:* 키를 전부 스캔해서(집합에 없는 것까지) 계정을 모은다
  let cursor = 0;
  do {
    const res = await redis.scan(cursor, { match: "cargame:user:*", count: 100 });
    cursor = res[0];
    for (const key of res[1]) {
      const id = key.replace("cargame:user:", "");
      let u = await redis.get(key);
      if (typeof u === "string") { try { u = JSON.parse(u); } catch {} } // 혹시 문자열이면 파싱
      if (u && typeof u === "object") users[id] = u;
    }
  } while (String(cursor) !== "0");

  fs.writeFileSync("users.json", JSON.stringify(users));
  const ids = Object.keys(users);
  console.log(`${ids.length}개 계정 내보냄 → users.json`);
  console.log("아이디:", ids.join(", ") || "(없음)");
})().catch((e) => { console.error("내보내기 실패:", e.message); process.exit(1); });
