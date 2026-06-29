# Top-View Supercar Physics Game

JavaScript + HTML5 Canvas 로 만든 탑뷰 슈퍼카 물리 엔진 게임. 외부 라이브러리 없이
관성 · 마찰 · 타이어 그립 · 슬립 앵글(드리프트) · 공기/구름저항 · 속도별 조향 감도를
구현했고, WebSocket 기반 온라인 멀티플레이를 지원한다.

## 조작

| 키 | 동작 |
|----|------|
| `W` | 가속 |
| `A` / `D` | 좌 / 우 회전 |
| `SPACE` | 브레이크 |

맵 벽에 부딪히면 맵 중앙에서 리스폰된다.

## 로컬 실행

```bash
npm install
npm start          # → http://localhost:3000
```

브라우저 탭을 여러 개 열거나, 같은 네트워크의 다른 기기에서 `http://<내IP>:3000`
으로 접속하면 서로 보인다. 서버 없이 `index.html` 을 직접 열어도 1인 모드로 동작한다.

## Render 무료 배포

이 repo 에는 [`render.yaml`](render.yaml) Blueprint 가 포함되어 있다.

1. 코드를 GitHub repo 에 푸시한다.
2. [Render 대시보드](https://dashboard.render.com) → **New +** → **Blueprint** 선택.
3. 이 repo 를 연결하면 `render.yaml` 을 읽어 자동으로 Web Service 가 생성된다.
   - Build: `npm install`
   - Start: `node server.js`
   - Plan: **Free**
4. 배포가 끝나면 `https://<서비스명>.onrender.com` 으로 접속.

> **무료 플랜 주의:** 15분 동안 접속이 없으면 서비스가 잠들고, 다음 접속 시
> 깨어나는 데 수십 초의 콜드스타트가 걸린다. 깨어 있는 동안의 WebSocket
> 멀티플레이는 정상 동작하며, 클라이언트에 자동 재접속 로직이 있어 깨어날 때
> 알아서 다시 연결된다.

Blueprint 없이 수동으로 만들 경우: New + → **Web Service** → repo 연결 →
Runtime `Node`, Build Command `npm install`, Start Command `node server.js`,
Plan `Free` 로 설정하면 동일하다. (포트는 `process.env.PORT` 로 이미 처리됨)

## 구조

| 파일 | 역할 |
|------|------|
| `index.html` / `style.css` | 화면 · HUD(속도계 · 미니맵) |
| `game.js` | 차량 물리 엔진 + 렌더 + WebSocket 클라이언트 |
| `server.js` | 정적 파일 서빙 + WebSocket 릴레이 서버 |

네트워크 모델은 **클라이언트 권위 + 서버 릴레이** 방식이다. 각 클라이언트가 자기
차량의 물리를 계산해 상태(위치 · 각도)를 30Hz 로 보내면, 서버는 전체 스냅샷을
30Hz 로 모두에게 브로드캐스트한다. 다른 차량은 보간하여 부드럽게 렌더된다.

## 튜닝

모든 물리 상수는 [`game.js`](game.js) 상단의 `CAR` 객체에 모여 있어 쉽게 조정할 수
있다. 새 차량을 추가하려면 이 객체를 복제해 수치만 바꾸면 된다.
