"use strict";

/* =============================================================================
 *  TOP-VIEW SUPERCAR PHYSICS ENGINE
 * -----------------------------------------------------------------------------
 *  현실의 슈퍼카 거동(관성 / 마찰 / 타이어 그립 / 드리프트 / 무게감)을 목표로 한
 *  탑뷰 차량 물리 엔진입니다.  아케이드식 "speed += 값" 방식이 아니라,
 *  속도 벡터를 차체 기준 "전진 성분 / 측면 성분" 으로 분해하여 처리합니다.
 *
 *  핵심 아이디어
 *  ------------------------------------------------------------------
 *  - 차량은 "바라보는 방향(heading/angle)" 과 "실제 진행하는 속도 벡터(v)" 를
 *    별도로 가진다.
 *  - 조향은 heading 만 즉시 회전시킨다. 속도 벡터는 관성 때문에 그대로 남는다.
 *    → 이 순간 heading 과 v 가 어긋나며 "슬립 앵글(Slip Angle)" 이 생긴다.
 *  - 타이어 그립(측면 마찰)이 매 프레임 측면 속도를 조금씩 깎아 v 를 heading
 *    방향으로 끌어당긴다. 그립이 높으면 즉시 정렬(깔끔한 코너링),
 *    그립이 낮으면 천천히 정렬(드리프트/슬라이드).
 *  - 그립은 속도가 높을수록 낮아진다 → 고속에서 자연스럽게 드리프트 발생.
 *
 *  모든 튜닝 상수는 아래 CONFIG / CAR 에 모여 있어 쉽게 수정/차량 추가 가능.
 * ========================================================================== */


/* =============================================================================
 *  단위 / 전역 설정
 * ========================================================================== */
const CONFIG = {
  // 초기 스폰 기준값 (실제 위치는 모드 진입 시 재설정)
  MAP_SIZE: 5000,

  // 픽셀 <-> 미터 환산 (물리 계산은 px/s 로 하되, 화면 표시는 km/h 로 변환)
  PIXELS_PER_METER: 8,

  // 한 프레임 dt 상한 (탭 비활성 등으로 인한 물리 폭발 방지)
  MAX_DT: 1 / 30,
};

/* =============================================================================
 *  게임 모드 / 월드
 * -----------------------------------------------------------------------------
 *  - racing   : 사진 같은 꼬불꼬불한 카트 서킷. 죽음 없음. 트랙 이탈 시 감속.
 *  - hard     : 좁은 폭 + 웨이포인트 스플라인 기반의 고난도 서킷.
 *  - serp     : 완전 구불구불한 슬라럼 코스(연속 U턴). 트랙 폭 300px.
 * ========================================================================== */
const WORLD = {
  racing: { w: 10000, h: 6000, type: "track", track: null },  // 자유 레이싱
  hard: { w: 18000, h: 11500, type: "hardTrack", track: null }, // 하드 레이싱
  serp: { w: 4780, h: 3350, type: "serpTrack", track: null },  // 구불구불 레이싱
  pro: { w: 10000, h: 6000, type: "track", track: null },     // 프로 레이싱(다른 서킷)
  lobby: { w: 3600, h: 3600, type: "lobby" },                 // 로비(메인 화면) — 로컬 전용
  test: { w: 6000, h: 3400, type: "stadium", track: null },   // 테스트 : 가로로 긴 운동장 트랙 (새 플랫 디자인)
};

/* 로비 : 접속하자마자 차를 몰 수 있는 웜 화이트 월드. 게이트에 들어가면 모드 입장.
 *  게이트 = 플랫 컬러 패치(아치형 배치), 0.8초 머무르면 확정. 클릭/탭으로도 입장 가능. */
const LOBBY_SPAWN = { x: 1800, y: 2150 };

/* =============================================================================
 *  색상 팔레트 (디자인 시스템) — 캔버스로 그리는 주요 색을 한 곳에 모은다.
 *  DOM 쪽은 style.css 의 :root 토큰과 값이 짝을 이룬다. (문자열 그대로도 몇 군데 남아있음)
 * ========================================================================== */
const PALETTE = {
  // 메인화면(로비) : 웜 화이트 바닥 + 은은한 격자 + 플랫 그림자
  bg:          "#fdfcf8", // 월드 바닥 / 화면 밖
  grid:        "#f2efe8", // 로비 격자선
  gateShadow:  "#e9e4d8", // 게이트 플랫 그림자
  carShadowLobby: "#e6e0d2", // 차 그림자(로비, 흰 바닥용)
  carShadowTrack: "#cfc9ba", // 차 그림자(트랙, 회색 바닥용)
  // 플랫 트랙 : 잔디 / 아스팔트 / 흰 라인
  grass:       "#84b53d",
  asphalt:     "#6e7276",
  line:        "#ffffff",
  // 주 색상(액센트) — 게이트/포인트
  coral:       "#e8604c", // 아케이드
  blue:        "#4f8ee8", // 레이싱
  green:       "#57b868", // 광장
  yellow:      "#f2c94c", // 커스텀
  purple:      "#7a55d6", // 연습
  terracotta:  "#c75b4a", // 주행 테스트
  ink:         "#3a3a3a", // 차고 / 진한 텍스트
};

// 게이트 : 가로 한 줄의 "그룹 메뉴". 통과하면 그룹별 맵 카드 팝업이 열린다.
//  차고 게이트는 팝업 대신 차 색상 커스텀(32색 링 픽커)을 연다.
const LOBBY_GATES = [
  { group: "arcade",   label: "아케이드", color: PALETTE.coral,      x: 1160, y: 1560, w: 250, h: 150 },
  { group: "racing",   label: "레이싱",  color: PALETTE.blue,       x: 1480, y: 1560, w: 250, h: 150 },
  { group: "plaza",    label: "광장",    color: PALETTE.green,      x: 1800, y: 1560, w: 250, h: 150 },
  { group: "custom",   label: "커스텀",  color: PALETTE.yellow,     x: 2120, y: 1560, w: 250, h: 150 },
  { group: "practice", label: "연습",    color: PALETTE.purple,     x: 2440, y: 1560, w: 250, h: 150 },
  { group: "test",     label: "주행 테스트",  color: PALETTE.terracotta, x: 2760, y: 1560, w: 250, h: 150 },
  { group: "garage",   label: "차고",    color: PALETTE.ink,        x: 2600, y: 2150, w: 220, h: 140 },
];

/* 그룹별 맵 목록 (팝업 카드). mode 가 null 이면 아직 개발 전 → "준비 중" 비활성 카드.
 *  ※ 새 맵들(술래잡기/스모/광장 등)은 추후 구현 — 지금은 메뉴/팝업 구조만. */
const MAP_GROUPS = {
  arcade: {
    title: "아케이드",
    desc: "다른 플레이어들과 경쟁하는 버라이어티 맵",
    maps: [
      { name: "서바이벌", desc: "머리로 들이받아 상대를 터뜨리기", mode: null },
      { name: "술래잡기", desc: "술래를 피해 도망치는 추격전", mode: null },
      { name: "스모", desc: "링 밖으로 상대를 밀어내는 몸싸움", mode: null },
    ],
  },
  racing: {
    title: "레이싱",
    desc: "다른 플레이어들과 경쟁하는 레이싱",
    maps: [
      { name: "일반전", desc: "표준 규칙으로 달리는 기본 레이스", mode: null },
      { name: "경쟁전", desc: "실력을 겨루는 랭크 레이스", mode: null },
      { name: "캐주얼", desc: "폭풍·바람 등 판마다 색다른 기믹이 있는 이색 레이스", mode: null },
    ],
  },
  plaza: {
    title: "광장",
    desc: "다른 사용자들과 어울리는 자유 공간",
    maps: [
      { name: "채널 1", desc: "자유롭게 대화하고 어울리는 광장", mode: null },
      { name: "채널 2", desc: "자유롭게 대화하고 어울리는 광장", mode: null },
      { name: "채널 3", desc: "자유롭게 대화하고 어울리는 광장", mode: null },
    ],
  },
  // 커스텀 그룹은 팝업 없이 게이트에서 바로 방 목록(pro)으로 직행한다.
  practice: {
    title: "연습",
    desc: "다른 유저들과 함께 맵을 달리며 기록을 재는 모드",
    maps: [
      { name: "초보자 코스", desc: "완만한 코너로 달리는 입문용 서킷", mode: "racing" },
      { name: "어려움 코스", desc: "좁은 폭과 헤어핀의 고난도 서킷", mode: "hard" },
      { name: "구불구불 코스", desc: "쉼 없이 이어지는 연속 U턴 슬라럼", mode: "serp" },
    ],
  },
};
const mapPopup = { open: false, group: null };

// 초대 링크(?room=ID)로 접속하면 welcome 수신 후 해당 방으로 바로 참가 시도
let pendingRoomJoin = null;
try {
  const rp = new URLSearchParams(location.search).get("room");
  if (rp) {
    pendingRoomJoin = parseInt(rp, 10);
    history.replaceState(null, "", location.pathname); // 새로고침 시 재참가 방지
  }
} catch {}
const lobby = { ui: "idle", stopMs: 0, gate: null, prog: 0, holdGate: null }; // ui: idle | hidden

/* 차 색상 커스텀 : 32색(웜 플랫 크로마 26 + 뉴트럴 6). 코랄이 12시(기본색). */
const CAR_COLORS = [
  "#E8604C","#EF6A3B","#F2854C","#F29C4C","#F2B54C","#F2CB4C","#E7D34F","#C9D44E",
  "#A3CB4F","#79BD54","#57B868","#43AF7E","#3DAD96","#44B3AD","#4FB5C6","#55A6DC",
  "#4F8EE8","#4A73E0","#4A5FD6","#5D54D8","#7A55D6","#9855D1","#B355C9","#C955B4",
  "#DA5697","#E0577A","#FFFFFF","#E9E4D8","#B8B2A6","#7A756B","#4A4E57","#2F2F2F",
];
const CUSTOM_RING_R = 175; // 링 반지름(월드 px)
const custom = { active: false, cx: 0, cy: 0, selAnim: null }; // selAnim = 픽커(선택 링) 슬라이드 애니메이션
const modeCounts = { racing: 0, hard: 0, serp: 0, pro: 0, test: 0, total: 0 };

// 현재 모드/월드/게임 상태 (실제 시작은 하단 enterLobby() 가 로비로 설정)
let gameMode = "lobby";      // "lobby" | "racing" | "hard" | "serp" | "pro" | "test"
let world = WORLD.lobby;     // 현재 월드 치수/타입
let gameState = "menu";      // "menu" | "playing"
let playerName = "Player";

// 프로 레이싱 상태 (서버 'roomList'/'race' 메시지로 갱신)
const race = {
  state: "none",     // "none" | "browsing" | "lobby" | "countdown" | "racing"
  laps: 3,
  slot: 0,           // 내 그리드 슬롯
  list: [],          // 방 순위 [{id,name,ready,lap,finished,rank}]
  canReady: false,   // 2명 이상이면 true
  myReady: false,
  isHost: false,
  rooms: [],         // 방 목록(브라우저용)
  roomName: "", course: 0, timeLimit: 0, maxPlayers: 7, // 현재 방 설정
  countdownEnd: 0,   // 로컬 시각(performance.now): 카운트다운 끝
  endEnd: 0,         // 로컬 시각: 종료 타이머 끝 (0=없음)
  goFlashUntil: 0,   // "GO!" 표시 끝 시각
  // 내 바퀴 추적 + 레이스 타이밍
  lap: 0, prog: 0, lastPhase: 0, checkpoint: false,
  raceStartTime: 0,  // 레이스 출발 시각(performance.now) — 랩마다 리셋하지 않음
  lapMs: 0,          // 출발부터의 누적 시간(ms) — 완주 시 고정 (#time 라이브 표시용)
  lapMark: 0,        // 마지막 랩을 넘긴 순간의 누적 시간(ms) — 순위판 기록용(랩마다만 갱신)
  done: false,       // 마지막 바퀴까지 통과(완주)했는지 → 시간 정지
  finalMs: 0,        // 완주 시점의 최종 누적 기록(ms)
};

const OFFTRACK_DRAG = 2.4;   // 트랙 이탈 시 추가 감속 계수 (클수록 풀밭처럼 느려짐)
const OFFTRACK_DRAG_HARD = 6.5; // 하드 전용 : 이탈 시 매우 급격히 감속

// 자유 모드 타임어택 상태
const attack = {
  state: "idle",     // "idle" | "armed"(움직이면 시작) | "running"
  startTime: 0, ms: 0,
  lastPhase: 0, checkpoint: false, hasRun: false,
  top: [],           // 서버 TOP10 [{name, ms}]
};

const GOLD = "#ffd94d";       // 관리자 차 색
let chatHistoryLoaded = false; // 최근 채팅을 한 번만 적용 (재접속 중복 방지)
// 로그인 계정 상태
const account = {
  loggedIn: false, userId: null, nickname: "", isAdmin: false,
  proWins: 0, proPlays: 0, loginTime: 0,
  totalTime: 0,   // 평생 누적 접속 시간(ms) — 서버가 보낸 "실시간" 값
  totalTimeAt: 0, // 위 값을 수신한 클라 시각(performance 아님) — 라이브 증가 기준
  bestMs: 0,      // 자유 레이싱 개인 최고 기록(ms)
  bestHardMs: 0,  // 하드코어 레이싱 개인 최고 기록(ms)
  bestSerpMs: 0,  // 구불구불 레이싱 개인 최고 기록(ms)
};

/* =============================================================================
 *  효과음 (WebAudio 신디사이저 — 외부 오디오 파일 없이 즉석 합성)
 *  브라우저 자동재생 정책상 첫 사용자 입력(클릭/키/터치)에서 컨텍스트를 연다.
 *  종류: 버튼클릭 / 충돌 / 폭발 / 카운트다운 비프 / 출발(GO)·게임시작 /
 *        랩 완료 / 기록 갱신 / 드리프트(지속 스크리치)
 * ========================================================================== */
const SFX = (() => {
  let ctx = null, master = null, enabled = true, noiseBuf = null;
  let volume = 1; // 마스터 볼륨 (0~1) — 설정 팝업에서 조절, 기본 최대
  try { const sv = parseFloat(localStorage.getItem("sfxVolume")); if (!Number.isNaN(sv)) volume = Math.min(Math.max(sv, 0), 1); } catch {}
  let drift = null; // 드리프트 2겹 (스키드 + 스퀼 + 워블 LFO)
  let eng = null;   // 기어 시뮬 엔진 (톱니 2겹 + 서브 + 점화 트레몰로)

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { enabled = false; return null; }
    ctx = new AC();
    // 마스터 → 컴프레서 : 여러 소리가 겹쳐도 뭉개지거나 튀지 않게 (전체 품질의 핵심)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = 0.55 * volume;
    master.connect(comp);
    return ctx;
  }
  function resume() { const c = ensure(); if (c && c.state === "suspended") c.resume(); }

  // 단순 톤 (주파수 슬라이드 지원)
  function tone(freq, dur, { type = "sine", gain = 0.3, when = 0, slideTo = 0 } = {}) {
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  // 벨/마림바 톤 : 사인 배음 3겹 + 빠른 어택 + 지수 감쇠 → 둥글고 귀여운 UI 음색
  function bell(freq, dur, gain, when = 0) {
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + when;
    const parts = [[1, 1], [2.0, 0.25], [2.76, 0.13]];
    for (const [m, pg] of parts) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "sine";
      o.frequency.value = freq * m;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain * pg, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * (m === 1 ? 1 : 0.55));
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.05);
    }
  }

  // 피치가 흐르는 짧은 사인 (버블 팝 느낌)
  function blip(f1, f2, dur, gain, when = 0) {
    const c = ensure(); if (!c) return;
    const t0 = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(f1, t0);
    o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.03);
  }

  // 재사용 화이트 노이즈 버퍼
  function noiseSource() {
    const c = ensure(); if (!c) return null;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = c.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    return src;
  }

  // 필터 통과 노이즈 버스트 (임팩트/휘슬 공용)
  function nburst(dur, { gain = 0.4, type = "lowpass", freq = 800, q = 1, when = 0, freqTo = 0 } = {}) {
    const c = ensure(); if (!c) return;
    const src = noiseSource(); if (!src) return;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const t0 = c.currentTime + when;
    if (freqTo) {
      f.frequency.setValueAtTime(freq, t0);
      f.frequency.exponentialRampToValueAtTime(freqTo, t0 + dur);
    }
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  return {
    resume,
    setEnabled(v) { enabled = v; if (!v) { this.driftStop(); this.engineStop(); } },
    isEnabled() { return enabled; },
    setVolume(v) { // 0~1. 마스터 게인에 즉시 반영 + 영속
      volume = Math.min(Math.max(v, 0), 1);
      if (master) master.gain.value = 0.55 * volume;
      try { localStorage.setItem("sfxVolume", String(volume)); } catch {}
    },
    getVolume() { return volume; },

    /* ---------- UI (귀여운 벨/팝 계열) ---------- */
    click()  { if (!enabled) return; blip(520, 860, 0.07, 0.16); bell(1568, 0.07, 0.05, 0.005); }, // 버블 팝
    beep()   { if (enabled) bell(587, 0.2, 0.3); },                       // 카운트다운 : 마림바 D5
    go()     { if (!enabled) return; bell(880, 0.5, 0.32); bell(1109, 0.5, 0.22, 0.015); bell(1319, 0.6, 0.16, 0.03); }, // 출발 : A 메이저 반짝
    start()  { if (!enabled) return; [523, 659, 784, 1047].forEach((f, i) => bell(f, i === 3 ? 0.4 : 0.22, 0.26, i * 0.09)); },
    lap()    { if (!enabled) return; bell(784, 0.22, 0.28); bell(1047, 0.4, 0.3, 0.09); },
    record() { if (!enabled) return; [523, 659, 784, 1047, 1319].forEach((f, i) => bell(f, 0.3, 0.2 + i * 0.02, i * 0.07)); bell(2093, 0.5, 0.1, 0.4); },

    /* ---------- 차량 (레이어드 합성) ---------- */
    // 충돌 : 저역 썸프 + 미드 크런치 + 고역 클래터, 세기(intensity 0~1)에 비례
    collision(i = 1) {
      if (!enabled) return;
      // 푹신한 "퉁" : 저역 썸프 + 짧은 노크 + 먹먹한 로우패스 노이즈 (날카로운 고역 없음)
      tone(85, 0.22, { type: "sine", gain: 0.55 * i, slideTo: 32 });
      tone(120, 0.1, { type: "triangle", gain: 0.18 * i });
      nburst(0.14, { gain: 0.35 * i, type: "lowpass", freq: 300 });
    },
    // 폭발 : 서브 붐 + 롱 럼블 + 블라스트 + 파편 틱
    explosion() {
      if (!enabled) return;
      tone(110, 0.9, { type: "sine", gain: 0.5, slideTo: 24 });
      nburst(0.95, { gain: 0.5, type: "lowpass", freq: 180 });
      nburst(0.3, { gain: 0.45, type: "bandpass", freq: 750, q: 0.5 });
      nburst(0.05, { gain: 0.1, type: "highpass", freq: 3000, when: 0.12 });
      nburst(0.05, { gain: 0.08, type: "highpass", freq: 3400, when: 0.2 });
      nburst(0.05, { gain: 0.06, type: "highpass", freq: 2800, when: 0.3 });
    },
    // 부스트 : 위로 훑는 휘슬 + 반짝 벨 + 서브 푸시 (단계 높을수록 밝게)
    boost(stage) {
      if (!enabled) return;
      nburst(0.45, { gain: 0.26, type: "bandpass", freq: 500, q: 1.2, freqTo: 2400 + stage * 500 });
      bell(659 + stage * 220, 0.35, 0.22, 0.04);
      tone(80, 0.25, { type: "sine", gain: 0.2, slideTo: 50 });
    },

    /* ---------- 엔진 (기어 시뮬레이션) ----------
     *  톱니 2겹(디튠) + 서브 사인 + 점화 트레몰로(AM) → 로우패스.
     *  속도를 5단 기어로 나눠 기어 안에서 피치가 차오르고 변속 때 뚝 떨어진다. */
    engineStart() {
      if (!enabled) return;
      const c = ensure(); if (!c || eng) return;
      const o1 = c.createOscillator(); o1.type = "sawtooth"; o1.frequency.value = 46;
      const o2 = c.createOscillator(); o2.type = "sawtooth"; o2.frequency.value = 46 * 1.008;
      const o3 = c.createOscillator(); o3.type = "sine";     o3.frequency.value = 23;
      const g1 = c.createGain(); g1.gain.value = 0.45;
      const g2 = c.createGain(); g2.gain.value = 0.3;
      const g3 = c.createGain(); g3.gain.value = 0.6;
      const filt = c.createBiquadFilter();
      filt.type = "lowpass"; filt.frequency.value = 260; filt.Q.value = 0.8;
      const gain = c.createGain(); gain.gain.value = 0.0001;
      // 점화 트레몰로 : 낮은 사인이 볼륨을 미세하게 흔들어 "부르릉" 질감
      const trem = c.createOscillator(); trem.type = "sine"; trem.frequency.value = 69;
      const tremG = c.createGain(); tremG.gain.value = 0.028;
      trem.connect(tremG); tremG.connect(gain.gain);
      o1.connect(g1); o2.connect(g2); o3.connect(g3);
      g1.connect(filt); g2.connect(filt); g3.connect(filt);
      filt.connect(gain); gain.connect(master);
      o1.start(); o2.start(); o3.start(); trem.start();
      gain.gain.linearRampToValueAtTime(0.09, c.currentTime + 0.15);
      eng = { o1, o2, o3, trem, filt, gain };
    },
    engineUpdate(kmh, throttle = 0) {
      if (!eng || !ctx) return;
      const t = ctx.currentTime;
      // 5단 기어 : 기어 안에서 rpm(피치)이 차오르고, 변속 시점에 내려간다
      const G = [0, 55, 115, 190, 285, 430];
      let gi = 0;
      while (gi < 4 && kmh >= G[gi + 1]) gi++;
      const p = clamp((kmh - G[gi]) / (G[gi + 1] - G[gi]), 0, 1);
      const f = 46 + gi * 7 + p * 58; // 기어당 46→104 부근에서 순환 상승
      eng.o1.frequency.setTargetAtTime(f, t, 0.05);
      eng.o2.frequency.setTargetAtTime(f * 1.008, t, 0.05);
      eng.o3.frequency.setTargetAtTime(f * 0.5, t, 0.05);
      eng.trem.frequency.setTargetAtTime(f * 1.5, t, 0.05);
      // 스로틀을 밟으면 필터가 열려 "밟는 맛", 떼면 낮게 웅웅
      eng.filt.frequency.setTargetAtTime(240 + p * 320 + throttle * 380, t, 0.07);
      const g = 0.09 + 0.05 * throttle + 0.04 * Math.min(kmh / 320, 1);
      eng.gain.gain.setTargetAtTime(enabled ? g : 0.0001, t, 0.08);
    },
    engineStop() {
      if (!eng || !ctx) { eng = null; return; }
      const t = ctx.currentTime;
      try {
        eng.gain.gain.cancelScheduledValues(t);
        eng.gain.gain.setTargetAtTime(0.0001, t, 0.05);
        eng.o1.stop(t + 0.25); eng.o2.stop(t + 0.25); eng.o3.stop(t + 0.25); eng.trem.stop(t + 0.25);
      } catch {}
      eng = null;
    },

    /* ---------- 드리프트 (스키드 + 스퀼 2겹) ---------- */
    driftStart() {
      if (!enabled) return;
      const c = ensure(); if (!c || drift) return;
      const t0 = c.currentTime;
      // 낮은 스키드(러버 갈리는 몸통)
      const s1 = noiseSource(); if (!s1) return;
      const f1 = c.createBiquadFilter(); f1.type = "bandpass"; f1.frequency.value = 700; f1.Q.value = 1.1;
      const g1 = c.createGain();
      g1.gain.setValueAtTime(0.0001, t0);
      g1.gain.linearRampToValueAtTime(0.085, t0 + 0.06);
      s1.connect(f1); f1.connect(g1); g1.connect(master);
      // 높은 스퀼(끼익) + 7Hz 워블로 살아있는 느낌
      const s2 = noiseSource();
      const f2 = c.createBiquadFilter(); f2.type = "bandpass"; f2.frequency.value = 2200; f2.Q.value = 6;
      const g2 = c.createGain();
      g2.gain.setValueAtTime(0.0001, t0);
      g2.gain.linearRampToValueAtTime(0.05, t0 + 0.06);
      const lfo = c.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 7;
      const lfoG = c.createGain(); lfoG.gain.value = 220;
      lfo.connect(lfoG); lfoG.connect(f2.frequency);
      s2.connect(f2); f2.connect(g2); g2.connect(master);
      s1.start(); s2.start(); lfo.start();
      drift = { s1, s2, g1, g2, lfo };
    },
    driftStop() {
      if (!drift || !ctx) { drift = null; return; }
      const t = ctx.currentTime;
      try {
        drift.g1.gain.cancelScheduledValues(t);
        drift.g2.gain.cancelScheduledValues(t);
        drift.g1.gain.setTargetAtTime(0.0001, t, 0.05);
        drift.g2.gain.setTargetAtTime(0.0001, t, 0.05);
        drift.s1.stop(t + 0.2); drift.s2.stop(t + 0.2); drift.lfo.stop(t + 0.2);
      } catch {}
      drift = null;
    },
  };
})();

let sfxCountLit = -1; // 카운트다운에서 마지막으로 비프를 낸 불 개수(중복 방지)

// 드리프트 지속음 : 실제 미끄러지는 동안(측면속도 큼 + 어느 정도 주행 중)만 재생
let sfxDrifting = false;
function updateDriftSfx() {
  const want = gameState === "playing" && CAR.drifting && Math.abs(CAR.lf) > 20;
  if (want && !sfxDrifting) { sfxDrifting = true; SFX.driftStart(); }
  else if (!want && sfxDrifting) { sfxDrifting = false; SFX.driftStop(); }
}

// 엔진 드론 : 주행 중이면 켜고 매 프레임 속도로 피치 갱신
let sfxEngineOn = false;
function updateEngineSfx(kmh) {
  if (!SFX.isEnabled()) return;
  if (!sfxEngineOn) { sfxEngineOn = true; SFX.engineStart(); }
  SFX.engineUpdate(kmh, CAR.throttle || 0); // 스로틀에 따라 필터가 열려 "밟는 맛"
}
function stopEngineSfx() { if (sfxEngineOn) { sfxEngineOn = false; SFX.engineStop(); } }

// 부스트 단계 : 450/500/525 통과 시 단계음 (경계 떨림 방지용 히스테리시스 15)
let sfxBoostStage = 0;
function updateBoostSfx(kmh) {
  const up = [Infinity, 450, 500, 525], H = 15;
  let stage = sfxBoostStage;
  while (stage < 3 && kmh >= up[stage + 1]) stage++;       // 위로 통과 → 단계 상승
  while (stage > 0 && kmh < up[stage] - H) stage--;         // 충분히 내려가면 단계 하강
  if (stage > sfxBoostStage) SFX.boost(stage);             // 올라갈 때만 소리
  sfxBoostStage = stage;
}

// 음소거 토글 (m 키) + 가운데 하단 토스트
const muteToastEl = document.getElementById("muteToast");
function showMuteToast(text) {
  if (!muteToastEl) return;
  muteToastEl.textContent = text;
  muteToastEl.classList.remove("show");
  void muteToastEl.offsetWidth; // 리플로우 → 연타해도 애니메이션 재시작
  muteToastEl.classList.add("show");
}
function toggleMute() {
  const enable = !SFX.isEnabled();
  SFX.setEnabled(enable);
  // 프레임 오디오 플래그 리셋 → 음소거 해제 시 엔진/드리프트가 다시 시작되도록
  sfxEngineOn = false; sfxDrifting = false; sfxBoostStage = 0;
  showMuteToast(enable ? "음소거 해제" : "음소거");
}

/* =============================================================================
 *  설정 : HUD(미니맵/채팅) 모서리 배치 — body 클래스로 적용, localStorage 영속.
 *  CSS 는 body:not(.lobby) 스코프라 로비 레이아웃엔 영향 없음.
 * ========================================================================== */
const HUD_CORNERS = ["tl", "tr", "bl", "br"];
const hudLayout = { mm: "bl", chat: "br" }; // 기본 = 현재 배치 (미니맵 좌하 / 채팅 우하)
try { Object.assign(hudLayout, JSON.parse(localStorage.getItem("hudLayout") || "{}")); } catch {}
function applyHudLayout() {
  if (!HUD_CORNERS.includes(hudLayout.mm)) hudLayout.mm = "bl";
  if (!HUD_CORNERS.includes(hudLayout.chat)) hudLayout.chat = "br";
  for (const c of HUD_CORNERS) document.body.classList.remove("mm-" + c, "chat-" + c);
  document.body.classList.add("mm-" + hudLayout.mm, "chat-" + hudLayout.chat);
}
function saveHudLayout() {
  try { localStorage.setItem("hudLayout", JSON.stringify(hudLayout)); } catch {}
}
/* 우측 상단 TOP10 패널(순위표/기록표)이 떠 있으면, 우상단에 놓인 미니맵·채팅이
   그 아래로 내려가도록 --top10bottom (패널 아래 y좌표)을 계산해 둔다. 안 떠 있으면 18px. */
function updateTop10Offset() {
  const stand = document.getElementById("standings");
  const recs = document.getElementById("topRecords");
  let panel = null;
  if (stand && stand.style.display !== "none") panel = stand;
  else if (recs && recs.style.display !== "none") panel = recs;
  const bottom = panel ? 18 + panel.offsetHeight + 12 : 18;
  document.body.style.setProperty("--top10bottom", bottom + "px");
}
applyHudLayout();

/* 현재 속력 표시 여부 : 기본 꺼짐. 설정에서 켜면 인게임 좌측 상단에 표시. localStorage 영속. */
let showSpeed = false;
try { showSpeed = localStorage.getItem("showSpeed") === "1"; } catch {}
function applySpeedVisibility() {
  const el = document.getElementById("speed");
  const ingame = gameState === "playing" && gameMode !== "lobby";
  if (el) el.style.display = (showSpeed && ingame) ? "block" : "none";
}

/* 연습(타임어택) 중 다른 유저 표시 여부 : 켜면 원격 차량을 화면/미니맵에 그린다. localStorage 영속.
 *  프로 등 경쟁 모드에선 항상 보이고, 이 토글은 연습/타임어택에서만 적용된다. */
let showOthers = true;
try { showOthers = localStorage.getItem("showOthers") !== "0"; } catch {}
function othersVisible() { return showOthers || !isTimeAttackMode(); }
function applyOthersToggle() {
  const btn = document.getElementById("othersToggle");
  if (btn) btn.textContent = showOthers ? "다른 차 표시" : "다른 차 숨김";
}

/* 시야각(FOV) : "기본 줌에 곱하는 배율". 값이 클수록 넓게 보인다(줌아웃). 기본 50 = ×1.0(원래 그대로).
 *  선형(등분) 매핑 : fov 50 → ×1.0, fov 100 → ×0.8333(= 예전 60값). 각 스텝마다 배율이 균등하게 변한다.
 *  인게임/로비 모든 줌(주행·줌아웃·줌인)에 똑같이 곱해진다. 설정 슬라이더로 조절(40~100), localStorage 영속. */
let fov = 50;
try { const v = parseInt(localStorage.getItem("fov"), 10); if (!Number.isNaN(v)) fov = Math.min(Math.max(v, 40), 100); } catch {}
function fovMult() { return 1 - (fov - 50) / 300; } // 50→1.0, 100→0.8333, 등분(선형)
function zoomFor(base) { return base * fovMult(); }

/* 레이싱 트랙(카트 서킷) ------------------------------------------------------
 *  중심선을 "별모양 보장(자기교차 없음)" 극좌표식 폐곡선으로 생성한다.
 *      point(θ) = center + ( R(θ)·cosθ , R(θ)·sinθ ),  R(θ) > 0
 *  여러 주파수의 사인을 더해 코너가 많은 굽이진 서킷을 만든다. R 이 항상
 *  양수라 중심에서 별모양이라 절대 자기 자신과 교차하지 않는다.
 *  자유/프로는 하모닉만 달리해 비슷하지만 다른 트랙을 만든다. */
/* 폐곡선 점열을 부드러운 Path2D 로 만든다 : 각 정점을 제어점으로, 이웃 변의 중점을
 *  이어가는 2차 베지어(midpoint-quadratic). 정점 수와 무관하게 C1 연속의 매끈한 곡선이 되며
 *  직선 구간(공선 중점)은 그대로 직선으로 남는다. 물리(centerline)는 원본 점열을 그대로 쓴다. */
function buildSmoothClosedPath(pts) {
  const n = pts.length;
  const path = new Path2D();
  if (n < 3) {
    pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
    if (n) path.closePath();
    return path;
  }
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const m0 = mid(pts[n - 1], pts[0]); // 시작 = 마지막 변의 중점
  path.moveTo(m0.x, m0.y);
  for (let i = 0; i < n; i++) {
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const m = mid(cur, next);
    path.quadraticCurveTo(cur.x, cur.y, m.x, m.y); // 정점=제어점 → 다음 변 중점까지
  }
  path.closePath();
  return path;
}

function makeTrack(opts) {
  const N = 260, raw = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const R = opts.R(a);
    raw.push({ x: Math.cos(a) * R * opts.stretch, y: Math.sin(a) * R });
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of raw) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const inset = opts.halfWidth + opts.kerb + 120;
  const scale = Math.min((opts.w - 2 * inset) / (maxX - minX), (opts.h - 2 * inset) / (maxY - minY));
  const offX = (opts.w - (maxX - minX) * scale) / 2 - minX * scale;
  const offY = (opts.h - (maxY - minY) * scale) / 2 - minY * scale;
  const centerline = raw.map(p => ({ x: p.x * scale + offX, y: p.y * scale + offY }));

  const path = buildSmoothClosedPath(centerline); // 부드러운 곡선 렌더 경로

  const a0 = centerline[0], a1 = centerline[1];
  const start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
  return { halfWidth: opts.halfWidth, kerb: opts.kerb, centerline, path, start };
}

function catmullRom(p0, p1, p2, p3, t, tension = 0.38) {
  const t2 = t * t;
  const t3 = t2 * t;
  const m1x = (p2.x - p0.x) * tension;
  const m1y = (p2.y - p0.y) * tension;
  const m2x = (p3.x - p1.x) * tension;
  const m2y = (p3.y - p1.y) * tension;
  return {
    x: (2 * t3 - 3 * t2 + 1) * p1.x + (t3 - 2 * t2 + t) * m1x + (-2 * t3 + 3 * t2) * p2.x + (t3 - t2) * m2x,
    y: (2 * t3 - 3 * t2 + 1) * p1.y + (t3 - 2 * t2 + t) * m1y + (-2 * t3 + 3 * t2) * p2.y + (t3 - t2) * m2y,
  };
}

function makeHardTrack(points, opts) {
  let centerline = [];
  const n = points.length;
  const samplesPerSegment = opts.samplesPerSegment || 24;

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
    for (let s = 0; s < samplesPerSegment; s++) {
      centerline.push(catmullRom(p0, p1, p2, p3, s / samplesPerSegment, opts.tension));
    }
  }

  const startOffset = ((opts.startPointIndex || 0) * samplesPerSegment) % centerline.length;
  if (startOffset) centerline = centerline.slice(startOffset).concat(centerline.slice(0, startOffset));

  const path = buildSmoothClosedPath(centerline); // 부드러운 곡선 렌더 경로

  const a0 = centerline[0], a1 = centerline[1];
  const start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
  return { halfWidth: opts.halfWidth, kerb: opts.kerb, centerline, path, start };
}

/* 자유 레이싱 = 항상 "원래 맵"으로 고정 (랜덤 X) */
const FREE_RECIPE = {
  w: 10000, h: 6000, halfWidth: 230, kerb: 26, stretch: 1.7,
  R: a => 1 + 0.16 * Math.sin(2 * a + 0.6) + 0.30 * Math.sin(3 * a + 0.4)
        + 0.18 * Math.sin(5 * a + 1.3) + 0.10 * Math.sin(7 * a + 0.2),
};

/* 프로 레이싱 전용 맵 풀 (더 구불구불, 5종). 서버가 인덱스를 정해 같은 레이스의
 *  모든 플레이어가 같은 맵을 보게 한다. R 진폭 합 < 1 → 항상 R>0(자기교차 없음).
 *  server.js 의 PRO_RECIPE_COUNT 와 개수를 맞춰야 한다. */
const PRO_RECIPES = [
  { w: 10000, h: 6000, halfWidth: 215, kerb: 25, stretch: 1.6,
    R: a => 1 + 0.22 * Math.sin(2 * a + 1.5) + 0.18 * Math.sin(3 * a + 2.2)
          + 0.24 * Math.sin(4 * a + 0.5) + 0.14 * Math.sin(6 * a + 1.0) },
  { w: 10000, h: 6000, halfWidth: 210, kerb: 24, stretch: 1.75,
    R: a => 1 + 0.16 * Math.sin(2 * a + 0.2) + 0.26 * Math.sin(3 * a + 1.8)
          + 0.18 * Math.sin(5 * a + 0.7) + 0.14 * Math.sin(7 * a + 2.0) + 0.08 * Math.sin(9 * a + 0.4) },
  { w: 10000, h: 6000, halfWidth: 220, kerb: 26, stretch: 1.55,
    R: a => 1 + 0.24 * Math.sin(2 * a + 2.5) + 0.16 * Math.sin(4 * a + 0.9)
          + 0.22 * Math.sin(5 * a + 1.6) + 0.10 * Math.sin(7 * a + 0.3) + 0.08 * Math.sin(8 * a + 2.2) },
  { w: 10000, h: 6000, halfWidth: 205, kerb: 24, stretch: 1.7,
    R: a => 1 + 0.18 * Math.sin(2 * a + 1.0) + 0.24 * Math.sin(3 * a + 0.5)
          + 0.16 * Math.sin(5 * a + 2.3) + 0.16 * Math.sin(6 * a + 1.2) + 0.10 * Math.sin(8 * a + 0.6) },
  { w: 10000, h: 6000, halfWidth: 218, kerb: 25, stretch: 1.65,
    R: a => 1 + 0.20 * Math.sin(2 * a + 0.9) + 0.20 * Math.sin(3 * a + 2.6)
          + 0.20 * Math.sin(4 * a + 1.4) + 0.12 * Math.sin(6 * a + 0.2) + 0.10 * Math.sin(9 * a + 1.9) },
];

const HARD_POINTS = [
  // 1) 긴 직선 스타트
  { x: 1300, y: 1400 },
  { x: 3300, y: 1400 },
  { x: 5700, y: 1400 },
  { x: 7200, y: 1500 },

  // 2) 큰 감속이 필요한 180도 헤어핀
  { x: 8350, y: 2050 },
  { x: 8900, y: 3150 },
  { x: 8200, y: 4300 },
  { x: 6450, y: 4450 },

  // 3) S 코너: 헤어핀 아래쪽으로 크게 돌아 내려갔다 오른쪽으로 (헤어핀과 겹치지 않게)
  { x: 5400, y: 4950 },
  { x: 6600, y: 5650 },
  { x: 8300, y: 5350 },
  { x: 9500, y: 5000 },
  { x: 10800, y: 3700 },
  { x: 10300, y: 5400 },

  // 4) 브레이킹 타이밍을 늦게 가져가는 복합 코너
  { x: 11100, y: 5150 },
  { x: 12400, y: 6350 },
  { x: 13800, y: 6200 },
  { x: 15050, y: 7400 },

  // 5) 라인을 타면 풀악셀 가능한 초고속 코너
  { x: 16200, y: 9000 },
  { x: 14500, y: 10350 },
  { x: 12000, y: 10650 },
  { x: 9200, y: 10150 },
  { x: 6900, y: 9250 },

  // 6) 마지막 연속 헤어핀 U U U
  { x: 5000, y: 9850 },
  { x: 3550, y: 10600 },
  { x: 2250, y: 9700 },
  { x: 3850, y: 8750 },
  { x: 2250, y: 7800 },
  { x: 1150, y: 6650 },
  { x: 2400, y: 5350 },
  { x: 1400, y: 4050 },
  { x: 2450, y: 2750 },
];

// 프로 트랙을 인덱스로 만들고 캐시한다 (한 번 만든 맵은 재사용)
const proTrackCache = new Map();
function buildProTrack(index) {
  const i = ((index % PRO_RECIPES.length) + PRO_RECIPES.length) % PRO_RECIPES.length;
  if (!proTrackCache.has(i)) proTrackCache.set(i, makeTrack(PRO_RECIPES[i]));
  return proTrackCache.get(i);
}

function generateTrack() {
  WORLD.racing.track = makeTrack(FREE_RECIPE); // 자유 = 고정
  WORLD.pro.track = buildProTrack(0);          // 프로 기본값 (서버 인덱스로 교체됨)
}

function generateHardTrack() {
  WORLD.hard.track = makeHardTrack(HARD_POINTS, {
    halfWidth: 112, // 총 트랙 폭 224px (자유 460px의 절반 이하 — 정밀 주행 요구)
    kerb: 16,
    samplesPerSegment: 28,
    startPointIndex: 1,
    tension: 0.34,
  });
}

/* 구불구불 레이싱 : 연속 U턴(슬라럼) 폐곡선. 짧고 좁은 기둥 8개를 가파른 U턴으로
 *  촘촘히 잇고(직선 짧게·구불구불 많게), 마지막에 바깥(아래→왼쪽)으로 돌아 시작점으로
 *  닫는다. 가로로 길쭉한 맵 → 잘하는 사람 기준 30초 미만. */
const SERP_POINTS = [
  { x: 1200, y: 612.5 }, { x: 1200, y: 2037.5 },   // 기둥0 (아래로)
  { x: 1540, y: 2037.5 }, { x: 1540, y: 612.5 },   // 기둥1 (위로)
  { x: 1880, y: 612.5 }, { x: 1880, y: 2037.5 },   // 기둥2 (아래로)
  { x: 2220, y: 2037.5 }, { x: 2220, y: 612.5 },   // 기둥3 (위로)
  { x: 2560, y: 612.5 }, { x: 2560, y: 2037.5 },   // 기둥4 (아래로)
  { x: 2900, y: 2037.5 }, { x: 2900, y: 612.5 },   // 기둥5 (위로)
  { x: 3240, y: 612.5 }, { x: 3240, y: 2037.5 },   // 기둥6 (아래로)
  { x: 3580, y: 2037.5 }, { x: 3580, y: 612.5 },   // 기둥7 (위로)
  { x: 4280, y: 2737.5 },                          // 바깥 복귀 : 우하단
  { x: 750,  y: 2737.5 },                          // 좌하단
  { x: 750,  y: 612.5 },                           // 좌상단 → 시작점으로 닫힘
];

function generateSerpTrack() {
  WORLD.serp.track = makeHardTrack(SERP_POINTS, {
    halfWidth: 105, // 총 트랙 폭 210px (좁게 — 회전 여유 축소)
    kerb: 16,
    samplesPerSegment: 28,
    startPointIndex: 0,
    tension: 0.34,
  });
}

/* 테스트 맵 : 가로로 긴 운동장(스타디움) 트랙 — 직선 2 + 반원 2 의 단순한 링.
 *  새 플랫 디자인 검증용. 기존 트랙 시스템(센터라인/폭/위상)을 그대로 쓴다. */
function makeStadiumTrack() {
  const cx = 3000, cy = 1700;   // 월드 중앙
  const A = 1500, R = 800;      // 직선 절반 길이 / 반원 반지름
  const hw = 220;               // 트랙 절반 폭 (넉넉하게)
  const pts = [];
  const SEG = 44;
  // 아래 직선 (왼→오)
  for (let i = 0; i < SEG; i++) pts.push({ x: cx - A + (2 * A) * (i / SEG), y: cy + R });
  // 오른쪽 반원 (아래→위)
  for (let i = 0; i < SEG; i++) {
    const th = (Math.PI / 2) - Math.PI * (i / SEG);
    pts.push({ x: cx + A + R * Math.cos(th), y: cy + R * Math.sin(th) });
  }
  // 위 직선 (오→왼)
  for (let i = 0; i < SEG; i++) pts.push({ x: cx + A - (2 * A) * (i / SEG), y: cy - R });
  // 왼쪽 반원 (위→아래)
  for (let i = 0; i < SEG; i++) {
    const th = (3 * Math.PI / 2) - Math.PI * (i / SEG);
    pts.push({ x: cx - A + R * Math.cos(th), y: cy + R * Math.sin(th) });
  }
  const path = buildSmoothClosedPath(pts); // 부드러운 곡선 렌더 경로
  const a0 = pts[0], a1 = pts[1];
  const start = { x: a0.x, y: a0.y, angle: Math.atan2(a1.y - a0.y, a1.x - a0.x) };
  return { halfWidth: hw, kerb: 0, centerline: pts, path, start };
}

function generateTracks() {
  generateTrack();
  generateHardTrack();
  generateSerpTrack();
  WORLD.test.track = makeStadiumTrack();
}

// km/h -> px/s 변환 계수.  (km/h ÷ 3.6 = m/s) × (m -> px)
const KMH_TO_PXS = (1 / 3.6) * CONFIG.PIXELS_PER_METER;
// px/s -> km/h (속도계 표시에 사용)
const PXS_TO_KMH = 1 / KMH_TO_PXS;


/* =============================================================================
 *  차량 데이터 구조
 * -----------------------------------------------------------------------------
 *  향후 여러 차량을 추가하기 쉽도록 "스펙(불변)" 과 "상태(매 프레임 변함)" 를
 *  하나의 객체로 두고, 스펙 값은 모두 여기 상단에서 튜닝한다.
 *  새 차량을 추가할 땐 이 객체를 복제해 수치만 바꾸면 된다.
 * ========================================================================== */
const CAR = {
  // ---- 스펙 (튜닝 값) -------------------------------------------------------
  maxSpeed: 1200,          // 최고속도 (km/h) — 이 값을 절대 넘지 않음
  acceleration: 165,      // 트랙션 한계 가속도 (px/s²) — 출발 시 최대 가속(접지력 한계)
  brakePower: 230,        // 브레이크 감속도 (px/s²) — 강력하지만 즉시정지 X (ABS 느낌)

  reverseSpeed: 50,       // 후진 최고속도 (km/h) — 전진보다 훨씬 느리게
  reverseAccel: 90,       // 후진 가속도 (px/s²) — 전진보다 약하게

  grip: 13.0,             // 평상시 측면 그립 계수 (1/s) — 클수록 미끄럼 즉시 제거(드리프트 X)
  driftGrip: 1.2,         // 브레이크 드리프트 시 측면 그립 (1/s) — 작을수록 더 크게 옆으로 미끄러짐
  brakeDriftSpeed: 110,   // 이 속도(km/h) 이상에서 브레이크를 밟아야 드리프트 발생

  steering: 3.0,          // 최대 조향 각속도 (rad/s) — 풀 카운터 시 1초에 회전하는 라디안
  highSpeedSteer: 0.40,   // 고속에서 남는 조향 권한 비율 (0~1) — 고속일수록 핸들 둔해짐
  driftSteerBoost: 1.7,   // 드리프트 중 조향 권한 배수 — 뒤가 풀려 차가 더 잘 돌아 슬립각↑

  weight: 1500,           // 차량 질량 (kg) — 무게감/반응속도(조향 램프, 그립 회복)에 사용

  airResistance: 7.0e-5,  // 공기저항 계수 — 감속 ∝ 속도² (고속에서 커짐). 낮출수록 관성↑
  rollingResistance: 0.012, // 구름저항 계수 — 감속 ∝ 속도 (저속 코스팅). 낮출수록 더 오래 굴러감

  enginePower: 0,         // 엔진 출력 — init()에서 maxSpeed 기준으로 자동 산출

  // 차체 크기 (px) — 렌더 및 충돌용
  length: 38,
  width: 18,

  // ---- 상태 (매 프레임 갱신) ------------------------------------------------
  x: CONFIG.MAP_SIZE / 2,  // 월드 좌표 x
  y: CONFIG.MAP_SIZE / 2,  // 월드 좌표 y
  angle: -Math.PI / 2,     // 바라보는 방향(heading). -90° = 화면상 위쪽

  vx: 0, vy: 0,            // 월드 좌표 속도 벡터 (px/s)
  lf: 0,                   // 차체 기준 전진 속도 성분 (local forward)
  ll: 0,                   // 차체 기준 측면 속도 성분 (local lateral) — 드리프트의 핵심

  // 입력(부드럽게 보간된 값)
  throttle: 0,             // 0~1
  braking: 0,              // 0~1
  reversing: 0,            // 0~1 (S 키) — 후진
  steerInput: 0,           // -1(좌) ~ +1(우), 부드럽게 램프됨

  drifting: false,         // 현재 브레이크 드리프트 중인지 (자국/조향/네트워크 공통 기준)
  invulnUntil: 0,          // 이 시각(performance.now ms)까지 무적 — 부활 직후 보호
};


/* =============================================================================
 *  우클릭 / 개발자도구 차단 (캐주얼 억제용 — 완전 차단은 불가)
 * -----------------------------------------------------------------------------
 *  주의: 브라우저 메뉴·JS 비활성화·디바이스 모드 등으로 우회 가능하므로
 *  "보안"이 아니라 "초보 방지" 수준이다. 진짜 방지는 서버 권위 검증이 필요.
 * ========================================================================== */
// 우클릭(컨텍스트 메뉴) 차단
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 개발자도구/소스보기 단축키 차단 (capture 단계에서 먼저 가로챔)
window.addEventListener("keydown", (e) => {
  const k = (e.key || "").toLowerCase();
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  if (
    e.key === "F12" ||                                         // F12
    (ctrlOrCmd && e.shiftKey && (k === "i" || k === "j" || k === "c")) || // 검사/콘솔
    (ctrlOrCmd && k === "u")                                   // 소스 보기
  ) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);


/* =============================================================================
 *  입력 처리
 * ========================================================================== */
const keys = { w: false, a: false, s: false, d: false, space: false };

// Enter 로 채팅창을 포커스한 그 Enter 의 keyup 이 곧바로 전송/blur 되는 것을 막는 플래그
let chatFocusGuard = false;

// 텍스트 입력(이름창)에 포커스가 있거나 메뉴 화면이면 게임 키 입력을 무시한다.
function typingInInput() {
  const el = document.activeElement;
  return el && el.tagName === "INPUT";
}

window.addEventListener("keydown", e => {
  if (e.key !== 'Escape') return;
  // 팝업이 열려 있으면 그것부터 닫는다. 모든 팝업 닫기에 메뉴 클릭음(버튼 클릭과 동일).
  //  ESC 는 keydown 이라 전역 버튼-클릭음 핸들러가 안 걸리므로 여기서 직접 울린다.
  const escPopups = [
    ["settingsModal", hideSettingsModal],
    ["accountModal", hideAccountModal],
    ["dashboard", hideDashboard],
    ["authModal", hideAuthModal],
  ];
  for (const [id, hide] of escPopups) {
    if (document.getElementById(id).classList.contains("show")) { SFX.click(); hide(); return; }
  }
  if (gameMode === "lobby") {
    if (mapPopup.open) { SFX.click(); closeMapPopup(); return; }      // 게이트 맵 팝업 닫기
    if (race.state === "lobby") { SFX.click(); sendLeaveRoom(); return; }   // 대기실 → 방 나가기
    if (race.state === "browsing") { SFX.click(); closeCustomRooms(); return; } // 커스텀 방 목록 닫기
    lobbyIdle(); // 로비: 그 자리에서 줌인 + 메뉴 오버레이 복귀
  } else {
    wipeTo(toMenu, { title: "로비", desc: "차를 몰아 게이트로 입장하세요" }); // 인게임 → 로비
  }
})

window.addEventListener("keydown", (e) => {
  // Enter : 입력창에 포커스가 없으면 채팅 입력창으로 바로 포커스
  if (e.code === "Enter" && !typingInInput() && gameState === "playing") {
    document.getElementById("chatInput").focus();
    chatFocusGuard = true; // 이 Enter 의 keyup 은 전송이 아니라 포커스용
    e.preventDefault();
    return;
  }
  if (typingInInput()) return; // 입력창(이름/채팅) 사용 중엔 WASD/S/Space 가로채지 않음
  switch (e.code) {
    case "KeyW": keys.w = true; break;
    case "KeyA": keys.a = true; break;
    case "KeyS": keys.s = true; break;
    case "KeyD": keys.d = true; break;
    case "Space": keys.space = true; e.preventDefault(); break;
    case "KeyM": if (!e.repeat) toggleMute(); break; // 음소거 토글 (길게 눌러도 1회)
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.code) {
    case "KeyW": keys.w = false; break;
    case "KeyA": keys.a = false; break;
    case "KeyS": keys.s = false; break;
    case "KeyD": keys.d = false; break;
    case "Space": keys.space = false; break;
  }
});


/* =============================================================================
 *  유틸리티
 * ========================================================================== */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;

// 차량의 현재 진행 속력(스칼라, px/s)
function speedOf(car) {
  return Math.hypot(car.vx, car.vy);
}

function isTrackWorld() {
  return world.type === "track" || world.type === "hardTrack" || world.type === "serpTrack" || world.type === "stadium";
}

/* 플랫(서킷) 디자인을 쓰는 모드 : 테스트/초보자/어려움/구불구불 + 커스텀(pro).
 *  회색 아스팔트 + 흰 라인 — 모든 레이싱 코스가 동일한 플랫 디자인. */
function isFlatTrackMode() {
  return gameMode === "test" || gameMode === "racing" || gameMode === "hard"
      || gameMode === "serp" || gameMode === "pro";
}


/* =============================================================================
 *  초기화 — maxSpeed 와 저항 계수로부터 엔진 출력을 역산
 * -----------------------------------------------------------------------------
 *  엔진은 "출력(파워) 한계" 모델을 쓴다 :  구동 가속도 = power / 속도.
 *  → 저속에선 트랙션 한계(acceleration)로 제한되고,
 *    고속에선 1/속도 로 줄어들어 자연스럽게 최고속도에서 멈춘다.
 *  최고속도 vmax 에서 (구동 가속도 == 저항 가속도) 가 되도록 power 를 정한다 :
 *      power / vmax = air·vmax² + roll·vmax
 *      power        = air·vmax³ + roll·vmax²
 * ========================================================================== */
function init() {
  const vmax = CAR.maxSpeed * KMH_TO_PXS;
  CAR.enginePower =
    CAR.airResistance * vmax * vmax * vmax +
    CAR.rollingResistance * vmax * vmax;

  generateTracks(); // 자유/프로 레이싱 트랙 생성
}


/* =============================================================================
 *  물리 파이프라인
 *  입력 → 조향 → (속도 분해) → 엔진 → 브레이크 → 공기/구름저항
 *       → 그립(측면마찰) → 속도/위치 → 충돌 → 카메라 → 렌더
 * ========================================================================== */

/* 1) 입력 처리 ---------------------------------------------------------------
 *  키 상태를 차량의 연속 입력값으로 변환한다.
 *  특히 조향은 즉시 -1/+1 로 튀지 않고 목표값으로 "램프(ramp)" 시켜
 *  무거운 차의 핸들 반응 지연을 표현한다 (무게가 클수록 느리게 반응). */
function updateInput(car, dt) {
  // 프로 레이싱 로비/카운트다운 동안엔 움직일 수 없다 (그리드에서 정지)
  if (gameMode === "pro" && race.state !== "racing") {
    car.throttle = 0; car.braking = 0; car.reversing = 0; car.steerInput = 0;
    car.vx = 0; car.vy = 0; car.lf = 0; car.ll = 0;
    return;
  }

  car.throttle = keys.w ? 1 : 0;
  car.braking = keys.space ? 1 : 0;
  car.reversing = keys.s ? 1 : 0;

  // 목표 조향 : A=좌(-1), D=우(+1)
  const target = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);

  // 무게 기반 조향 반응 속도. 무거울수록 핸들 입력이 천천히 찬다.
  const responsiveness = 9000 / car.weight; // 1500kg -> 6.0 /s
  const t = clamp(responsiveness * dt, 0, 1);
  car.steerInput = lerp(car.steerInput, target, t);
}

/* 2) 조향 -------------------------------------------------------------------
 *  heading(바라보는 방향)만 회전시킨다. 속도 벡터는 건드리지 않으므로
 *  이 순간부터 heading 과 진행방향이 어긋나기 시작한다(=슬립 앵글의 씨앗).
 *  - 정지 상태에선 회전하지 않는다(제자리 회전 방지) → 탱크 조향 배제.
 *  - 고속일수록 조향 권한이 줄어 급격한 방향전환을 막는다(고속 안정성). */
function updateSteering(car, dt) {
  const speed = speedOf(car);
  const speedRatio = clamp(speed / (car.maxSpeed * KMH_TO_PXS), 0, 1);

  // 저속 게이트 : 속도가 거의 0이면 조향 거의 없음, 일정 속도부터 완전 적용
  const lowSpeedGate = clamp(speed / (25 * KMH_TO_PXS), 0, 1);

  // 고속 권한 감소 : 1(저속) → highSpeedSteer(고속) 로 보간
  let authority = lerp(1, car.highSpeedSteer, speedRatio);

  const trail =
      car.braking > 0 &&
      car.braking < 0.8 &&
      speed > 90 * KMH_TO_PXS &&
      Math.abs(car.steerInput) > 0.15;

  if (trail) {
      authority *= 1.18;
  }

  // 드리프트 중엔 뒤가 풀려 차가 더 잘 돈다 → 조향 권한을 키워 슬립각을 크게 만든다
  //  (car.drifting 은 직전 프레임 updateGrip 에서 갱신된 값 — 한 프레임 지연은 무시 가능)
  if (car.drifting) authority *= car.driftSteerBoost;

  const turnRate = car.steering * car.steerInput * authority * lowSpeedGate;
  car.angle += turnRate * dt;
}

/* (속도 분해) ----------------------------------------------------------------
 *  월드 속도 벡터 v 를 "현재 heading 기준" 전진/측면 성분으로 분해한다.
 *  heading 벡터  f = (cos a, sin a)
 *  우측  벡터    r = (-sin a, cos a)
 *  lf = v·f (전진),  ll = v·r (측면). */
function decompose(car) {
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  car.lf = car.vx * cos + car.vy * sin;
  car.ll = -car.vx * sin + car.vy * cos;
}

/* 3) 엔진 가속 ---------------------------------------------------------------
 *  구동 가속도 = enginePower / 속도, 단 트랙션 한계(acceleration)로 상한.
 *  → 출발 직후엔 일정한 강한 가속(접지 한계), 속도가 붙을수록 1/v 로 점점
 *    힘이 줄어 최고속도에 가까워질수록 가속이 둔해진다(현실적인 RPM 체감). */
function updateEngine(car, dt) {
  if (car.throttle <= 0) return;

  const v = Math.max(car.lf, 1); // 0 나눗셈 방지
  let driveAccel = car.enginePower / v;
  driveAccel = Math.min(driveAccel, car.acceleration); // 트랙션 한계

  car.lf += driveAccel * car.throttle * dt;
}

/* 4) 브레이크 ----------------------------------------------------------------
 *  강력하지만 즉시 0 으로 만들지 않는다. 일정한 감속도를 매 프레임 빼되,
 *  음수(후진)로 내려가지 않도록 0 에서 멈춘다 (ABS가 잡아주는 느낌). */
function updateBrake(car, dt) {
  if (car.braking <= 0 || car.lf === 0) return;

  const decel = car.brakePower * car.braking * dt;
  // 전진/후진 모두 0 방향으로 감속 (후진 중 브레이크 밟으면 멈춤)
  if (car.lf > 0) car.lf = Math.max(0, car.lf - decel);
  else car.lf = Math.min(0, car.lf + decel);
}

/* 4-b) 후진 (S) --------------------------------------------------------------
 *  - 전진 중이면 먼저 브레이크처럼 감속시킨다(바로 후진 X).
 *  - 정지/후진 중이면 뒤로 가속한다. 전진보다 약하고 최고속도도 낮다.
 *  - W(전진)가 눌려 있으면 전진이 우선이라 후진은 무시한다. */
function updateReverse(car, dt) {
  if (car.reversing <= 0 || car.throttle > 0) return;

  if (car.lf > 0) {
    // 전진 중 → 감속
    car.lf = Math.max(0, car.lf - car.brakePower * dt);
  } else {
    // 정지/후진 중 → 뒤로 가속 (음수 방향), 후진 최고속도로 제한
    const reverseMax = car.reverseSpeed * KMH_TO_PXS;
    car.lf = Math.max(-reverseMax, car.lf - car.reverseAccel * dt);
  }
}

/* 5) 저항 (공기 + 구름) ------------------------------------------------------
 *  - 공기저항 : 속도² 에 비례 → 고속에서 급격히 커져 코스팅 감속이 빨라진다.
 *  - 구름저항 : 속도 에 비례 → 저속에서도 서서히 차를 멈추게 한다.
 *  엑셀을 떼도 즉시 멈추지 않고 관성으로 굴러가다 천천히 감속하는 핵심.
 *  전진/후진(부호) 양쪽 모두 0 방향으로 감속시킨다. */
function updateResistance(car, dt) {
  if (car.lf === 0) return;

  const v = Math.abs(car.lf);
  const dec = (car.airResistance * v * v + car.rollingResistance * v) * dt;
  if (car.lf > 0) car.lf = Math.max(0, car.lf - dec);
  else car.lf = Math.min(0, car.lf + dec);
}

/* 6) 그립 (측면 마찰) — 브레이크 드리프트 -----------------------------------
 *  측면 속도 성분 ll 을 매 프레임 지수적으로 감쇠시킨다.  ll *= e^(-grip · dt)
 *  - 평상시엔 grip(높음)을 유지 → 측면속도가 즉시 사라져 v 가 heading 에 빠르게
 *    정렬된다. 따라서 고속에서도 드리프트 없이 깔끔하게 회전한다.
 *  - "고속 + 브레이크(SPACE)" 일 때만 그립을 driftGrip(낮음)으로 떨어뜨려 뒤가
 *    미끄러지게 한다. 이때 조향을 같이 넣으면 슬립 앵글이 생겨 드리프트가 된다.
 *    (브레이크만 밟고 직진하면 미끄러지지 않고 그냥 감속) */
function updateGrip(car, dt) {
  const speed = speedOf(car);

  // 기본은 항상 높은 그립 → 드리프트 없음
  let lateralFriction = car.grip;
  car.drifting = false;

  // 고속에서 브레이크를 밟는 동안에만 그립을 낮춰 브레이크 드리프트 유발
  const driftSpeed = car.brakeDriftSpeed * KMH_TO_PXS;
  if (car.braking > 0 && speed > driftSpeed) {
    // 빠를수록 더 잘 미끄러지게 (driftGrip 쪽으로 강하게)
    const over = clamp((speed - driftSpeed) / (car.maxSpeed * KMH_TO_PXS - driftSpeed), 0, 1);
    if (car.braking > 0 && Math.abs(car.steerInput) > 0.1) {

    // 트레일 브레이킹
    if (car.braking < 0.6) {

        lateralFriction = lerp(
            car.grip,
            car.grip * 0.72,
            over
        );

    } else {

        // 기존 드리프트
        lateralFriction =
            lerp(car.grip * 0.35, car.driftGrip, over);

    }

  }

    // 실제로 옆으로 미끄러지고 있을 때(측면 속도 충분)만 "드리프트 중"으로 본다.
    //  → 브레이크만 밟고 직진하면 자국/부스트 없음. 조향을 같이 넣어야 드리프트.
    if (Math.abs(car.ll) > 30) car.drifting = true;
  }

  // 지수 감쇠 (프레임레이트 독립적)
  car.ll *= Math.exp(-lateralFriction * dt);
}

/* 7) 속도/위치 계산 ----------------------------------------------------------
 *  분해·가공된 전진/측면 성분(lf, ll)을 다시 월드 속도 벡터로 합성하고,
 *  최고속도를 넘지 않도록 전진성분을 제한한 뒤 위치를 적분한다. */
function updatePhysics(car, dt) {
  // 전진 성분 캡 : 전진은 최고속도, 후진은 후진 최고속도까지 (측면 드리프트 속도는 별도)
  const vmax = car.maxSpeed * KMH_TO_PXS;
  const reverseMax = car.reverseSpeed * KMH_TO_PXS;
  car.lf = clamp(car.lf, -reverseMax, vmax);

  // local(lf, ll) → world(vx, vy) 합성
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  car.vx = car.lf * cos - car.ll * sin;
  car.vy = car.lf * sin + car.ll * cos;

  // 위치 적분
  car.x += car.vx * dt;
  car.y += car.vy * dt;
}

/* 8) 충돌 처리 — 맵 경계 ------------------------------------------------------
 *  두 모드 모두 맵 밖으로 못 나가게 차체를 벽 안쪽에 가둔다(죽음 없음). */
let lastWallSfx = 0; // 벽 충돌음 쿨다운(연속 마찰 시 스팸 방지)
function updateCollision(car) {
  const half = car.length / 2;
  const preSpeed = Math.hypot(car.vx, car.vy); // 충돌 전 속도(효과음 판단용)
  let hit = false;
  if (car.x < half) { car.x = half; car.vx = 0; hit = true; }
  if (car.x > world.w - half) { car.x = world.w - half; car.vx = 0; hit = true; }
  if (car.y < half) { car.y = half; car.vy = 0; hit = true; }
  if (car.y > world.h - half) { car.y = world.h - half; car.vy = 0; hit = true; }
  if (hit) {
    decompose(car); // 벽에 흡수된 속도를 차체 성분에 반영
    const now = performance.now();
    if (preSpeed > 60 && now - lastWallSfx > 250) { lastWallSfx = now; SFX.collision(clamp(preSpeed / 700, 0.3, 1)); }
  }
}

/* 두 방향성 사각형(OBB)의 최소 분리 벡터(MTV) — 분리축 정리(SAT).
 *  겹치면 {nx,ny,depth} (A 를 B 에서 밀어내는 단위방향 + 겹침 깊이), 안 겹치면 null.
 *  a,b = {x,y,ang,hl,hw} : 중심, 방향각, 반길이(전후), 반폭(좌우). 차는 회전 사각형이라
 *  각 박스의 forward/lateral 축 4개만 검사하면 충분하다. */
function obbMTV(a, b) {
  const aC = Math.cos(a.ang), aS = Math.sin(a.ang);
  const bC = Math.cos(b.ang), bS = Math.sin(b.ang);
  const axes = [ { x: aC, y: aS }, { x: -aS, y: aC }, { x: bC, y: bS }, { x: -bS, y: bC } ];
  const dx = b.x - a.x, dy = b.y - a.y; // A→B 중심 벡터
  let minOv = Infinity, nx = 0, ny = 0;
  for (const ax of axes) {
    // 각 박스의 반경을 이 축에 투영 : hl·|축·forward| + hw·|축·lateral|
    const aR = a.hl * Math.abs(ax.x * aC + ax.y * aS) + a.hw * Math.abs(-ax.x * aS + ax.y * aC);
    const bR = b.hl * Math.abs(ax.x * bC + ax.y * bS) + b.hw * Math.abs(-ax.x * bS + ax.y * bC);
    const proj = dx * ax.x + dy * ax.y;   // 중심거리를 이 축에 투영
    const ov = aR + bR - Math.abs(proj);  // 반경합 - 중심거리 = 겹침량
    if (ov <= 0) return null;             // 분리축 발견 → 충돌 아님(빠른 탈출)
    if (ov < minOv) {                     // 가장 얕게 겹친 축이 밀어낼 방향
      minOv = ov;
      const s = proj >= 0 ? -1 : 1;       // A 를 B 반대쪽으로 밀어낸다
      nx = ax.x * s; ny = ax.y * s;
    }
  }
  return { nx, ny, depth: minOv };
}

/* 8-b) 다른 플레이어와 충돌 — 위치 겹침 방지(즉시)만 클라가 처리한다.
 *  자동차 실제 사각형(OBB)으로 겹치면 상대 밖으로 밀어내 시각적 파고듦을 없앤다.
 *  ※ 속도/운동량 변화(밀치기)는 "서버 권위" 로 처리한다 → 서버가 두 차의 실제 속도로
 *    2체 충돌 임펄스를 계산해 양쪽에 "bump" 로 통지(handleNet 의 bump 처리). */
// 히트박스 = "시각 차체" 크기와 정확히 일치시킨다.
//  drawCar 는 s=((L+10)/232)*1.15 로 그려 실제 화면상 차체는 반길이 116·s, 반폭 55.5·s(px).
//  → 반길이=(L+10)*0.575, 반폭=(L+10)*0.2751 (L=38 이면 27.6 × 13.2 = 55×26px)
//  예전엔 히트박스가 38×18 로 시각(55×26)보다 작아 눈에 띄게 겹쳐 보였다 → 이제 일치.
function carHalfExtents(car) {
  const k = (car.length || CAR.length) + 10;
  return { hl: k * 0.575, hw: k * 0.2751 };
}
function updatePlayerCollision(car) {
  if (gameMode === "lobby" || !othersVisible()) return; // 로비/고스트 숨김 시 충돌 없음
  const { hl, hw } = carHalfExtents(car);
  const me = { x: car.x, y: car.y, ang: car.angle, hl, hw };
  for (const [, r] of remotePlayers) {
    const mtv = obbMTV(me, { x: r.x, y: r.y, ang: r.angle, hl, hw }); // 같은 차종 → 같은 치수
    if (!mtv) continue;
    car.x += mtv.nx * mtv.depth;   // 겹침 밖으로(위치만) — 속도는 서버 임펄스가 담당
    car.y += mtv.ny * mtv.depth;
    me.x = car.x; me.y = car.y;    // 여러 대와 연쇄 충돌 시 갱신 위치로 계속 판정
  }
}
// 서버 권위 충돌 임펄스 수신 → 내 차 속도에 반영(진짜 밀려남/밀치기) + 효과음·흔들림
let lastBumpSfx = 0;
function applyBump(vx, vy) {
  CAR.vx += vx; CAR.vy += vy;
  decompose(CAR); // 바뀐 vx/vy 를 lf/ll(주 적분변수)에 반영
  const sp = Math.hypot(vx, vy);
  const now = performance.now();
  if (sp > 40 && now - lastBumpSfx > 120) {
    lastBumpSfx = now;
    SFX.collision(clamp(sp / 700, 0.25, 0.9));
    camera.shake = Math.min((camera.shake || 0) + sp * 0.012, 10); // 충격 흔들림
  }
}

/* 9) 노면 — 레이싱 트랙 이탈 시 감속 ------------------------------------------
 *  트랙(캡슐 링) 밖(풀밭/안쪽 구멍)에서는 전진 속도를 추가로 깎아 느려지게 한다. */
function updateSurface(car, dt) {
  if (!isTrackWorld()) return;                 // 자유/프로/하드 레이싱 모두 적용
  if (isOnTrack(car.x, car.y)) return;
  // 풀밭 저항 : 전진/측면 속도를 지수적으로 감쇠 (하드는 훨씬 가혹하게 → 이탈 시 크게 손해)
  const drag = gameMode === "hard" ? OFFTRACK_DRAG_HARD : OFFTRACK_DRAG;
  const f = Math.exp(-drag * dt);
  car.lf *= f;
  car.ll *= f;
}

/* 점이 트랙 위에 있는지 : 중심선(폐곡선)까지의 최단 거리가 트랙 절반 폭 이내면
 *  아스팔트, 아니면 이탈(잔디). 중심선의 모든 세그먼트를 훑어 최소 거리를 구한다. */
function isOnTrack(x, y) {
  const track = world.track;
  if (!track) return true;
  const pts = track.centerline;
  const n = pts.length;
  let minD2 = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d2 = distToSegmentSq(x, y, a.x, a.y, b.x, b.y);
    if (d2 < minD2) minD2 = d2;
  }
  return minD2 <= track.halfWidth * track.halfWidth;
}

// 트랙 중심선상 위치(0~1 진행도) : 가장 가까운 세그먼트 인덱스+비율을 정규화
function trackPhase(x, y, track) {
  const pts = track.centerline, n = pts.length;
  let best = 0, bestD2 = Infinity, bestFrac = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 ? clamp(((x - a.x) * dx + (y - a.y) * dy) / len2, 0, 1) : 0;
    const cx = a.x + t * dx, cy = a.y + t * dy;
    const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
    if (d2 < bestD2) { bestD2 = d2; best = i; bestFrac = t; }
  }
  return (best + bestFrac) / n;
}

// 프로 레이싱 : 바퀴수 추적 (중간 체크포인트를 지나야 시작선 통과를 1바퀴로 인정 → 역주행 악용 방지)
function updateLap(car) {
  if (gameMode !== "pro" || race.state !== "racing") return;
  if (race.done) { race.lapMs = race.finalMs; return; } // 완주 후 시간 고정
  const now = performance.now();
  const ph = trackPhase(car.x, car.y, world.track);
  if (ph > 0.4 && ph < 0.6) race.checkpoint = true;           // 중간 통과
  if (race.checkpoint && race.lastPhase > 0.75 && ph < 0.25) { // 시작선 정방향 통과 → 랩 완료
    race.lap++;
    race.checkpoint = false;
    race.lapMark = now - race.raceStartTime; // 이 랩을 넘긴 순간의 누적 시간 → 순위판 기록
    SFX.lap();               // 랩 완료 차임
    if (race.lap >= race.laps) {              // 마지막 바퀴 통과 → 완주, 누적 시간 정지
      race.done = true;
      race.finalMs = now - race.raceStartTime;
      race.lapMs = race.finalMs;
      race.lastPhase = ph;
      race.prog = race.lap;
      return;
    }
    
    race.lastPhase = ph;
    return;
  }
  race.lastPhase = ph;
  race.prog = race.lap + ph;
  race.lapMs = now - race.raceStartTime; // 출발부터의 누적 시간(랩마다 리셋 안 함)
}

// 타임어택 기록 기능이 있는 모드(자유/하드) 여부
function isTimeAttackMode() { return gameMode === "racing" || gameMode === "hard" || gameMode === "serp"; }

// 타임어택 상태 초기화 (모드 진입/이탈 시)
function resetAttack() {
  attack.state = "idle";
  attack.hasRun = false;
  attack.ms = 0;
  attack.checkpoint = false;
}

/* 차를 출발선 바로 뒤에 세운다 (모든 트랙 공용) : 차 머리(비주얼 1.15배)가 출발선(6px)을
 *  넘지 않도록 라인 절반 3px + 여유 4px + 비주얼 반길이만큼 진행 반대로 물린다. */
function placeBehindStart() {
  const s = world.track.start;
  const back = 3 + 4 + (CAR.length * 1.15) / 2;
  CAR.x = s.x - Math.cos(s.angle) * back;
  CAR.y = s.y - Math.sin(s.angle) * back;
  CAR.angle = s.angle;
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
}

// 자유 모드 타임어택 : "기록 시작" → 출발선 뒤로 이동 → 움직이면 계측 → 한 바퀴 후 종료
function startAttack() {
  placeBehindStart();
  net.pendingTeleport = true;
  updateCamera(CAR, 0);
  attack.state = "armed";
  attack.ms = 0;
  attack.checkpoint = false;
  attack.lastPhase = trackPhase(CAR.x, CAR.y, world.track);
}

// 기록 중 취소 : 계측을 멈추고 idle 로 되돌린다 (기록 저장 안 함, 결과 표시도 지움)
function cancelAttack() {
  attack.state = "idle";
  attack.ms = 0;
  attack.checkpoint = false;
  attack.hasRun = false; // 결과 표시(#time)도 숨김
}

function updateAttack(car) {
  if (!isTimeAttackMode() || attack.state === "idle") return;
  const now = performance.now();
  const ph = trackPhase(car.x, car.y, world.track);
  if (attack.state === "armed") {
    if (Math.abs(car.lf) > 5 * KMH_TO_PXS) { // 움직이기 시작 → 계측 시작
      attack.state = "running";
      attack.startTime = now;
      attack.checkpoint = false;
    }
    attack.lastPhase = ph;
    return;
  }
  // running
  attack.ms = now - attack.startTime;
  if (ph > 0.4 && ph < 0.6) attack.checkpoint = true;
  if (attack.checkpoint && attack.lastPhase > 0.75 && ph < 0.25) { // 출발선 재통과 → 종료
    const finalMs = attack.ms;
    attack.state = "idle";
    attack.hasRun = true;
    attack.ms = finalMs;          // 결과 유지(초기화 안 함)
    sendTimeAttack(finalMs);
    blinkTime();                  // 우측 하단 숫자 3번 깜빡
  }
  attack.lastPhase = ph;
}

function sendTimeAttack(ms) {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify({ type: "timeAttack", ms: Math.round(ms) }));
}

// 프로 그리드 슬롯 위치 (시작선 뒤쪽, 2열 스태거)
function proGridPosition(slot) {
  const s = WORLD.pro.track.start;
  const fwd = { x: Math.cos(s.angle), y: Math.sin(s.angle) };
  const right = { x: Math.cos(s.angle + Math.PI / 2), y: Math.sin(s.angle + Math.PI / 2) };
  const row = Math.floor(slot / 2), col = slot % 2;
  // 맨 앞 줄은 다른 코스와 동일하게 출발선 바로 뒤(차 머리가 라인을 안 넘게), 뒷줄은 75px 씩 뒤로
  const front = 3 + 4 + (CAR.length * 1.15) / 2;
  const back = front + row * 75;
  const lateral = (col === 0 ? -1 : 1) * 70;
  return {
    x: s.x - fwd.x * back + right.x * lateral,
    y: s.y - fwd.y * back + right.y * lateral,
    angle: s.angle,
  };
}

// 점(px,py)에서 선분까지의 거리 제곱 (sqrt 생략으로 빠르게)
function distToSegmentSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1) : 0;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex * ex + ey * ey;
}

/* 플레이어 간 킬 판정은 서버 권위(server.js runCollisions)로 처리한다.
 *  클라이언트는 서버 통지를 따른다.
 *  - "death"  : 내가 죽었다 → 모드 선택 화면으로 복귀 (서바이벌 전용)
 *  - "killed" : 누군가 죽었다 → 그 자리에 폭발을 띄운다 (같은 모드 모두) */

// 서버가 내 사망을 통지 → 모드 선택 화면으로 (죽으면 다시 모드 선택)
function handleDeath() {
  showDeathScreen();      // 잠깐 사망 표시
  setTimeout(toMenu, 900); // 곧 모드 선택 메뉴로 복귀
}


/* =============================================================================
 *  폭발 이펙트 (사망 시) — 모든 플레이어 화면에 보인다
 * ========================================================================== */
const explosions = [];

function spawnExplosion(x, y, color) {
  const parts = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const sp = 100 + Math.random() * 300;
    parts.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      life: 0.5 + Math.random() * 0.6,
      size: 2 + Math.random() * 4,
    });
  }
  explosions.push({ cx: x, cy: y, parts, color, age: 0 });
}

function updateExplosions(dt) {
  for (let i = explosions.length - 1; i >= 0; i--) {
    const e = explosions[i];
    e.age += dt;
    let alive = e.age < 0.45; // 충격파 링이 살아있는 동안 유지
    for (const p of e.parts) {
      if (p.life > 0) {
        p.life -= dt;
        p.x += p.vx * dt; p.y += p.vy * dt;
        p.vx *= 0.9; p.vy *= 0.9; // 공기저항으로 파편 감속
        alive = true;
      }
    }
    if (!alive) explosions.splice(i, 1);
  }
}

function drawExplosions() {
  const RING = 0.45;
  for (const e of explosions) {
    // 흰 충격파 링
    if (e.age < RING) {
      const t = e.age / RING;
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(e.cx, e.cy, 10 + t * 80, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 파편 (죽은 차 색)
    for (const p of e.parts) {
      if (p.life <= 0) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / 0.6));
      ctx.fillStyle = e.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
  }
  ctx.globalAlpha = 1;
}

/* 사망 화면 오버레이 제어 */
function showDeathScreen() {
  const el = document.getElementById("death");
  if (!el) return;
  el.classList.add("show");
  clearTimeout(showDeathScreen._t);
  showDeathScreen._t = setTimeout(() => el.classList.remove("show"), 1500);
}


/* =============================================================================
 *  스키드 마크 (드리프트 시 타이어 자국) — 주행감 시각 피드백
 *   - 점이 아니라 "이전 프레임 → 현재 프레임" 선분을 이어 연속된 타이어 줄무늬를 만든다
 *   - 일정 시간 유지 후 서서히 투명해지며 사라진다 (뚝 끊기는 FIFO 제거 대신)
 * ========================================================================== */
// 모든 플레이어(나 + 원격)의 타이어 자국을 한 배열에 모은다.
const skidMarks = [];
const SKID_COLOR = "rgba(52,54,58,0.38)"; // 인게임 공통 : 무채색 고무 자국 (플레이어 색 안 씀)
const MAX_SKID = 1400;   // 폭주 방지 상한 (수명 만료가 기본 제거 경로)
const SKID_HOLD = 3500;  // 완전 불투명 유지 시간 (ms)
const SKID_FADE = 5000;  // 이후 서서히 사라지는 시간 (ms)

// 뒷바퀴 두 개의 자국 선분을 남긴다. owner(_skid)에 직전 바퀴 위치를 캐시해 이어 그린다.
function pushSkid(owner, x, y, angle, color) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rearOffset = -CAR.length * 0.35; // 뒷바퀴 위치
  const halfW = CAR.width * 0.4;
  const now = performance.now();
  const p = [-1, 1].map((side) => ({
    x: x + cos * rearOffset - sin * halfW * side,
    y: y + sin * rearOffset + cos * halfW * side,
  }));
  const prev = owner._skid;
  // 직전 프레임과 이어질 때만 선분 생성 (드리프트 재시작/순간이동이면 새 시작점만 기록)
  if (prev && now - prev.t < 120) {
    for (let i = 0; i < 2; i++) {
      const dx = p[i].x - prev.p[i].x, dy = p[i].y - prev.p[i].y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.2 && d2 < 60 * 60) {
        skidMarks.push({ x0: prev.p[i].x, y0: prev.p[i].y, x1: p[i].x, y1: p[i].y, color, born: now });
      }
    }
    while (skidMarks.length > MAX_SKID) skidMarks.shift();
  }
  owner._skid = { p, t: now };
}

// 내 차 : 드리프트 중일 때만 타이어 자국을 남긴다.
function updateSkid(car) {
  if (car.drifting) {
    pushSkid(car, car.x, car.y, car.angle,
      gameMode === "lobby" ? "rgba(90,84,72,0.16)" // 로비: 흰 바닥 위 연한 웜 그레이 자국
      : SKID_COLOR);
  } else {
    car._skid = null; // 자국 연속성 끊기 (다음 드리프트는 새 줄무늬)
  }
}


/* =============================================================================
 *  카메라 — 차량을 항상 화면 중앙에 두고 맵이 움직인다
 * ========================================================================== */
// zoom: 배율(클수록 확대). ay: 차가 화면 세로 어느 지점에 오는지(0.5=중앙, 0.36=위쪽).
//  로비 대기 상태는 확대+위쪽(0.36), 주행 시작하면 줌아웃+중앙으로 부드럽게 전환된다.
const camera = { x: 0, y: 0, shake: 0, zoom: 1, zoomT: 1, ay: 0.5, ayT: 0.5 };

// 화면 흔들림을 추가한다(상대를 죽였을 때 등). 값이 클수록 세게 흔들림.
function addShake(amount) {
  camera.shake = Math.min(camera.shake + amount, 45);
}

function updateCamera(car, dt) {
  const k = clamp(dt * 3.2, 0, 1);
  camera.zoom += (camera.zoomT - camera.zoom) * k;
  camera.ay += (camera.ayT - camera.ay) * k;
  camera.x = car.x - (viewW / 2) / camera.zoom;
  camera.y = car.y - (viewH * camera.ay) / camera.zoom;
  // 흔들림은 시간에 따라 빠르게 잦아든다(약 0.4초)
  camera.shake *= Math.exp(-9 * dt);
  if (camera.shake < 0.3) camera.shake = 0;
}


/* =============================================================================
 *  렌더링
 * ========================================================================== */
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const minimap = document.getElementById("minimap");
const mctx = minimap.getContext("2d");
const speedEl = document.getElementById("speed");

// 논리(CSS) 뷰포트 크기 — 렌더 로직은 이 값을 쓴다(캔버스 백킹은 DPR 배율로 더 큼).
let viewW = window.innerWidth, viewH = window.innerHeight;
let minimapSize = 180; // 미니맵 논리 크기(모바일 가로모드처럼 화면이 낮으면 축소)

// HiDPI/레티나 대응 : 백킹 스토어를 devicePixelRatio 배율로 키워 선명하게(성능 위해 2배 상한).
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth; viewH = window.innerHeight;
  // 화면이 낮으면(모바일 가로) 미니맵을 줄여 채팅/컨트롤 공간 확보
  minimapSize = viewH <= 540 ? 104 : 180;
  // 메인 캔버스 : 백킹은 dpr 배율로 확대하되 표시 크기는 논리 픽셀로 고정(안 그러면 확대돼 보임)
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = viewW + "px";
  canvas.style.height = viewH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 이후 모든 그리기는 논리 픽셀 좌표
  // 미니맵 : CSS 크기 미지정 → 표시 크기 고정 + 백킹 확대
  minimap.width = Math.round(minimapSize * dpr);
  minimap.height = Math.round(minimapSize * dpr);
  minimap.style.width = minimapSize + "px";
  minimap.style.height = minimapSize + "px";
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // CSS 가 채팅/순위판을 미니맵 크기에 맞춰 배치하도록 변수로 노출
  document.documentElement.style.setProperty("--mm", minimapSize + "px");
  updateTop10Offset();
}
window.addEventListener("resize", resize);
resize();

function render(car) {
  // 화면 클리어 : 월드 밖은 메인화면(로비)과 같은 웜 화이트로 이어지게 (검정 대신)
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, viewW, viewH);

  // 흔들림 오프셋 (킬 시 화면 진동)
  const sx = camera.shake ? (Math.random() * 2 - 1) * camera.shake : 0;
  const sy = camera.shake ? (Math.random() * 2 - 1) * camera.shake : 0;

  ctx.save();
  ctx.scale(camera.zoom, camera.zoom); // 줌 (로비: 대기 확대 → 주행 줌아웃)
  ctx.translate(-camera.x + sx / camera.zoom, -camera.y + sy / camera.zoom); // 월드 → 화면 변환 (+흔들림)

  drawGround();
  drawSkid();

  // 속도 불꽃 (내 차 뒤만) — 차체 아래에 깔리도록 차량보다 먼저 그린다
  drawSpeedFlame(car.x, car.y, car.angle, Math.abs(car.lf) * PXS_TO_KMH);

  // 다른 플레이어 차량 (보간된 위치) — 커스텀 색 우선(없으면 id 색 폴백).
  //  연습/타임어택에서 "다른 차 숨김"이면 그리지 않는다.
  const drawOthers = othersVisible();
  if (drawOthers) {
    for (const [id, r] of remotePlayers) {
      drawCar(r, r.color || colorForId(id));
    }
  }
  // 내 차량
  drawCar(car, myColor());

  // 이름표 (차 아래) — 회전 영향 안 받게 차량 그린 뒤 별도로.
  //  다른 플레이어만 표시 (내 이름은 안 보여줌, 로비에선 전부 미표시)
  if (gameMode !== "lobby" && drawOthers) {
    for (const r of remotePlayers.values()) drawName(r.name, r.x, r.y);
  }

  // 폭발 이펙트 (차량 위에)
  drawExplosions();

  // 커스텀 32색 링 : 캔버스 최상위 (스키드/차에 가려지지 않게)
  if (gameMode === "lobby") drawCustomRing();

  ctx.restore();

  if (gameMode !== "lobby") drawMinimap(car);
  drawSpeed(car);
  drawRaceHud(); // 프로 레이싱 신호등/GO
  updateTimeHud(); // 우측 하단 #time (프로 현재 랩 / 타임어택)
  updateProTimer(); // 상단 종료 카운트다운 (#proTimer DOM)
}

/* 프로 레이싱 HUD (플랫 디자인) : 웜 화이트 카드 위 5개 플랫 신호등 → 소등 시 플랫 그린 "출발!" 알약.
 *  글로우/검정 패널 없이 HUD 카드와 같은 결(흰 배경 + #ece8df 테두리 + 소프트 카드 섀도)로 통일. */
function drawRaceHud() {
  if (gameMode !== "pro") return;
  const now = performance.now();
  const cx = viewW / 2, cy = viewH * 0.30;

  // ---- 카운트다운 : 흰 카드 위 5개 라이트가 코랄로 하나씩 점등 (소등 = 출발) ----
  if (race.state === "countdown" && race.countdownEnd > now) {
    const remain = race.countdownEnd - now;
    const lit = clamp(5 - Math.floor(remain / 1000), 0, 5);
    if (lit > sfxCountLit) { sfxCountLit = lit; if (lit > 0) SFX.beep(); } // 새 불 점등마다 비프
    const r = 13, gap = 42, n = 5, padX = 24, padY = 18;
    const rowW = gap * (n - 1) + r * 2;
    const cardW = rowW + padX * 2, cardH = r * 2 + padY * 2;
    const cardX = cx - cardW / 2, cardY = cy - cardH / 2;
    // 카드 : 소프트 섀도 → 흰 면 → 얇은 테두리 (다른 HUD 카드와 동일한 결)
    ctx.save();
    ctx.shadowColor = "rgba(58,54,46,0.16)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    ctx.fillStyle = "#ffffff";
    roundRect(cardX, cardY, cardW, cardH, 18);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#ece8df"; ctx.lineWidth = 1;
    roundRect(cardX, cardY, cardW, cardH, 18);
    ctx.stroke();
    // 플랫 라이트 (점등=코랄 / 소등=웜 그레이, 글로우 없음)
    for (let i = 0; i < n; i++) {
      const x = cx - rowW / 2 + r + i * gap;
      ctx.beginPath();
      ctx.arc(x, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = i < lit ? "#e8604c" : "#eeeae0";
      ctx.fill();
    }
  }

  // ---- 소등 직후 "출발!" : 플랫 그린 알약, 살짝 팝인 후 페이드아웃 ----
  if (race.goFlashUntil > now) {
    const t = clamp(1 - (race.goFlashUntil - now) / 1200, 0, 1); // 0→1 진행
    const pop = t < 0.2 ? 1 - Math.pow(1 - t / 0.2, 3) : 1;      // 초반 ease-out 팝인
    const scale = 0.72 + 0.28 * pop;
    const alpha = t > 0.75 ? (1 - t) / 0.25 : 1;                 // 끝 25% 페이드아웃
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.font = "400 40px Jua, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const label = "출발!";
    const w = ctx.measureText(label).width + 60, h = 66;
    ctx.shadowColor = "rgba(58,54,46,0.18)"; ctx.shadowBlur = 20; ctx.shadowOffsetY = 6;
    ctx.fillStyle = "#57B868";
    roundRect(-w / 2, -h / 2, w, h, h / 2);
    ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, 0, 2);
    ctx.restore();
  }
}

// 상단 종료 카운트다운 : #attackBtn 과 동일 스타일의 DOM(#proTimer).
//  프로 레이싱 + 시간제한이 있을 때만 남은 시간을 표시한다.
const proTimerEl = document.getElementById("proTimer");
function updateProTimer() {
  if (!proTimerEl) return;
  const now = performance.now();
  if (gameMode === "pro" && race.state === "racing" && race.endEnd > now) {
    proTimerEl.textContent = fmtRaceTime(race.endEnd - now);
    proTimerEl.style.display = "block";
  } else {
    proTimerEl.style.display = "none";
  }
}

// #time HUD 갱신 : 프로=현재 랩 시간, 자유/하드=타임어택 진행/결과. + 취소 버튼 표시 제어.
function updateTimeHud() {
  if (gameMode === "pro" && race.state === "racing") {
    setTimeHud(fmtRaceTime(race.lapMs));
  } else if (isTimeAttackMode() && (attack.state !== "idle" || attack.hasRun)) {
    setTimeHud(fmtRaceTime(attack.ms));
  } else {
    setTimeHud("");
  }
  // 타임어택 계측 중(armed/running) : 취소 버튼 표시 + 기록 버튼 아이콘을 "다시"로 전환
  const recording = isTimeAttackMode() && attack.state !== "idle";
  const cancelBtn = document.getElementById("attackCancel");
  if (cancelBtn) cancelBtn.style.display = recording ? "flex" : "none";
  const attackBtn = document.getElementById("attackBtn");
  if (attackBtn) attackBtn.classList.toggle("recording", recording);
}

// 바닥 : 모드에 따라 로비 / 오픈 맵(그리드) / 레이싱 트랙
function drawGround() {
  if (gameMode === "lobby") drawLobbyGround();
  else if (isFlatTrackMode()) drawFlatTrackGround();
  else if (isTrackWorld()) drawRacingGround();
}

/* 플랫 트랙 바닥 (테스트 + 초보자 코스 공용) : 서킷 스타일 플랫 렌더링(검정/그라데이션 없음).
 *  잔디 단일톤(#84B53D) + 어둡지만 부드러운 회색 아스팔트(#6E7276)
 *  + 가장자리와 중앙 모두 같은 6px 흰 라인. 한 화면 주요 색 6~8개 제한. */
function drawFlatTrackGround() {
  const t = world.track;
  const p = t.path;
  const tw = t.halfWidth * 2;
  // 잔디 (바깥/인필드 동일한 밝은 톤)
  ctx.fillStyle = PALETTE.grass;
  ctx.fillRect(0, 0, world.w, world.h);
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  // 가장자리 : 모든 맵 공통 — 테스트 맵과 동일한 6px 흰 테두리 (중앙선과 같은 색·두께)
  ctx.strokeStyle = PALETTE.line;
  ctx.lineWidth = tw + 12;            // 양쪽 6px 씩 흰 테두리
  ctx.stroke(p);
  // 아스팔트
  ctx.strokeStyle = PALETTE.asphalt;
  ctx.lineWidth = tw;
  ctx.stroke(p);
  // 중앙 흰 실선 (6px)
  ctx.strokeStyle = PALETTE.line;
  ctx.lineWidth = 6;
  ctx.stroke(p);
  // 스타트 라인 : 중앙선과 같은 6px 흰 "일자" 선. 트랙에 수직으로 흰 테두리 바깥(halfWidth+6)까지 쭉 긋는다.
  //  중심은 정점(centerline[0])이 아니라 "실제 스무딩 경로 위 점"으로 잡아야 양끝이 좌우 테두리에 정확히 닿는다
  //  (스무딩 경로는 정점이 아니라 변의 중점을 지나므로 정점은 시각 트랙 중심에서 살짝 벗어나 있다).
  const cl = t.centerline, n = cl.length;
  const cx0 = 0.75 * cl[0].x + 0.125 * (cl[n - 1].x + cl[1].x); // 경로상 점 (정점 부근)
  const cy0 = 0.75 * cl[0].y + 0.125 * (cl[n - 1].y + cl[1].y);
  const tang = Math.atan2(cl[1].y - cl[n - 1].y, cl[1].x - cl[n - 1].x); // 그 지점의 접선
  const nx = Math.cos(tang + Math.PI / 2), ny = Math.sin(tang + Math.PI / 2);
  const half = t.halfWidth + 6;
  ctx.strokeStyle = PALETTE.line;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(cx0 - nx * half, cy0 - ny * half);
  ctx.lineTo(cx0 + nx * half, cy0 + ny * half);
  ctx.stroke();
}

/* 로비 바닥 : 웜 화이트 + 보일 듯 말 듯한 격자 + 모드 게이트(플랫 컬러 패치).
 *  광원 좌상단 고정 → 게이트 그림자는 우하단 플랫 오프셋(#E9E4D8, 블러 0). */
function drawLobbyGround() {
  const W = world.w, H = world.h;
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, W, H);

  // 격자 : 맵을 정확히 나눠떨어지게 칸 크기를 스냅 (경계에서 칸이 잘리지 않도록).
  //  목표 56px 기준으로 가장 가까운 "정수 칸수"를 구해 셀 크기를 역산 → 마지막 선이 경계에 딱 맞음.
  const gx = W / Math.round(W / 56);
  const gy = H / Math.round(H / 56);
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const vx0 = camera.x, vx1 = camera.x + viewW / camera.zoom;
  const vy0 = camera.y, vy1 = camera.y + viewH / camera.zoom;
  const ix0 = Math.max(0, Math.floor(vx0 / gx)), ix1 = Math.min(Math.round(W / gx), Math.ceil(vx1 / gx));
  const iy0 = Math.max(0, Math.floor(vy0 / gy)), iy1 = Math.min(Math.round(H / gy), Math.ceil(vy1 / gy));
  const y0 = Math.max(0, vy0), y1 = Math.min(H, vy1);
  const x0 = Math.max(0, vx0), x1 = Math.min(W, vx1);
  for (let i = ix0; i <= ix1; i++) { const x = i * gx; ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let j = iy0; j <= iy1; j++) { const y = j * gy; ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();

  // 모드 게이트 : 순수 평면 컬러 패치 (그림자/깊이 효과 없음)
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const g of LOBBY_GATES) {
    const gx = g.x - g.w / 2, gy = g.y - g.h / 2, r = 30;
    ctx.fillStyle = g.color;
    roundRect(gx, gy, g.w, g.h, r);
    ctx.fill();

    const entering = lobby.gate === g && lobby.prog > 0;
    if (!entering) {
      // 라벨 + 서브라벨 (모드 = "N명 접속 중", 커스텀 = 설명)
      ctx.fillStyle = "#ffffff";
      ctx.font = "400 30px Jua, sans-serif";
      ctx.fillText(g.label, g.x, g.y - 16);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "400 20px Jua, sans-serif";
      ctx.fillText(gateSub(g), g.x, g.y + 28);
    } else {
      // 진입 도넛 : 12시(0도)에서 시작해 시계방향으로 채워짐 → 가득 차면 입장
      const pr = clamp(lobby.prog, 0, 1);
      ctx.lineWidth = 11;
      ctx.strokeStyle = "rgba(255,255,255,0.28)"; // 트랙(비어있는 도넛)
      ctx.beginPath();
      ctx.arc(g.x, g.y, 42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = "#ffffff";                // 채워지는 진행분
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(g.x, g.y, 42, -Math.PI / 2, -Math.PI / 2 + pr * Math.PI * 2);
      ctx.stroke();
    }
  }

}

/* 커스텀 링 픽커 : 차를 중심으로 32색 스와치가 원형 배치. 클릭=선택(즉시 저장),
 *  호버=확대, 현재 색=잉크 링 표시. 출발하면 닫힌다. */
// 게이트 서브라벨 : 그룹에 속한 모드들의 접속 인원 합, 또는 안내 문구
function gateSub(g) {
  switch (g.group) {
    case "arcade": return "준비 중"; // 술래잡기/스모 모두 준비 중
    case "racing": return "준비 중"; // 일반전/경쟁전 모두 준비 중
    case "plaza": return "준비 중";
    case "custom": return `${modeCounts.pro || 0}명 접속 중`;
    // 연습 = 실제 코스(racing/hard/serp) 멀티플레이 접속 수
    case "practice": return `${(modeCounts.racing || 0) + (modeCounts.hard || 0) + (modeCounts.serp || 0)}명 접속 중`;
    case "test": return `${modeCounts.test || 0}명 접속 중`;
    case "garage": return "차 색상 바꾸기";
    default: return "";
  }
}

function customSwatchAngle(i) {
  return -Math.PI / 2 + (i * 2 * Math.PI) / CAR_COLORS.length;
}
function customSwatchPos(i) {
  const a = customSwatchAngle(i);
  return { x: custom.cx + Math.cos(a) * CUSTOM_RING_R, y: custom.cy + Math.sin(a) * CUSTOM_RING_R };
}
// 픽커 링의 현재 표시 각도 (슬라이드 애니메이션 진행분 반영)
function currentPickerAngle() {
  const selI = CAR_COLORS.findIndex((c) => c.toLowerCase() === myColor().toLowerCase());
  let a = selI >= 0 ? customSwatchAngle(selI) : -Math.PI / 2;
  if (custom.selAnim) {
    const t = clamp((performance.now() - custom.selAnim.at) / 280, 0, 1);
    const e = 1 - Math.pow(1 - t, 3); // ease-out
    a = custom.selAnim.from + custom.selAnim.delta * e;
    if (t >= 1) custom.selAnim = null;
  }
  return a;
}
function hitCustomSwatch(wx, wy) {
  for (let i = 0; i < CAR_COLORS.length; i++) {
    const p = customSwatchPos(i);
    if (Math.hypot(wx - p.x, wy - p.y) < 20) return i;
  }
  return -1;
}
function drawCustomRing() {
  if (!custom.active) return;
  // 팔레트 : 정적 스와치 (애니메이션 없음)
  for (let i = 0; i < CAR_COLORS.length; i++) {
    const p = customSwatchPos(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
    ctx.fillStyle = CAR_COLORS[i];
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.08)"; // 밝은 스와치(흰색 등) 경계
    ctx.stroke();
  }
  // 픽커 링 : 선택 표시 하나만 — 색을 바꾸면 원호를 따라 새 스와치로 슬라이드
  const a = currentPickerAngle();
  ctx.beginPath();
  ctx.arc(custom.cx + Math.cos(a) * CUSTOM_RING_R, custom.cy + Math.sin(a) * CUSTOM_RING_R, 21, 0, Math.PI * 2);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#3a3a3a";
  ctx.stroke();
  // 하단 : 현재 색 hex + 안내
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#3a3a3a";
  ctx.font = "600 26px Quicksand, sans-serif";
  ctx.fillText(myColor().toUpperCase(), custom.cx, custom.cy + CUSTOM_RING_R + 64);
  ctx.fillStyle = "#b6b0a4";
  ctx.font = "400 20px Jua, sans-serif";
  ctx.fillText("색을 고르고 출발하면 저장돼요", custom.cx, custom.cy + CUSTOM_RING_R + 98);
}

// 트랙 리본(커브+아스팔트+중앙선)을 주어진 컨텍스트에 그린다.
//  중심선 Path2D 를 폭을 달리해 여러 번 stroke 해서 층층이 쌓는다.
function strokeTrack(c, opt) {
  const track = world.track;
  const p = track.path;
  const tw = track.halfWidth * 2;
  c.lineJoin = "round";
  c.lineCap = "round";

  // 1) 커브(하양) — 트랙보다 넓게
  c.strokeStyle = "#fff";
  c.lineWidth = tw + 2 * track.kerb;
  c.stroke(p);
  // 2) 흰 점선을 같은 폭으로 덮어 빨강/흰 커브 무늬 (가운데는 곧 아스팔트가 덮음)
  if (opt.kerbDash) {
    c.setLineDash(opt.kerbDash);
    c.strokeStyle = "#ecf0f1";
    c.lineWidth = tw + 2 * track.kerb;
    c.stroke(p);
    c.setLineDash([]);
  }
  // 3) 아스팔트 — 트랙 폭만큼 덮어 가운데를 메우고 커브 링만 남긴다
  c.strokeStyle = "#3a3f44";
  c.lineWidth = tw;
  c.stroke(p);
  // 4) 중앙 점선
  if (opt.center) {
    c.setLineDash([50, 60]);
    c.strokeStyle = "rgba(255,255,255,0.35)";
    c.lineWidth = 4;
    c.stroke(p);
    c.setLineDash([]);
  }
}

function drawRacingGround() {
  const W = world.w, H = world.h;

  // 잔디
  ctx.fillStyle = "#4a7a44";
  ctx.fillRect(0, 0, W, H);

  // 트랙 리본
  strokeTrack(ctx, { kerbDash: [55, 55], center: true });

  // 스타트/피니시 라인 (출발점에서 진행방향에 수직으로 트랙 폭을 가로지름)
  const s = world.track.start;
  const nx = Math.cos(s.angle + Math.PI / 2), ny = Math.sin(s.angle + Math.PI / 2);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(s.x - nx * world.track.halfWidth, s.y - ny * world.track.halfWidth);
  ctx.lineTo(s.x + nx * world.track.halfWidth, s.y + ny * world.track.halfWidth);
  ctx.stroke();

  // 맵 경계
  ctx.strokeStyle = "#d8d040";
  ctx.lineWidth = 8;
  ctx.strokeRect(0, 0, W, H);
}

// 차 아래에 이름표를 그린다 (회전 없이, 가독성 위해 어두운 외곽선 + 흰 글자)
function drawName(text, x, y) {
  if (!text) return;
  ctx.font = "400 14px Jua, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const ny = y + CAR.length / 2 + 12; // 시각 1.15배 차체에 맞춘 오프셋
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, x, ny);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, ny);
}

function drawSkid() {
  if (!skidMarks.length) return;
  const now = performance.now();
  ctx.lineCap = "butt"; // 이웃 선분과 겹쳐 어두워지지 않게 (끝점이 정확히 이어짐)
  ctx.lineWidth = 4.5;  // 타이어 폭 느낌
  for (const m of skidMarks) {
    const age = now - m.born;
    if (age >= SKID_HOLD + SKID_FADE) continue; // 만료 (아래에서 일괄 정리)
    ctx.globalAlpha = age <= SKID_HOLD ? 1 : 1 - (age - SKID_HOLD) / SKID_FADE;
    ctx.strokeStyle = m.color;
    ctx.beginPath();
    ctx.moveTo(m.x0, m.y0);
    ctx.lineTo(m.x1, m.y1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // 만료된 자국 정리 : born 오름차순이므로 앞에서부터 잘라낸다
  const cutoff = now - (SKID_HOLD + SKID_FADE);
  let n = 0;
  while (n < skidMarks.length && skidMarks[n].born < cutoff) n++;
  if (n) skidMarks.splice(0, n);
}

/* =============================================================================
 *  부스트 화염 : 카툰 파이어 — 반투명 3겹 혀 + 불꽃 조각 + 부드러운 전환.
 *   - 등장/소멸 : 스프링(살짝 튕기는 오버슈트)으로 커졌다가, 꺼질 땐 스르륵 수축
 *   - 단계 전환(450/500/525) : 색을 RGB 로 크로스페이드 — 뚝 바뀌지 않는다
 *   - 크기는 단계와 무관하게 속도에 연속 비례 → 단계 경계에서 길이가 튀지 않는다
 *   - 블러/그라데이션 없음, 반투명 겹침만 사용
 * ========================================================================== */
const BOOST_TIERS = [
  { min: 525, cols: [[84, 226, 164], [157, 242, 205], [239, 255, 247]] },  // 민트
  { min: 500, cols: [[109, 185, 255], [168, 217, 255], [240, 250, 255]] }, // 하늘
  { min: 450, cols: [[255, 154, 118], [255, 191, 163], [255, 243, 228]] }, // 피치
];

const flameFx = {
  power: 0, v: 0,   // 등장 정도(스프링) : 0 꺼짐 ~ 1 완전 점화 (순간 1.1+ 오버슈트)
  cols: null,       // 크로스페이드 중인 현재 색 [3][rgb]
  embers: [],
  lastT: 0,
};
const rgbStr = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

function drawSpeedFlame(x, y, angle, kmh) {
  const now = performance.now();
  const dt = flameFx.lastT ? Math.min((now - flameFx.lastT) / 1000, 0.05) : 0;
  flameFx.lastT = now;

  // ---- 불꽃 조각 갱신 + 렌더 (월드 좌표) : 부스트가 꺼져도 남은 조각은 마저 사그라든다 ----
  if (flameFx.embers.length) {
    const damp = Math.exp(-2.6 * dt);
    for (let i = flameFx.embers.length - 1; i >= 0; i--) {
      const p = flameFx.embers[i];
      p.life -= dt;
      if (p.life <= 0) { flameFx.embers[i] = flameFx.embers[flameFx.embers.length - 1]; flameFx.embers.pop(); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= damp;
      p.vy *= damp;
      p.rot += p.spin * dt;
      const u = p.life / p.max;
      const flick = 0.65 + 0.35 * Math.sin(now / 42 + p.ph);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = u * 0.8 * flick;
      ctx.fillStyle = p.col;
      const r = p.r * (0.4 + 0.6 * u);
      ctx.beginPath(); // 길쭉한 마름모 조각
      ctx.moveTo(r, 0);
      ctx.lineTo(0, r * 0.55);
      ctx.lineTo(-r, 0);
      ctx.lineTo(0, -r * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ---- 점화 스프링 + 색 크로스페이드 ----
  const lit = kmh >= 450;
  const tier = BOOST_TIERS.find((tt) => kmh >= tt.min) || BOOST_TIERS[2];
  if (lit && !flameFx.cols) flameFx.cols = tier.cols.map((c) => c.slice()); // 첫 점화는 그 단계 색으로 즉시
  if (dt > 0) {
    // 스프링 : 켜질 땐 빠르고 탱글하게(오버슈트), 꺼질 땐 조금 느긋하게 수축
    const target = lit ? 1 : 0;
    const om = lit ? 18 : 11, zeta = lit ? 0.62 : 1.0;
    flameFx.v += (om * om * (target - flameFx.power) - 2 * zeta * om * flameFx.v) * dt;
    flameFx.power += flameFx.v * dt;
    if (flameFx.power < 0) { flameFx.power = 0; flameFx.v = 0; }
    // 색 : 현재 표시색을 목표 단계 색으로 지수 수렴 (부드러운 단계 전환)
    if (flameFx.cols && lit) {
      const k = 1 - Math.exp(-7 * dt);
      for (let li = 0; li < 3; li++)
        for (let ch = 0; ch < 3; ch++)
          flameFx.cols[li][ch] += (tier.cols[li][ch] - flameFx.cols[li][ch]) * k;
    }
  }
  if (flameFx.power < 0.02) {
    if (!lit) flameFx.cols = null; // 완전히 꺼짐 → 다음 점화 때 새 색으로
    if (!lit) return;
  }
  if (!flameFx.cols) return;

  const pow = flameFx.power;
  const powA = clamp(pow, 0, 1); // 투명도용 (오버슈트는 크기에만)
  // 크기 강도 : 단계와 무관하게 450~560km/h 에 연속 비례 → 단계 경계에서 안 튄다
  const t = clamp((kmh - 450) / 110, 0, 1);
  const baseLen = 46 + 50 * t;
  const halfW = CAR.width * 0.52;
  const rx = -CAR.length / 2 + 4; // 범퍼 밑 (차가 위에 그려져 뿌리는 가려진다)
  const cos = Math.cos(angle), sin = Math.sin(angle);

  // ---- 조각 분사 : 불꽃 꼬리 부근에서 이따금 하나씩 (점화 정도에 비례) ----
  if (lit && Math.random() < (0.20 + 0.28 * t) * powA) {
    const back = CAR.length / 2 + (0.5 + Math.random() * 0.6) * baseLen * pow;
    const lat = (Math.random() - 0.5) * halfW * 1.6;
    const spd = 55 + 85 * t + Math.random() * 50;
    const jit = (Math.random() - 0.5) * 90;
    const roll = Math.random();
    flameFx.embers.push({
      x: x - cos * back - sin * lat,
      y: y - sin * back + cos * lat,
      vx: -cos * spd - sin * jit,
      vy: -sin * spd + cos * jit,
      r: 2.2 + Math.random() * 2.6,
      max: 0.45 + Math.random() * 0.3,
      life: 0.45, rot: Math.random() * Math.PI,
      spin: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 4),
      ph: Math.random() * 6.28,
      col: rgbStr(flameFx.cols[roll < 0.5 ? 1 : roll < 0.85 ? 0 : 2]), // 전환 중이면 중간색 조각
    });
    flameFx.embers[flameFx.embers.length - 1].life = flameFx.embers[flameFx.embers.length - 1].max;
    if (flameFx.embers.length > 26) flameFx.embers.shift();
  }

  // 한 겹의 불꽃 실루엣 : 위/가운데/아래 세 혀가 각자 다른 주기로 낼름거린다
  const tongue = (L, w, ph) => {
    const f1 = L * (0.58 + 0.11 * Math.sin(now / 41 + ph));        // 위쪽 혀
    const fc = L * (1.0 + 0.10 * Math.sin(now / 36 + ph * 1.9));   // 가운데 혀 (가장 길다)
    const f2 = L * (0.58 + 0.11 * Math.sin(now / 47 + ph * 2.7));  // 아래쪽 혀
    const X = (bx) => rx - bx; // 범퍼 뒤로의 거리 → 차 좌표
    const cc = 2 * fc - (f1 * 0.85 + f2 * 0.85) / 2; // 가운데 혀 끝이 fc 에 닿는 제어점
    ctx.beginPath();
    ctx.moveTo(X(0), -w);
    ctx.quadraticCurveTo(X(f1 * 0.5), -w * 1.06, X(f1 * 0.78), -w * 0.55); // 옆구리 불룩
    ctx.quadraticCurveTo(X(f1 * 1.14), -w * 0.68, X(f1 * 0.85), -w * 0.26); // 위 혀
    ctx.quadraticCurveTo(X(cc), 0, X(f2 * 0.85), w * 0.26);                 // 가운데 혀
    ctx.quadraticCurveTo(X(f2 * 1.14), w * 0.68, X(f2 * 0.78), w * 0.55);   // 아래 혀
    ctx.quadraticCurveTo(X(f2 * 0.5), w * 1.06, X(0), w);
    ctx.closePath();
    ctx.fill();
  };

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle + 0.02 * Math.sin(now / 130)); // 아주 살짝 전체가 일렁
  // 점화 스케일 : 범퍼를 기준점으로 커진다 (스프링 오버슈트 → 팍 튀어나오는 간지)
  ctx.translate(rx, 0);
  ctx.scale(Math.min(pow, 1.18), Math.min(pow, 1.18));
  ctx.translate(-rx, 0);
  // 바깥 → 코어, 반투명으로 겹쳐 아래가 비치는 실제 불 느낌. 위상이 달라 서로 다르게 춤춘다.
  ctx.globalAlpha = 0.5 * powA;
  ctx.fillStyle = rgbStr(flameFx.cols[0]);
  tongue(baseLen, halfW, 0);
  ctx.globalAlpha = 0.66 * powA;
  ctx.fillStyle = rgbStr(flameFx.cols[1]);
  tongue(baseLen * 0.66, halfW * 0.68, 2.1);
  ctx.globalAlpha = 0.9 * powA;
  ctx.fillStyle = rgbStr(flameFx.cols[2]);
  tongue(baseLen * 0.38, halfW * 0.4, 4.4);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* 차량 렌더 : 포르쉐 실루엣 탑뷰 (확정 쉐입).
 *  - 쉐입 좌표계 : 190x266 (앞 = -y). car.angle(+x 전방)에 맞춰 +90도 회전해 그린다.
 *  - 그림자 : 광원 좌상단 고정 → 회전과 무관하게 우하단 오프셋 (로비=웜 그레이, 트랙=반투명 검정).
 *  - 루프/후드라인 : 바디 색 위에 흰/검 반투명을 겹쳐 어떤 색이든 톤 관계 유지. */
const CARP = {
  body: new Path2D("M 95 16 C 67 16 51 25 46 46 C 41.5 62 39.5 80 39.5 98 C 39.5 116 41 128 41 138 C 41 150 39 164 38.5 180 C 37.5 202 41 219 48 230 C 56 242 78 248 95 248 C 112 248 134 242 142 230 C 149 219 152.5 202 151.5 180 C 151 164 149 150 149 138 C 149 128 150.5 116 150.5 98 C 150.5 80 148.5 62 144 46 C 139 25 123 16 95 16 Z"),
  hood: new Path2D("M 74 36 C 71 58 69 76 70 92 M 116 36 C 119 58 121 76 120 92"),
  wind: new Path2D("M 59 96 C 72 85 118 85 131 96 L 126 122 C 113 113 77 113 64 122 Z"),
  dash: new Path2D("M 64 97 C 76 89 114 89 126 97 L 124 104 C 113 96 77 96 66 104 Z"),
  sideL: new Path2D("M 55 126 C 54 142 54 158 55 172 L 63 168 C 62 156 62 140 63 128 Z"),
  sideR: new Path2D("M 135 126 C 136 142 136 158 135 172 L 127 168 C 128 156 128 140 127 128 Z"),
  rear: new Path2D("M 64 178 C 77 186 113 186 126 178 L 121 206 C 109 198 81 198 69 206 Z"),
};

// 그림자용 통합 실루엣 : 바디 + 사이드미러 (한 패스로 채워 겹치는 부분이 이중으로 어두워지지 않게)
CARP.shadow = (() => {
  const p = new Path2D(CARP.body);
  const mir = new Path2D();
  mir.roundRect(-9.5, -5, 19, 10, 5);
  p.addPath(mir, new DOMMatrix().translateSelf(29, 111).rotateSelf(-16));  // 좌미러 (-0.28rad)
  p.addPath(mir, new DOMMatrix().translateSelf(161, 111).rotateSelf(16)); // 우미러 (+0.28rad)
  return p;
})();

// 쉐입 로컬 좌표계로 진입 (차 중심 = (95,132), 스케일 s)
function carShapeTransform(x, y, rot, s) {
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(s, s);
  ctx.translate(-95, -132);
}

function drawCar(car, color = "#e8604c") {
  const L = car.length || CAR.length;
  const s = ((L + 10) / 232) * 1.15;  // 시각 크기 1.15배 (충돌 크기는 그대로)
  const rot = car.angle + Math.PI / 2; // 쉐입 전방(-y) → car.angle 전방(+x)

  // ---- 그림자 : 사방으로 살짝 크게(윤곽 분리) + 아래로 약간(광원 방향), 플랫한 단색 엣지 ----
  //  쉐입이 세로로 길어 폭/길이 배율을 달리해 림을 고르게 만든다.
  //  multiply 블렌드 — 아래 색을 "곱해서" 어둡게 만들므로 격자든 트랙이든 자연스럽다
  ctx.save();
  ctx.translate(car.x, car.y + 3);
  ctx.rotate(rot);
  ctx.scale(s * 1.16, s * 1.1);
  ctx.translate(-95, -132);
  ctx.globalCompositeOperation = "multiply"; // 아래 색을 곱해 어둡게 — 검정 없이 부드러운 그림자
  ctx.fillStyle = gameMode === "lobby" ? PALETTE.carShadowLobby : PALETTE.carShadowTrack;
  ctx.fill(CARP.shadow); // 바디 + 사이드미러 실루엣
  ctx.restore();

  ctx.save();
  carShapeTransform(car.x, car.y, rot, s);

  // ---- 바디 + 사이드미러 + 은은한 아웃라인(바닥과 분리, 튀지 않게) ----
  //  아웃라인 = 바디색을 살짝 어둡게 (밝은 색이면 웜 그레이) → 어떤 색이든 자연스러운 테두리.
  const outline = carOutline(color);
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  // 사이드미러 (바디보다 먼저 → 바디 테두리가 미러 밑동을 덮어 깔끔)
  const drawMirror = (tx, rr) => {
    ctx.save();
    ctx.translate(tx, 111); ctx.rotate(rr);
    roundRect(-9.5, -5, 19, 10, 5);
    ctx.fillStyle = color; ctx.fill();
    // ctx.strokeStyle = outline; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  };
  drawMirror(29, -0.28);
  drawMirror(161, 0.28);
  // 바디
  ctx.fillStyle = color; ctx.fill(CARP.body);
  // ctx.strokeStyle = outline; ctx.lineWidth = 3.5; ctx.stroke(CARP.body);

  // ---- 후드 라인 (바디보다 어두운 톤) ----
  ctx.strokeStyle = "rgba(0,0,0,0.14)";
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  // ctx.stroke(CARP.hood);

  // ---- 헤드라이트 (펜더에 파묻힌 티어드롭) ----
  ctx.fillStyle = "#3a3f47";
  ctx.beginPath(); ctx.ellipse(62, 40, 12, 8, -0.31, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(128, 40, 12, 8, 0.31, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#f6efe0";
  ctx.beginPath(); ctx.arc(59, 38, 3.2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(131, 38, 3.2, 0, Math.PI * 2); ctx.fill();

  // ---- 유리 (윈드실드/사이드/리어) ----
  ctx.fillStyle = "#2f333b";
  ctx.fill(CARP.wind);
  ctx.fill(CARP.sideL);
  ctx.fill(CARP.sideR);
  ctx.fill(CARP.rear);

  // ---- 버건디 인테리어 (대시보드 + 리어 시트) ----
  ctx.fillStyle = "#8e4444";
  ctx.fill(CARP.dash);
  roundRect(76, 186, 14, 9, 4.5); ctx.fill();
  roundRect(100, 186, 14, 9, 4.5); ctx.fill();

  // ---- 루프 (바디 +32% 밝게 : 색 위에 흰 반투명 한 겹) ----
  // ctx.fillStyle = color;
  // roundRect(66, 118, 58, 56, 17); ctx.fill();
  // ctx.fillStyle = "rgba(255,255,255,0.32)";
  // roundRect(66, 118, 58, 56, 17); ctx.fill();

  // ---- 엔진 데크 + 세로 슬랫 ----
  ctx.fillStyle = "#2f333b";
  roundRect(68, 214, 54, 21, 9); ctx.fill();
  ctx.fillStyle = "#4a4e57";
  for (let i = 0; i < 6; i++) { roundRect(75 + i * 8, 218, 2.5, 13, 1.25); ctx.fill(); }

  ctx.restore();
}

function roundRect(x, y, w, h, r, c = ctx) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawSpeed(car) {
  // 체감 속도를 km/h 정수로 표시 (후진도 크기로 표시)
  const kmh = Math.round(Math.abs(car.lf) * PXS_TO_KMH);
  speedEl.textContent = `${kmh} km/h`;
}

// mm:ss.cs 형식 (예: 01:30.02)
function fmtRaceTime(ms) {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
// #time HUD (프로 남은시간 / 타임어택). 표시할 게 없으면 비운다.
const timeEl = document.getElementById("time");
function setTimeHud(text) { timeEl.textContent = text || ""; }
// #time 을 3번 깜빡이게 (타임어택 종료 시). 애니메이션 끝나면 클래스 제거해 원복.
timeEl.addEventListener("animationend", () => timeEl.classList.remove("blink"));
function blinkTime() {
  timeEl.classList.remove("blink");
  void timeEl.offsetWidth; // reflow → 애니메이션 재시작 보장
  timeEl.classList.add("blink");
}

// 미니맵 : 맵 전체 + 차량 위치 + 차량 방향 (월드가 비정사각형이어도 비율 유지)
function drawMinimap(car) {
  const size = minimapSize; // 논리 크기(백킹은 dpr 배율, 컨텍스트가 스케일 처리)
  const scale = Math.min(size / world.w, size / world.h); // 박스에 맞춰 축소
  const ox = (size - world.w * scale) / 2;                // 가운데 정렬 오프셋
  const oy = (size - world.h * scale) / 2;
  const wx = (x) => ox + x * scale;                       // 월드 x → 미니맵 x
  const wy = (y) => oy + y * scale;

  mctx.clearRect(0, 0, size, size);

  // 월드 영역 바닥 (플랫 트랙은 밝은 잔디색)
  const flat = isFlatTrackMode();
  mctx.fillStyle = flat ? PALETTE.grass : "rgba(40,45,42,0.9)";
  mctx.fillRect(ox, oy, world.w * scale, world.h * scale);

  // 레이싱 트랙 (중심선을 굵게 stroke → 미니맵 트랙 모양) + 시작선
  if (isTrackWorld() && world.track) {
    const track = world.track;
    mctx.save();
    mctx.translate(ox, oy);
    mctx.scale(scale, scale);
    mctx.lineJoin = "round";
    mctx.lineCap = "round";
    mctx.strokeStyle = flat ? PALETTE.line : "#7a8a76";
    mctx.lineWidth = track.halfWidth * 2 + (flat ? 40 : Math.max(2 * track.kerb, 40));
    mctx.stroke(track.path);
    mctx.strokeStyle = flat ? PALETTE.asphalt : "#566";
    mctx.lineWidth = track.halfWidth * 2;
    mctx.stroke(track.path);
    // 시작선 (흰색, 트랙 폭을 가로지름) — 플랫 트랙은 가장자리 링과 같은 두께
    const s = track.start;
    const nx = Math.cos(s.angle + Math.PI / 2), ny = Math.sin(s.angle + Math.PI / 2);
    mctx.strokeStyle = "#ffffff";
    mctx.lineWidth = flat ? 20 : Math.max(track.halfWidth * 0.5, 60);
    mctx.beginPath();
    mctx.moveTo(s.x - nx * track.halfWidth, s.y - ny * track.halfWidth);
    mctx.lineTo(s.x + nx * track.halfWidth, s.y + ny * track.halfWidth);
    mctx.stroke();
    mctx.restore();
  }

  // 현재 화면(뷰포트) 영역 표시
  mctx.strokeStyle = "rgba(255,255,255,0.4)";
  mctx.lineWidth = 1;
  mctx.strokeRect(wx(camera.x), wy(camera.y), (viewW / camera.zoom) * scale, (viewH / camera.zoom) * scale);

  // 다른 플레이어 (작은 점) — "다른 차 숨김"이면 미니맵에서도 제외
  if (othersVisible()) {
    for (const [id, r] of remotePlayers) {
      mctx.fillStyle = r.color || colorForId(id);
      mctx.beginPath();
      mctx.arc(wx(r.x), wy(r.y), 3, 0, Math.PI * 2);
      mctx.fill();
    }
  }

  // 내 차량 위치 + 방향(삼각형)
  mctx.save();
  mctx.translate(wx(car.x), wy(car.y));
  mctx.rotate(car.angle);
  mctx.fillStyle = myColor();
  mctx.beginPath();
  mctx.moveTo(7, 0);    // 앞쪽 꼭지점
  mctx.lineTo(-5, -4);
  mctx.lineTo(-5, 4);
  mctx.closePath();
  mctx.fill();
  mctx.restore();
}


/* =============================================================================
 *  멀티플레이어 (WebSocket 클라이언트)
 * -----------------------------------------------------------------------------
 *  - 자기 차량 상태(x, y, angle)를 30Hz 로 서버에 전송한다.
 *  - 서버가 보내주는 전체 스냅샷으로 다른 플레이어 차량을 갱신한다.
 *  - 다른 차량은 네트워크 지연/저속 전송으로 끊겨 보이므로 매 프레임
 *    목표 위치로 보간(interpolation)하여 부드럽게 렌더한다.
 *  - 서버가 없어도(정적 파일로 열어도) 게임은 1인 모드로 정상 동작한다.
 * ========================================================================== */
const net = {
  ws: null,
  id: null,             // 서버가 부여한 내 플레이어 id
  connected: false,
  lastSend: 0,            // 마지막 상태 송신 시각(매 프레임 전송, 6ms 안전 상한)
  pendingTeleport: false, // true면 다음 상태 송신에 teleport 플래그를 실어 보낸다
  hasServerTime: false,   // 서버가 스냅샷에 st(송신시각)를 넣어주는지 (재배포 여부)
  serverNewest: 0,        // 가장 최근에 받은 서버 타임스탬프(st)
  playT: null,            // 원격 보간용 재생 시계(서버시간 도메인, INTERP_DELAY 만큼 과거)
};

// 다른 플레이어 : id -> { x, y, angle (렌더값), tx, ty, tangle (목표값), drifting }
const remotePlayers = new Map();

// 플레이어 id 로부터 "고유 색"을 결정적으로 생성한다.
//  - id 만으로 색이 정해지므로 모든 클라이언트가 같은 플레이어를 같은 색으로 본다
//    → "난 파란 차야" 처럼 색으로 서로를 부르며 소통할 수 있다.
//  - 황금각(137.508°)으로 hue 를 분산시켜 인원이 늘어도 색이 잘 겹치지 않는다.
function hueForId(id) {
  return ((id || 0) * 137.508) % 360;
}
function colorForId(id) {
  return `hsl(${hueForId(id)}, 72%, 55%)`;
}
// 내 차 색 (서버가 id 를 줄 때까지는 id 0 기준 색)
// 내 차 색 : 기본 코랄, 커스텀 게이트(32색 링)에서 선택 → localStorage 영속 + 캐시
let carColorCache = null;
function myColor() {
  if (carColorCache) return carColorCache;
  try { carColorCache = localStorage.getItem("carColor") || "#e8604c"; } catch { carColorCache = "#e8604c"; }
  return carColorCache;
}
function setCarColor(c) {
  carColorCache = c;
  try { localStorage.setItem("carColor", c); } catch {}
}
// 밝기(0~1) — 흰색 계열 차가 흰 바닥에 묻히지 않게 아웃라인 판단용
function hexLum(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}
// 차 아웃라인 색 : 바디색을 살짝 어둡게(밝은 색은 웜 그레이) → 바닥과 분리되되 튀지 않는 테두리
function carOutline(color) {
  if (typeof color !== "string" || color[0] !== "#" || color.length < 7) return "rgba(0,0,0,0.22)";
  const n = parseInt(color.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = hexLum(color) > 0.82 ? 0.78 : 0.62; // 밝을수록 더 눌러 회색 테두리 확보
  r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
  return `rgb(${r},${g},${b})`;
}

function connect() {
  // 같은 호스트의 ws 엔드포인트로 접속 (node server.js 가 서빙)
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    net.ws = new WebSocket(`${proto}//${location.host}`);
  } catch {
    return; // file:// 등으로 열면 접속 실패 → 1인 모드
  }

  net.ws.onopen = () => {
    net.connected = true;
    // 저장된 토큰이 있으면 자동 로그인
    try {
      const tk = localStorage.getItem("carGameToken");
      if (tk) net.ws.send(JSON.stringify({ type: "auth", token: tk }));
    } catch {}
    // 재접속 시, 플레이 중이었다면 같은 모드로 자동 재입장
    if (gameState === "playing" && gameMode !== "lobby") sendJoin(); // 로비는 서버 미입장
  };

  net.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "welcome") {
      net.id = msg.id;
      // 초대 링크(?room=ID)로 들어온 경우 : 방 목록 팝업 열고 해당 방으로 바로 참가 시도
      if (pendingRoomJoin != null) {
        const rid = pendingRoomJoin;
        pendingRoomJoin = null;
        if (gameMode === "lobby") {
          openCustomRooms();
          net.ws.send(JSON.stringify({ type: "joinRoom", roomId: rid }));
        }
      }
    } else if (msg.type === "authOk") {
      // 로그인/회원가입 성공
      account.loggedIn = true;
      account.userId = msg.id;
      account.nickname = msg.nickname;
      account.isAdmin = !!msg.isAdmin;
      account.proWins = msg.proWins || 0;
      account.proPlays = msg.proPlays || 0;
      account.totalTime = msg.totalTime || 0;
      account.totalTimeAt = Date.now();
      account.bestMs = msg.bestMs || 0;
      account.bestHardMs = msg.bestHardMs || 0;
      account.bestSerpMs = msg.bestSerpMs || 0;
      account.loginTime = Date.now();
      playerName = msg.nickname;
      try { localStorage.setItem("carGameToken", msg.token); } catch {}
      hideAuthModal();
      updateAuthUI();
    } else if (msg.type === "authError") {
      if (!msg.silent) alert(msg.reason || "인증 실패");
      else { try { localStorage.removeItem("carGameToken"); } catch {} } // 만료 토큰 정리
    } else if (msg.type === "pwOk") {
      const cur = document.getElementById("accCurPw"); if (cur) cur.value = "";
      const nw = document.getElementById("accNewPw"); if (nw) nw.value = "";
      setAccPwMsg("비밀번호가 변경되었습니다.", true);
    } else if (msg.type === "pwError") {
      setAccPwMsg(msg.reason || "변경 실패", false);
    } else if (msg.type === "stats") {
      account.proWins = msg.proWins || 0;
      account.proPlays = msg.proPlays || 0;
      if (typeof msg.totalTime === "number") { account.totalTime = msg.totalTime; account.totalTimeAt = Date.now(); }
      if (typeof msg.bestMs === "number") {
        const improved = msg.bestMs > 0 && (!account.bestMs || msg.bestMs < account.bestMs); // 더 빠른 기록
        account.bestMs = msg.bestMs;
        if (improved) SFX.record(); // 기록 갱신 팡파레
      }
      if (typeof msg.bestHardMs === "number") {
        const improved = msg.bestHardMs > 0 && (!account.bestHardMs || msg.bestHardMs < account.bestHardMs);
        account.bestHardMs = msg.bestHardMs;
        if (improved) SFX.record(); // 하드 기록 갱신 팡파레
      }
      if (typeof msg.bestSerpMs === "number") {
        const improved = msg.bestSerpMs > 0 && (!account.bestSerpMs || msg.bestSerpMs < account.bestSerpMs);
        account.bestSerpMs = msg.bestSerpMs;
        if (improved) SFX.record(); // 구불구불 기록 갱신 팡파레
      }
      updateDashboard();
    } else if (msg.type === "counts") {
      // 모드별 참가 인원 → 로비 게이트 숫자 + 온라인 표시 갱신
      modeCounts.racing = msg.racing || 0;
      modeCounts.hard = msg.hard || 0;
      modeCounts.serp = msg.serp || 0;
      modeCounts.pro = msg.pro || 0;
      modeCounts.test = msg.test || 0;
      modeCounts.total = typeof msg.total === "number"
        ? msg.total
        : modeCounts.racing + modeCounts.hard + modeCounts.serp + modeCounts.pro;
      const on = document.getElementById("lobOnline");
      if (on) on.textContent = `온라인 ${modeCounts.total}`;
      updateMapPopupCounts(); // 맵 팝업이 열려 있으면 카드별 인원도 갱신
    } else if (msg.type === "spawn") {
      // 서버가 정한 입장/부활 위치 → 거기서 시작.
      //  로비(서버 미입장)와 테스트(클라이언트가 스타트 라인 뒤에 직접 배치,
      //  구버전 서버가 test 를 서바이벌로 오인해 보내는 spawn 무시)에선 무시.
      if (gameMode === "lobby" || gameMode === "test") return;
      CAR.x = msg.x; CAR.y = msg.y; CAR.angle = msg.angle;
      CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
      CAR.invulnUntil = performance.now() + 1500;
      net.pendingTeleport = true; // 남들 화면에서 슬라이드 없이 스냅되도록
    } else if (msg.type === "bump") {
      // 서버 권위 충돌 임펄스 → 내 차 속도에 반영(진짜 밀치기/밀려남)
      if (gameState === "playing" && gameMode !== "lobby") applyBump(Number(msg.vx) || 0, Number(msg.vy) || 0);
    } else if (msg.type === "death") {
      // 서버 판정: 내가 죽었다 → 모드 선택 화면으로 복귀
      handleDeath();
    } else if (msg.type === "killed") {
      // 서버 통지: 누군가 죽었다 → 그 자리에서 그 차 색으로 폭발
      const color = msg.victimId === net.id ? myColor() : colorForId(msg.victimId);
      spawnExplosion(msg.x, msg.y, color);
      SFX.explosion(); // 폭발음
      // 내가 죽인 경우 내 화면을 흔든다 (타격감)
      if (msg.killerId === net.id) addShake(34);
    } else if (msg.type === "chat") {
      // 채팅 수신 → 로그에 추가 (관리자는 금색 이름)
      addChatLine(msg.name, msg.text, msg.admin ? GOLD : colorForId(msg.id), msg.t);
    } else if (msg.type === "chatHistory") {
      // 접속 직후 받은 최근 채팅 (페이지당 1회만 적용 → 재접속 중복 방지)
      if (!chatHistoryLoaded) {
        chatHistoryLoaded = true;
        for (const m of (msg.messages || [])) {
          addChatLine(m.name, m.text, m.admin ? GOLD : colorForId(m.id), m.t);
        }
      }
    } else if (msg.type === "topRecords") {
      attack.top = msg.records || [];
      updateTopRecords();
    } else if (msg.type === "roomList") {
      // 방 목록 갱신 (브라우저 화면)
      race.rooms = msg.rooms || [];
      if (gameMode === "pro" && race.state !== "lobby" && race.state !== "countdown" && race.state !== "racing") {
        race.state = "browsing";
      }
      updateRaceUI();
    } else if (msg.type === "roomJoined") {
      // 방 입장 승인 → 대기실 팝업 (스테이지 진입은 전원 준비 후 시작 시점에)
      race.roomId = msg.roomId;
      race.isHost = !!msg.isHost;
      race.state = "lobby";
      race.myReady = false;
      hideCreateRoom();
      updateRaceUI();
    } else if (msg.type === "proStart") {
      // 트랙/슬롯 저장. 그리드 배치는 스테이지에 있을 때만 (로비 대기 중엔 시작 시 배치)
      race.slot = msg.slot;
      race.laps = msg.laps || 3;
      if (typeof msg.trackIndex === "number") WORLD.pro.track = buildProTrack(msg.trackIndex);
      if (gameMode === "pro") placeOnProGrid();
    } else if (msg.type === "joinReject") {
      // 방 입장 실패 → 브라우저에 남고 사유 표시
      alert(msg.reason || "입장할 수 없습니다.");
    } else if (msg.type === "race") {
      handleRaceMessage(msg);
    } else if (msg.type === "toFreeRacing") {
      // 프로 레이스 종료 → 모두 자유 레이싱으로 이동
      race.state = "none";
      enterFreeRacingFromPro();
    } else if (msg.type === "snapshot") {
      // 서버가 송신 시각(st)을 주면 그걸로 보간한다. 안 주면(재배포 전) 기존
      // 지수 스무딩으로 폴백하므로 손해는 없다.
      const hasSt = typeof msg.st === "number";
      if (hasSt) {
        net.hasServerTime = true;
        if (msg.st > net.serverNewest) net.serverNewest = msg.st;
      }
      // 적응형 지연 : 스냅샷 도착 간격의 "최근 최대값"을 지터로 보고 목표 지연을 잡아
      //  부드럽게 수렴시킨다 (매끈하면 ~40ms, 랙 심하면 최대 220ms 까지 자동 상승).
      const nowA = performance.now();
      if (lastSnapAt) {
        const gap = nowA - lastSnapAt;
        snapGapMax = Math.max(gap, snapGapMax * 0.95);          // 스파이크엔 즉시↑, 평소엔 천천히↓
        const target = clamp(snapGapMax * 1.5 + 10, INTERP_BASE, INTERP_MAX);
        interpDelay += (target - interpDelay) * 0.08;           // 급변 방지, 천천히 조절
      }
      lastSnapAt = nowA;
      const st = hasSt ? msg.st : performance.now();
      const seen = new Set();
      for (const p of msg.players) {
        if (p.id === net.id) continue; // 내 차는 로컬 물리로 그린다
        seen.add(p.id);
        let r = remotePlayers.get(p.id);
        if (!r) {
          // 처음 본 플레이어 → 즉시 그 자리에 스냅
          r = { x: p.x, y: p.y, angle: p.angle, snap: true };
          remotePlayers.set(p.id, r);
        }
        r.invuln = p.invuln;
        r.name = p.name;
        r.admin = p.admin;
        r.color = p.color;    // 상대의 커스텀 차 색 (없으면 렌더에서 id 색 폴백)
        r.drifting = p.drifting;
        // 권위 타깃(위치+속도+각도+서버시각) 갱신 → 데드레커닝으로 이 사이를 매끈하게 채운다
        r.tx = p.x; r.ty = p.y; r.tvx = p.vx || 0; r.tvy = p.vy || 0; r.ta = p.angle; r.tst = st;
        if (p.teleport) r.snap = true; // 텔레포트/부활 → 즉시 스냅(보간으로 맵 가로지르는 것 방지)
      }
      // 스냅샷에 없는 = 떠난 플레이어 제거
      for (const id of remotePlayers.keys()) {
        if (!seen.has(id)) remotePlayers.delete(id);
      }
    }
  };

  net.ws.onclose = () => {
    net.connected = false;
    remotePlayers.clear();
    setTimeout(connect, 1500); // 자동 재접속
  };

  net.ws.onerror = () => { net.ws.close(); };
}

// 모드 선택 → 서버에 입장 요청 (이름/모드 전달)
function sendJoin() {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify({ type: "join", mode: gameMode, name: playerName }));
}
// 메뉴 복귀 → 서버에 퇴장 통지
function sendLeave() {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify({ type: "leave" }));
}
// 준비 토글 전송
function sendReady(value) {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify({ type: "ready", value }));
}
function netSendPro(obj) {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  net.ws.send(JSON.stringify(obj));
}
function sendJoinRoom(roomId) { netSendPro({ type: "joinRoom", roomId }); }
function sendLeaveRoom() {
  netSendPro({ type: "leaveRoom" });
  race.state = "browsing"; race.isHost = false; race.myReady = false;
  updateRaceUI();
}
function showCreateRoom() { document.getElementById("createRoom").classList.add("show"); }
function hideCreateRoom() { document.getElementById("createRoom").classList.remove("show"); }
function sendCreateRoom() {
  const name = document.getElementById("crName").value;
  const laps = parseInt(document.getElementById("crLaps").value, 10) || 3;
  const courseVal = document.getElementById("crCourse").value;
  const course = courseVal === "random" ? "random" : parseInt(courseVal, 10);
  const timeLimit = parseInt(document.getElementById("crTime").value, 10) || 0;
  const maxPlayers = parseInt(document.getElementById("crMax").value, 10) || 7;
  netSendPro({ type: "createRoom", name, laps, course, timeLimit, maxPlayers });
  hideCreateRoom();
}

/* =============================================================================
 *  프로 레이싱 — 서버 'race' 메시지 처리 + 로비/순위 UI
 * ========================================================================== */
function handleRaceMessage(msg) {
  // 프로 트랙 동기화 (로비 진입자/재동기화 대비)
  if (typeof msg.trackIndex === "number") WORLD.pro.track = buildProTrack(msg.trackIndex);
  const prevState = race.state;
  race.state = msg.state;
  race.laps = msg.laps || race.laps;
  race.list = msg.players || [];
  race.canReady = !!msg.canReady;
  race.isHost = msg.hostId === net.id;
  if (msg.roomName !== undefined) race.roomName = msg.roomName;
  if (msg.course !== undefined) race.course = msg.course;
  if (msg.timeLimit !== undefined) race.timeLimit = msg.timeLimit;
  if (msg.maxPlayers !== undefined) race.maxPlayers = msg.maxPlayers;

  // 내 ready 상태를 서버 목록에서 동기화
  const me = race.list.find((p) => p.id === net.id);
  if (me) race.myReady = !!me.ready;

  // 타이머는 로컬 시계로 환산해 매끄럽게 표시
  race.countdownEnd = msg.countdownMs > 0 ? performance.now() + msg.countdownMs : 0;
  race.endEnd = msg.endMs > 0 ? performance.now() + msg.endMs : 0;

  if (prevState !== "countdown" && race.state === "countdown") {
    sfxCountLit = -1; // 새 카운트다운 비프 준비
    // 로비 위 대기실에서 시작 확정 → 이제 스테이지 진입 + 그리드 배치
    if (gameMode === "lobby") wipeTo(() => { enterProStage(); placeOnProGrid(); }, { title: "커스텀 레이싱", desc: "잠시 후 레이스가 시작됩니다" });
  }

  // 카운트다운 → 레이싱 전환 시 : 바퀴 추적/누적 타이머 초기화 + GO 표시/효과음
  // 안전망 : 카운트다운 메시지를 놓치고 바로 racing 이 온 경우에도 스테이지 진입
  if (gameMode === "lobby" && race.state === "racing") wipeTo(() => { enterProStage(); placeOnProGrid(); }, { title: "커스텀 레이싱", desc: "잠시 후 레이스가 시작됩니다" });
  if (prevState !== "racing" && race.state === "racing") {
    race.lap = 0; race.prog = 0; race.checkpoint = false;
    race.done = false; race.finalMs = 0; race.lapMark = 0;
    race.lastPhase = trackPhase(CAR.x, CAR.y, world.track);
    race.raceStartTime = performance.now();
    race.lapMs = 0;
    race.goFlashUntil = performance.now() + 1200;
    SFX.go(); // 출발 신호
  }

  // 레이스 종료 → 방(대기실)로 복귀 : 같은 설정으로 다시 준비하거나 나갈 수 있다
  if (prevState === "racing" && race.state === "lobby" && gameMode === "pro") {
    wipeTo(returnToWaitingRoom, { title: "레이스 종료", desc: "다시 준비하거나 나갈 수 있어요" });
  }
  updateRaceUI();
}

// 커스텀 레이스 종료 → 로비 월드로 복귀하되 방(대기실)은 유지.
//  같은 설정으로 다시 준비(재플레이)하거나 나가기를 고를 수 있다. race.state 는 서버가 "lobby" 로 준다.
function returnToWaitingRoom() {
  gameMode = "lobby";
  world = WORLD.lobby;
  gameState = "playing";
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  camera.shake = 0;
  resetAttack();
  CAR.x = LOBBY_SPAWN.x; CAR.y = LOBBY_SPAWN.y; CAR.angle = -Math.PI / 2;
  CAR.vx = CAR.vy = CAR.lf = CAR.ll = CAR.steerInput = 0;
  keys.w = keys.a = keys.s = keys.d = keys.space = false;
  camera.zoom = camera.zoomT = zoomFor(1.15);
  camera.ay = camera.ayT = 0.36;
  updateCamera(CAR, 0);
  // 게이트 선택 오버레이는 숨김(방 안이므로), 대기실 팝업만 표시
  lobby.ui = "hidden"; lobby.stopMs = 0; lobby.gate = null; lobby.prog = 0;
  const ui = document.getElementById("lobbyUI");
  ui.style.display = "block";
  ui.classList.add("s-hidden");
  document.body.classList.add("lobby");
  document.getElementById("exitBtn").style.display = "none";
  document.getElementById("death").classList.remove("show");
  minimap.style.display = "none";
  speedEl.style.display = "none";
  updateRaceUI();      // race.state === "lobby" → 대기실(#lobby) 표시
  updateTouchVisibility();
  updateFreeUI();
  setTimeHud("");
  updateProTimer();
}

// 프로 종료 → 자유 레이싱으로 자연스럽게 입장
function enterFreeRacingFromPro() {
  gameMode = "racing";
  world = WORLD.racing;
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  const s = world.track.start;
  CAR.x = s.x; CAR.y = s.y; CAR.angle = s.angle;
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
  net.pendingTeleport = true;
  updateCamera(CAR, 0);
  resetAttack();
  updateRaceUI();    // 로비/순위판 숨김
  updateFreeUI();
  sendJoin();        // racing 으로 재입장
}

// 코스/시간제한 라벨
function courseLabel(c) { return c === "random" ? "랜덤" : `코스 ${(+c) + 1}`; }
function timeLabel(ms) { return ms ? `${ms / 60000}분` : "무제한"; }

// 방 목록(브라우저) 렌더
let lastRoomListSig = ""; // 마지막으로 그린 방 목록 시그니처
function renderRoomList() {
  const el = document.getElementById("roomList");
  // 서버가 주기적으로 목록을 보내와도 내용이 같으면 DOM 재구성 생략
  //  (매번 갈아끼우면 호버가 풀려 깜빡이고, 클릭 도중 요소가 교체돼 클릭이 무시된다)
  const sig = JSON.stringify(race.rooms);
  if (sig === lastRoomListSig && el.childElementCount) return;
  lastRoomListSig = sig;
  el.innerHTML = "";
  if (!race.rooms.length) {
    const empty = document.createElement("div");
    empty.className = "room-empty";
    empty.textContent = "아직 방이 없어요. 방을 만들어보세요!";
    el.appendChild(empty);
    return;
  }
  for (const r of race.rooms) {
    const joinable = r.state === "lobby" && r.players < r.maxPlayers;
    const card = document.createElement("button");
    card.className = "room-card";
    card.disabled = !joinable;

    const top = document.createElement("div");
    top.className = "room-top";
    const nm = document.createElement("span");
    nm.className = "room-name";
    nm.textContent = r.name;
    const cnt = document.createElement("span");
    cnt.className = "room-count";
    cnt.textContent = `${r.players}/${r.maxPlayers}`;
    top.append(nm, cnt);

    const meta = document.createElement("div");
    meta.className = "room-meta";
    meta.textContent = `방장 ${r.host} · ${courseLabel(r.course)} · ${r.laps}바퀴 · ${timeLabel(r.timeLimit)} · ${r.state === "lobby" ? "대기중" : "진행중"}`;

    card.append(top, meta);
    card.addEventListener("click", () => { if (joinable) sendJoinRoom(r.id); });
    el.appendChild(card);
  }
}

// 로비 패널 + 순위판 + 방 브라우저 DOM 갱신
function updateRaceUI() {
  const inPro = gameMode === "pro";
  // 방 목록/대기실은 로비(메인 화면) 위에서도 뜬다 — 스테이지 진입은 게임 시작 시점
  const browsing = (inPro || gameMode === "lobby") && race.state === "browsing";
  const inLobby = (inPro || gameMode === "lobby") && race.state === "lobby";
  const showStand = inPro && (race.state === "lobby" || race.state === "countdown" || race.state === "racing");

  document.getElementById("roomBrowser").classList.toggle("show", browsing);
  document.getElementById("lobby").classList.toggle("show", inLobby);
  document.getElementById("standings").style.display = showStand ? "block" : "none";

  if (browsing) renderRoomList();

  // 로비 헤더(방 이름 + 설정)
  const info = document.getElementById("lobbyInfo");
  if (info) {
    info.textContent = `${courseLabel(race.course)} · ${race.laps}바퀴 · 시간제한 ${timeLabel(race.timeLimit)} · 최대 ${race.maxPlayers}명`;
  }
  const title = document.getElementById("lobbyTitle");
  if (title) title.textContent = race.roomName ? `${race.roomName}` : "커스텀 대기실";

  // 로비 플레이어 목록
  const lobbyList = document.getElementById("lobbyList");
  lobbyList.innerHTML = "";
  for (const p of race.list) {
    const row = document.createElement("div");
    row.className = "lobby-row";
    const dot = document.createElement("span");
    dot.className = "lobby-dot";
    dot.style.background = p.color || colorForId(p.id); // 각 플레이어 차 색 (미설정 시 id색 폴백)
    const nm = document.createElement("span");
    nm.className = "lobby-name";
    nm.textContent = p.name + (p.id === net.id ? " (나)" : "");
    const st = document.createElement("span");
    st.className = "lobby-ready " + (p.ready ? "on" : "off");
    st.textContent = p.ready ? "준비완료" : "대기중";
    row.append(dot, nm, st);
    lobbyList.appendChild(row);
  }

  // 준비 버튼
  const btn = document.getElementById("readyBtn");
  btn.disabled = !race.canReady;
  btn.textContent = race.myReady ? "준비 취소" : "준비";
  btn.classList.toggle("ready", race.myReady);
  document.getElementById("lobbyHint").textContent =
    "모두 준비하면 자동으로 시작됩니다 (최소 2명)";

  // 순위판 : 순위 · 이름 · 현재 랩 기록 · 현재랩/전체랩
  const sList = document.getElementById("standingsList");
  sList.innerHTML = "";
  for (const p of race.list) {
    const row = document.createElement("div");
    row.className = "stand-row";
    const rank = document.createElement("span");
    rank.className = "stand-rank";
    rank.textContent = p.rank + ".";
    const star = document.createElement("span");
    star.className = "stand-star";
    if (p.finished) { star.textContent = "★"; star.style.color = p.admin ? GOLD : (p.color || colorForId(p.id)); }
    const nm = document.createElement("span");
    nm.className = "stand-name";
    nm.style.color = p.admin ? GOLD : (p.color || colorForId(p.id));
    nm.textContent = p.name;
    // 시간·랩은 "한 바퀴라도 기록했을 때"만 표시. 아직 기록 전이면 둘 다 비운다.
    //  예) 1랩 통과 후 → "00:31.05  1/3" (그 시간을 기록한 랩), 완주 시 → "완주".
    const recorded = p.finished || (p.lap || 0) > 0;
    const time = document.createElement("span");
    time.className = "stand-time";
    time.textContent = (recorded && (p.lapMs || 0) > 0) ? fmtRaceTime(p.lapMs) : "";
    const lap = document.createElement("span");
    lap.className = "stand-lap";
    lap.textContent = p.finished ? "완주" : (recorded ? `${Math.min(p.lap, race.laps)}/${race.laps}` : "");
    row.append(rank, star, nm, time, lap);
    sList.appendChild(row);
  }
  updateTop10Offset();
}

/* =============================================================================
 *  채팅 (미니맵 하단)
 * ========================================================================== */
const MAX_CHAT_LINES = 80;

// 입력창 내용을 서버로 전송
// 현재 표시 이름 : 플레이 중이면 확정 이름, 메뉴/로비에선 입력창 값
function currentName() {
  if (gameState === "playing") return playerName;
  const v = (document.getElementById("nameInput").value || "").trim().slice(0, 12);
  return v || "Player";
}

function sendChat() {
  const input = document.getElementById("chatInput");
  const text = (input.value || "").trim();
  if (!text) return;
  // 메뉴/로비/플레이 어디서든 전송 (미입장 상태면 이름을 함께 보냄)
  if (net.connected && net.ws.readyState === WebSocket.OPEN) {
    net.ws.send(JSON.stringify({ type: "chat", text, name: currentName() }));
  }
  input.value = "";
}

// 시간 H:i (24시간 HH:MM)
function fmtTime(t) {
  const d = new Date(t || Date.now());
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// 채팅 로그에 한 줄 추가 (textContent 로만 넣어 HTML 주입 방지)
function addChatLine(name, text, color, t) {
  const log = document.getElementById("chatLog");
  const wasBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;

  const line = document.createElement("div");
  line.className = "chat-msg";

  const timeEl = document.createElement("span");
  timeEl.className = "chat-time";
  timeEl.textContent = fmtTime(t);

  const nameEl = document.createElement("span");
  nameEl.className = "chat-name";
  nameEl.style.color = color || "#fff";
  nameEl.textContent = name + ":";

  const textEl = document.createElement("span");
  textEl.className = "chat-text";
  textEl.textContent = text;

  line.append(timeEl, nameEl, document.createTextNode(" "), textEl);
  log.appendChild(line);

  // 오래된 줄 정리
  while (log.children.length > MAX_CHAT_LINES) log.removeChild(log.firstChild);

  // 사용자가 맨 아래를 보고 있었으면 자동 스크롤
  if (wasBottom) log.scrollTop = log.scrollHeight;
}

// 채팅 UI 배선 (전송 버튼 + Enter)
function setupChat() {
  document.getElementById("chatSend").addEventListener("click", () => {
    sendChat();
    document.getElementById("chatInput").focus(); // 버튼 클릭 후 계속 입력 가능
  });
  document.getElementById("chatInput").addEventListener("keyup", (e) => {
    if (e.key !== "Enter") return;
    // 채팅창을 연(포커스한) Enter 의 keyup 이면 전송하지 않고 무시 → 포커스 유지
    if (chatFocusGuard) { chatFocusGuard = false; return; }
    e.preventDefault();
    sendChat();
    e.target.blur(); // Enter 로 보내면 입력창에서 빠져나와 운전 복귀
  });
}

// 내 차 상태를 서버에 전송 — 모니터 주사율대로(매 프레임). 안전 상한 ~165Hz(6ms)만 둔다.
//  → 서버가 항상 최신 위치를 갖고, 남들 화면에선 수신측 보간이 각자 모니터 Hz로 렌더한다.
function netSend(car, now) {
  if (gameMode === "lobby") return; // 로비는 로컬 전용(서버 미입장)
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) return;
  if (now - net.lastSend < 6) return; // 매 프레임 전송(60·120·144Hz 그대로), 6ms 미만만 차단
  net.lastSend = now;

  const msg = {
    type: "state",
    x: Math.round(car.x), y: Math.round(car.y),
    angle: +car.angle.toFixed(3),
    drifting: car.drifting, // 드리프트 중일 때만 → 남들 화면에도 그때만 자국
    color: myColor(),       // 커스텀 차 색 → 서버가 스냅샷으로 릴레이
    vx: Math.round(car.vx), vy: Math.round(car.vy), // 서버 권위 충돌 임펄스 계산용
    collide: othersVisible(), // 충돌 대상 여부(다른 차 보일 때만 밀치기)
  };
  // 막 텔레포트(벽/플레이어 리스폰)했으면 서버·남들에게 스냅하라고 알린다
  if (net.pendingTeleport) { msg.teleport = true; net.pendingTeleport = false; }
  // 프로 레이싱 중이면 바퀴수/진행도/현재랩시간 보고 (서버가 순위·완주 판정)
  if (gameMode === "pro" && race.state === "racing") {
    msg.lap = race.lap;
    msg.prog = +race.prog.toFixed(3);
    msg.lapMs = Math.round(race.lapMark); // 순위판: 랩 넘긴 순간의 기록(라이브 아님)
  }
  net.ws.send(JSON.stringify(msg));
}

// 렌더를 서버 시각보다 이만큼 과거로 늦춰(재생 시계), 그 사이 도착한 스냅샷을
// 확보해두고 "서버 송신 시각(일정 간격)" 기준으로 두 스냅샷을 보간한다.
// → 도착 지터/버스트가 있어도 일정 속도로 매끈하게 움직인다.
// 적응형 보간 지연 : 스냅샷 도착 지터를 재서 버퍼 깊이를 자동 조절한다.
//  망이 매끈하면 지연을 최소로(저지연), 지터/랙이 심하면 자동으로 키워 끊김을 막는다.
const INTERP_BASE = 40;   // 최소 지연(ms) — 아주 매끈한 망
const INTERP_MAX = 220;   // 최대 지연(ms) — 지터/랙 심할 때 상한
let interpDelay = 60;     // 현재 적용 중인 지연(ms), 매 스냅샷마다 동적 조절
let lastSnapAt = 0;       // 직전 스냅샷 도착 시각(클라 시계)
let snapGapMax = 33;      // 최근 최대 도착 간격(감쇠) — 지터 추정치
const MAX_EXTRAP = 180;   // ms : 패킷이 늦으면 마지막 속도로 이 시간까지 외삽(지터 흡수 → 안 끊김)

// 원격 차량 : 데드레커닝(속도 외삽) + 지수 오차보정.
//  핵심 — 매 프레임 "권위 타깃을 그 차의 속도로 재생시각까지 투영" 한 목표로 부드럽게 수렴한다.
//  스냅샷이 늦거나 빠져도 속도로 계속 나아가므로 "절대 멈추거나 끊기지 않는다". 새 스냅샷이
//  오면 목표만 살짝 바뀌고 차는 이징으로 스르륵 따라가 스냅(튐)이 안 보인다.
const SMOOTH_K = 16; // 오차 수렴 속도(클수록 빨리 따라붙고, 작을수록 더 부드럽지만 지연↑)
function updateRemotes(dt) {
  if (net.serverNewest === 0 && !net.hasServerTime) { return; }
  // 재생 시계 : 실시간으로 계속 전진(끊겨도 진행) + (서버최신 - interpDelay)로 부드럽게 수렴
  const target = net.serverNewest - interpDelay;
  if (net.playT === null) net.playT = target;
  else {
    net.playT += dt * 1000;
    net.playT += (target - net.playT) * clamp(dt * 2.5, 0, 1);
    if (net.playT > net.serverNewest + MAX_EXTRAP) net.playT = net.serverNewest + MAX_EXTRAP;
    if (net.serverNewest - net.playT > interpDelay + 500) net.playT = target; // 너무 뒤처지면 리싱크
  }
  const renderT = net.playT;
  const a = 1 - Math.exp(-SMOOTH_K * dt); // 지수 이징 계수(프레임레이트 독립)

  for (const [id, r] of remotePlayers) {
    if (r.tst == null) continue;
    // 타깃(권위 상태)을 그 차의 속도로 재생시각까지 투영 → 목표 위치(끊김 없이 이어짐)
    let ageS = (renderT - r.tst) / 1000;
    ageS = clamp(ageS, -0.3, MAX_EXTRAP / 1000); // 과도 외삽 방지(방향전환 오버슛 억제)
    const px = r.tx + r.tvx * ageS;
    const py = r.ty + r.tvy * ageS;
    if (r.snap) {                    // 첫 등장/텔레포트 → 즉시 스냅
      r.x = px; r.y = py; r.angle = r.ta; r.snap = false;
    } else {
      r.x += (px - r.x) * a;         // 부드럽게 수렴(스냅/튐 없음)
      r.y += (py - r.y) * a;
      let d = r.ta - r.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      r.angle += d * a;
    }
    // 드리프트 중인 원격 차량의 타이어 자국
    if (r.drifting) pushSkid(r, r.x, r.y, r.angle, SKID_COLOR);
    else r._skid = null;
  }
}

// (구버전 서버 폴백은 데드레커닝으로 통합 — st/속도 없으면 tvx/tvy=0 이라 자연히 최근 위치로 수렴)
function updateRemotesFallback() {
  for (const [id, r] of remotePlayers) {
    if (r.tx == null) continue;
    r.x = lerp(r.x, r.tx, 0.25);
    r.y = lerp(r.y, r.ty, 0.25);
    let d = r.ta - r.angle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    r.angle += d * 0.25;
    if (r.drifting) pushSkid(r, r.x, r.y, r.angle, SKID_COLOR); // drifting 은 스냅샷 핸들러에서 갱신
    else r._skid = null;
  }
}

connect();

// 탭을 닫거나 떠날 때 연결을 즉시 끊어 서버 인원수에 유령으로 남지 않게 한다.
window.addEventListener("pagehide", () => {
  try { if (net.ws && net.ws.readyState === WebSocket.OPEN) net.ws.close(); } catch {}
});


/* =============================================================================
 *  메인 루프
 * ========================================================================== */
let lastTime = performance.now();

function frame(now) {
  // 프레임 간 실제 경과시간(dt). 폭발 방지를 위해 상한 클램프.
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, CONFIG.MAX_DT);

  // 메뉴 화면(미입장)에선 물리/네트워크를 멈춘다 (메뉴 오버레이가 화면을 덮음)
  if (gameState !== "playing") {
    if (sfxDrifting) { sfxDrifting = false; SFX.driftStop(); } // 재생 중이던 드리프트음 정지
    stopEngineSfx();          // 엔진 드론 정지
    sfxBoostStage = 0;        // 부스트 단계 리셋 → 재진입 시 다시 울림
    requestAnimationFrame(frame);
    return;
  }

  // ----- 물리 파이프라인 (역할 분리) -----
  updateInput(CAR, dt);       // 입력
  updateSteering(CAR, dt);    // 조향 (heading 회전)
  decompose(CAR);             // 속도 → 전진/측면 분해 (슬립 앵글 발생)
  updateEngine(CAR, dt);      // 엔진 가속
  updateBrake(CAR, dt);       // 브레이크
  updateReverse(CAR, dt);     // 후진 (S)
  updateResistance(CAR, dt);  // 공기/구름 저항
  updateSurface(CAR, dt);     // 노면(레이싱 트랙 이탈 시 감속)
  updateGrip(CAR, dt);        // 그립 (측면 마찰) → 드리프트
  updatePhysics(CAR, dt);     // 속도/위치 합성·적분
  updateCollision(CAR);       // 맵 경계 충돌
  updateLap(CAR);             // 프로 레이싱 바퀴 추적
  updateAttack(CAR);          // 자유 모드 타임어택 계측
  updateSkid(CAR);            // 스키드 마크
  if (gameMode === "lobby") updateLobby(dt); // 로비: 오버레이 상태 + 게이트 진입 판정
  const spdKmh = Math.abs(CAR.lf) * PXS_TO_KMH;
  updateDriftSfx();           // 드리프트 스크리치(지속음) 시작/정지
  updateEngineSfx(spdKmh);    // 엔진 드론 (속도 → 피치)
  updateBoostSfx(spdKmh);     // 부스트 단계음 (450/500/525)
  updateCamera(CAR, dt);      // 카메라 추적 (+ 흔들림 감쇠)

  // ----- 네트워크 -----
  netSend(CAR, now);          // 내 상태 송신
  updateRemotes(dt);          // 원격 차량 보간 (서버 타임스탬프 기반)
  updatePlayerCollision(CAR); // 원격 위치 갱신 후, 내 차를 상대 밖으로 밀어냄(겹침 방지)
  updateExplosions(dt);       // 폭발 이펙트 갱신 (킬 판정은 서버가 통지)

  render(CAR);                // 렌더

  requestAnimationFrame(frame);
}

/* =============================================================================
 *  모드 선택 / 메뉴 전환
 * ========================================================================== */
/* ---------------------------------------------------------------------------
 *  맵 전환 슬라이드 와이프 : 웜 화이트 패널이 아래에서 올라와 화면을 덮은 순간
 *  swap() 으로 맵을 바꾸고, 꽉 찬 상태로 1초 멈춰 맵 제목/설명을 보여준 뒤
 *  위로 계속 올라가며 걷힌다. info = { title, desc } (없으면 홀드 없이 바로 걷힘)
 * ------------------------------------------------------------------------ */
const wipeEl = document.getElementById("wipe");
let wipeBusy = false;
function wipeTo(swap, info) {
  if (wipeBusy || !wipeEl || !wipeEl.animate) { swap(); return; } // 전환 중 재요청/미지원 → 즉시 전환
  wipeBusy = true;
  let swapped = false;
  const doSwap = () => { if (!swapped) { swapped = true; try { swap(); } catch (e) { console.error(e); } } };
  const finish = () => {
    clearTimeout(failsafe);
    for (const a of wipeEl.getAnimations()) a.cancel(); // forwards-fill 이 transform 을 계속 점유하지 않게 정리
    wipeEl.style.display = "none";
    wipeBusy = false;
  };
  // 안전망 : 탭 숨김 등으로 애니메이션이 멈춰도 맵 전환만은 보장하고 잠금을 푼다
  const failsafe = setTimeout(() => { doSwap(); finish(); }, 5000);
  const hold = info ? 1000 : 0; // 꽉 찬 상태로 멈춰 맵 정보를 읽을 시간
  document.getElementById("wipeTitle").textContent = info ? info.title : "";
  document.getElementById("wipeDesc").textContent = info ? info.desc : "";
  wipeEl.style.display = "flex";
  const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
  const cover = wipeEl.animate(
    [{ transform: "translateY(100%)" }, { transform: "translateY(0%)" }],
    { duration: 260, easing: ease, fill: "forwards" }
  );
  cover.onfinish = () => {
    doSwap();
    // 두 프레임 뒤(새 맵이 최소 한 번 렌더된 뒤) + 홀드 시간이 지나면 걷는다
    requestAnimationFrame(() => requestAnimationFrame(() => {
      setTimeout(() => {
        const reveal = wipeEl.animate(
          [{ transform: "translateY(0%)" }, { transform: "translateY(-100%)" }],
          { duration: 300, easing: ease, fill: "forwards" }
        );
        reveal.onfinish = finish;
      }, hold);
    }));
  };
}

function startGame(mode) {
  gameMode = mode;
  world = WORLD[mode];

  // 이름 확정 : 로그인 = 계정 닉네임, 비로그인 = 저장된 이름 (닉네임 편집은 계정 팝업에서)
  if (account.loggedIn) {
    playerName = account.nickname;
  } else {
    let stored = "";
    try { stored = (localStorage.getItem("carGameName") || "").trim(); } catch {}
    playerName = stored.slice(0, 12) || "Player";
  }

  // 로비 오버레이/팝업 숨김 + 카메라 원복(줌/앵커)
  document.getElementById("lobbyUI").style.display = "none";
  document.getElementById("mapModal").classList.remove("show");
  mapPopup.open = false;
  document.body.classList.remove("lobby"); // 인게임은 다크 스킨 유지
  camera.zoom = camera.zoomT = zoomFor(1); // 인게임 기본 줌 × 시야각
  camera.ay = camera.ayT = 0.5;
  minimap.style.display = "block";
  speedEl.style.display = showSpeed ? "block" : "none"; // 좌측 상단 현재 속력 (설정)

  // 상태 초기화
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  camera.shake = 0;
  // 채팅 로그는 비우지 않는다 → 나갔다 다시 들어와도 이전 대화가 보인다
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
  keys.w = keys.a = keys.s = keys.d = keys.space = false; // 메뉴 조작으로 눌린 키 초기화

  // 레이싱 위치 결정
  //  - racing/hard/serp/test : 트랙 출발선 뒤에서 시작 (서버 spawn 없음)
  //  - pro : 로비 진입. 서버 proStart 가 그리드 슬롯을 정해줌.
  race.state = "none"; race.myReady = false;
  if (isTimeAttackMode() || mode === "test") {
    placeBehindStart(); // 출발선 바로 뒤에서 스폰 (테스트/레이싱 공통)
    CAR.invulnUntil = performance.now() + 1500;
    net.pendingTeleport = true;
    updateCamera(CAR, 0);
  } else if (mode === "pro") {
    race.state = "browsing"; // 방 목록 화면. roomList/roomJoined 로 갱신됨
    race.isHost = false; race.myReady = false; race.rooms = [];
  }

  if (isTimeAttackMode()) resetAttack();
  if (mode !== "pro") SFX.start(); // 게임 시작 사운드(프로는 방/카운트다운에서 GO로 대체)

  gameState = "playing";
  document.getElementById("menu").classList.remove("show");
  updateRaceUI();
  updateTouchVisibility();
  updateFreeUI();
  updateMainLink(); // 메인 링크 숨김

  sendJoin(); // 서버에 입장
}

// "메뉴로" = 로비 월드로 복귀 (접속 화면 = 로비)
function toMenu() {
  if (gameMode === "lobby") return;
  enterLobby();
}

/* 방향키 안내(키캡) : 새로고침 후 "첫" 로비 대기화면에서만 보인다.
   한 번 움직여서 오버레이를 걷으면 그 뒤로는 ESC/자동복귀로 떠도 숨긴다. */
let lobHintFirst = true;
function applyLobHint() {
  const el = document.getElementById("lobHint");
  if (el) el.style.display = lobHintFirst ? "" : "none";
}

/* 로비 진입 : 웜 화이트 월드에 차 스폰, 대기 오버레이 표시. 서버엔 미입장(로컬 전용). */
function enterLobby() {
  sendLeave();
  gameMode = "lobby";
  world = WORLD.lobby;
  gameState = "playing"; // 로비도 실제 주행 상태 (물리/렌더 모두 동작)
  race.state = "none";
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  camera.shake = 0;
  resetAttack();

  // 차 스폰 (가운데 아래쪽, 위를 보고)
  CAR.x = LOBBY_SPAWN.x; CAR.y = LOBBY_SPAWN.y; CAR.angle = -Math.PI / 2;
  CAR.vx = CAR.vy = CAR.lf = CAR.ll = CAR.steerInput = 0;
  keys.w = keys.a = keys.s = keys.d = keys.space = false;

  // 카메라 : 대기 상태 = 확대 + 차가 화면 36% 지점 (시야각 배율 적용)
  camera.zoom = camera.zoomT = zoomFor(1.15);
  camera.ay = camera.ayT = 0.36;
  updateCamera(CAR, 0);

  // 오버레이 : 대기(전부 표시)
  lobby.ui = "idle"; lobby.stopMs = 0; lobby.gate = null; lobby.prog = 0;
  const ui = document.getElementById("lobbyUI");
  ui.style.display = "block";
  ui.classList.remove("s-hidden");
  applyLobHint(); // 첫 진입에만 방향키 키캡 표시
  document.body.classList.add("lobby"); // 채팅 등 DOM 라이트 스킨

  // 로비에서 안 쓰는 HUD 숨김
  document.getElementById("exitBtn").style.display = "none";
  document.getElementById("death").classList.remove("show");
  minimap.style.display = "none";
  speedEl.style.display = "none";
  updateRaceUI();
  updateTouchVisibility();
  updateFreeUI();
  setTimeHud("");
  updateProTimer();
}

/* 로비 대기 상태로 복귀 (ESC) : 리스폰 없이 "그 자리에서" 줌인 + 메뉴 오버레이 전체 표시 */
function lobbyIdle() {
  if (lobby.ui === "idle" && !custom.active && !mapPopup.open) return;
  if (custom.active) closeCustom();
  if (mapPopup.open) closeMapPopup();
  lobby.ui = "idle"; lobby.stopMs = 0; lobby.gate = null; lobby.prog = 0;
  CAR.vx = CAR.vy = CAR.lf = CAR.ll = 0; // 메뉴 보는 동안 차 정지
  const ui = document.getElementById("lobbyUI");
  ui.classList.remove("s-hidden");
  applyLobHint(); // ESC/자동복귀로 다시 뜰 땐 방향키 키캡 숨김 (flag=false)
  camera.zoomT = zoomFor(1.15); // 다시 줌인 (시야각 배율)
  camera.ayT = 0.36;   // 차를 위쪽(36%)으로
}

/* 로비 갱신 : 오버레이 상태 머신 + 게이트 진입 판정 */
function updateLobby(dt) {
  const ui = document.getElementById("lobbyUI");
  const inputHeld = keys.w || keys.s || keys.a || keys.d || keys.space;

  // 로비 전용 : 입력이 없으면 금방 멈추도록 추가 감쇠 (메뉴 공간에서 하염없이 미끄러지지 않게)
  if (!inputHeld) {
    const f = Math.exp(-1.6 * dt);
    CAR.vx *= f; CAR.vy *= f;
  }
  const speed = Math.hypot(CAR.vx, CAR.vy);

  // 커스텀(색상 선택) 열림 : 오버레이/게이트 상태머신 정지.
  //  키 입력이 아니라 "실제로 차가 움직여야" 닫힌다 (조향/브레이크만 눌러선 유지).
  if (custom.active) {
    if (speed > 30) { SFX.click(); closeCustom(); } // 움직여서 닫힘 (다른 메뉴와 같은 효과음)
    return;
  }
  // 맵 팝업 열림 : 마찬가지로 실제로 움직이면 닫힌다
  if (mapPopup.open) {
    if (speed > 30) { SFX.click(); closeMapPopup(); }
    return;
  }
  // 커스텀 방 목록 열림 (로비 위 브라우징) : 움직이면 닫힌다
  if (race.state === "browsing") {
    if (speed > 30) { SFX.click(); closeCustomRooms(); }
    return;
  }
  // 대기실(방 참가 상태) : 시작까지 로비에서 차 고정 — 움직여도 방에서 나가지지 않는다
  if (race.state === "lobby" || race.state === "countdown") {
    CAR.vx = CAR.vy = CAR.lf = CAR.ll = 0;
    return;
  }

  if (lobby.ui === "idle") {
    // 첫 입력 → UI 걷힘 + 줌아웃 + 차 중앙으로
    if (inputHeld || speed > 30) {
      lobby.ui = "hidden";
      lobHintFirst = false; // 첫 오버레이를 걷은 순간부터 방향키 안내는 다신 안 뜬다
      ui.classList.add("s-hidden");
      camera.zoomT = zoomFor(0.95); // 주행 시 줌아웃 (원래 0.95 × 시야각)
      camera.ayT = 0.5;    // 차 중앙
    }
  } else {
    // 1.5초 정지 → ESC 와 동일하게 전체 UI 페이드인 + 카메라 복귀
    if (speed < 20 && !inputHeld) {
      lobby.stopMs += dt * 1000;
      if (lobby.stopMs >= 1500) lobbyIdle();
    } else {
      lobby.stopMs = 0;
    }
  }

  // 게이트 진입 : 패치 안에 머무르면 도넛이 차오르고, 가득 차면 입장
  let g = null;
  for (const gate of LOBBY_GATES) {
    if (Math.abs(CAR.x - gate.x) < gate.w / 2 && Math.abs(CAR.y - gate.y) < gate.h / 2) { g = gate; break; }
  }
  // 재무장 대기 : 방금 커스텀을 닫은 게이트는 완전히 벗어나야 다시 반응한다
  if (lobby.holdGate) {
    if (g === lobby.holdGate) g = null;
    else lobby.holdGate = null;
  }
  if (g !== lobby.gate) {
    lobby.gate = g;
    lobby.prog = 0;
  } else if (g) {
    lobby.prog += dt / 1.6; // 진입까지 1.6초 (도넛이 12시→360도)
    if (lobby.prog >= 1) {
      const grp = g.group;
      lobby.gate = null; lobby.prog = 0;
      if (grp === "garage") openCustom();
      else if (grp === "custom") openCustomRooms(); // 커스텀: 로비 위에 방 목록 팝업만
      else if (grp === "test") wipeTo(() => startGame("test"), { title: "주행 테스트", desc: "테스트 입니다" }); // 테스트 트랙 바로 입장
      else openMapPopup(grp);
    }
  }
}

/* 커스텀 방 목록 : 로비(메인 화면)에 머문 채 팝업만 연다.
 *  실제 스테이지 진입은 방을 만들거나 참가해서 roomJoined 를 받았을 때(enterProStage). */
function openCustomRooms() {
  SFX.click(); // 게이트 진입/클릭엔 버튼이 없어 직접 울린다 (다른 메뉴와 동일)
  CAR.vx = CAR.vy = CAR.lf = CAR.ll = 0; // 보는 동안 차 정지
  race.state = "browsing";
  race.isHost = false; race.myReady = false; race.rooms = [];
  lobby.ui = "hidden"; lobby.stopMs = 0;
  document.getElementById("lobbyUI").classList.add("s-hidden");
  // 서버에 커스텀(pro) 브라우징으로 입장 → roomList 실시간 수신
  if (net.connected && net.ws.readyState === WebSocket.OPEN) {
    let stored = "";
    try { stored = (localStorage.getItem("carGameName") || "").trim(); } catch {}
    playerName = account.loggedIn ? account.nickname : (stored.slice(0, 12) || "Player");
    net.ws.send(JSON.stringify({ type: "join", mode: "pro", name: playerName }));
  }
  updateRaceUI();
}

function closeCustomRooms() {
  race.state = "none";
  sendLeave(); // 서버 브라우징에서 이탈
  hideCreateRoom();
  // 게이트를 벗어나야 재무장 (다른 팝업들과 동일)
  lobby.holdGate = LOBBY_GATES.find((x) => x.group === "custom") || null;
  updateRaceUI();
}

/* 내 그리드 슬롯에 차 배치 (스테이지 안에서만 호출) */
function placeOnProGrid() {
  const g = proGridPosition(race.slot);
  CAR.x = g.x; CAR.y = g.y; CAR.angle = g.angle;
  CAR.vx = 0; CAR.vy = 0; CAR.lf = 0; CAR.ll = 0; CAR.steerInput = 0;
  net.pendingTeleport = true;
  updateCamera(CAR, 0);
}

/* 게임 시작(카운트다운) 확정 → 이제 실제 스테이지(커스텀 월드)로 전환 */
function enterProStage() {
  gameMode = "pro";
  world = WORLD.pro;
  remotePlayers.clear();
  skidMarks.length = 0;
  explosions.length = 0;
  camera.shake = 0;
  camera.zoom = camera.zoomT = zoomFor(1); // 인게임 기본 줌 × 시야각
  camera.ay = camera.ayT = 0.5;
  document.getElementById("lobbyUI").style.display = "none";
  document.getElementById("mapModal").classList.remove("show");
  mapPopup.open = false;
  document.body.classList.remove("lobby");
  minimap.style.display = "block";
  speedEl.style.display = showSpeed ? "block" : "none"; // 좌측 상단 현재 속력 (설정)
  updateTouchVisibility();
  updateFreeUI();
}

/* 그룹 맵 팝업 : 카드(16:9, 최대 3열)로 맵 목록 표시. 클릭 = 입장, 준비 중 = 비활성. */
function openMapPopup(groupKey) {
  const grp = MAP_GROUPS[groupKey];
  if (!grp) return;
  SFX.click(); // 다른 메뉴(버튼 클릭음)와 동일한 효과음 — 게이트 진입/클릭엔 버튼이 없어 직접 울린다
  mapPopup.open = true;
  mapPopup.group = groupKey;
  CAR.vx = CAR.vy = CAR.lf = CAR.ll = 0; // 고르는 동안 차 정지
  document.getElementById("mapModalTitle").textContent = grp.title;
  document.getElementById("mapModalDesc").textContent = grp.desc;
  const grid = document.getElementById("mapGrid");
  grid.innerHTML = "";
  for (const m of grp.maps) {
    const card = document.createElement("button");
    card.className = "map-card" + (m.mode ? "" : " soon");
    const nm = document.createElement("div");
    nm.className = "map-card-name";
    nm.textContent = m.name;
    const ds = document.createElement("div");
    ds.className = "map-card-desc";
    ds.textContent = m.desc;
    card.append(nm, ds);
    if (m.mode) {
      // "준비 중" 칩과 같은 스타일로 현재 접속 인원 표시
      const cnt = document.createElement("span");
      cnt.className = "map-card-count";
      cnt.dataset.mode = m.mode;
      cnt.textContent = `${modeCounts[m.mode] || 0}명`;
      card.appendChild(cnt);
      card.addEventListener("click", () => { closeMapPopup(); wipeTo(() => startGame(m.mode), { title: m.name, desc: m.desc }); });
    } else {
      const chip = document.createElement("span");
      chip.className = "map-card-soon";
      chip.textContent = "준비 중";
      card.appendChild(chip);
      card.disabled = true;
    }
    grid.appendChild(card);
  }
  document.getElementById("mapModal").classList.add("show");
}

function closeMapPopup() {
  if (!mapPopup.open) return;
  mapPopup.open = false;
  document.getElementById("mapModal").classList.remove("show");
  // 게이트 위에 있어도 팝업이 바로 다시 열리지 않게 — 벗어나야 재무장
  const g = LOBBY_GATES.find((x) => x.group === mapPopup.group);
  if (g) lobby.holdGate = g;
}

// 맵 팝업이 열려 있으면 각 카드의 "n명" 칩을 최신 접속자 수로 갱신 (counts 수신 시 호출)
function updateMapPopupCounts() {
  if (!mapPopup.open) return;
  for (const el of document.querySelectorAll("#mapGrid .map-card-count")) {
    el.textContent = `${modeCounts[el.dataset.mode] || 0}명`;
  }
}

/* 커스텀 열기 : 차 정지 + 현재 위치를 링 중심으로 고정, 카메라 살짝 줌인 */
function openCustom() {
  SFX.click(); // 게이트 진입/클릭엔 버튼이 없어 직접 울린다 (다른 메뉴와 동일)
  custom.active = true;
  custom.cx = CAR.x;
  custom.cy = CAR.y;
  CAR.vx = CAR.vy = CAR.lf = CAR.ll = 0;
  lobby.ui = "hidden";
  lobby.stopMs = 0;
  document.getElementById("lobbyUI").classList.add("s-hidden");
  document.body.classList.add("customizing"); // 채팅 등 DOM 이 링을 가리지 않게 페이드아웃
  camera.zoomT = zoomFor(1.2); // 색상 선택 줌인 (시야각 배율)
  camera.ayT = 0.5;
}

function closeCustom() {
  custom.active = false;
  custom.selAnim = null;
  // 아직 게이트 위에 있어도 도넛이 바로 다시 차지 않게 — 게이트를 벗어나야 재무장
  lobby.holdGate = LOBBY_GATES.find((g) => g.group === "garage") || null;
  document.body.classList.remove("customizing");
  canvas.style.cursor = "";
  camera.zoomT = zoomFor(0.95); // 주행 뷰로 복귀 (원래 0.95 × 시야각)
  camera.ayT = 0.5;
}

// 메뉴 UI 배선
function setupMenu() {
  const input = document.getElementById("nameInput");
  // 저장된 이름 자동완성
  try { input.value = localStorage.getItem("carGameName") || ""; } catch {}

  document.getElementById("btnRacing").addEventListener("click", () => startGame("racing"));
  document.getElementById("btnHard").addEventListener("click", () => startGame("hard"));
  document.getElementById("btnSerp").addEventListener("click", () => startGame("serp"));
  document.getElementById("btnPro").addEventListener("click", () => startGame("pro"));
  document.getElementById("exitBtn").addEventListener("click", toMenu);

  // 프로 로비 준비 버튼
  document.getElementById("readyBtn").addEventListener("click", () => {
    race.myReady = !race.myReady;
    sendReady(race.myReady);
    updateRaceUI();
  });
  document.getElementById("lobbyLeave").addEventListener("click", sendLeaveRoom); // 방 → 브라우저

  // 방 브라우저 / 방 만들기 다이얼로그 (나가기는 좌측 상단 exitBtn 으로 통일)
  document.getElementById("createRoomBtn").addEventListener("click", showCreateRoom);
  document.getElementById("crCreate").addEventListener("click", sendCreateRoom);
  document.getElementById("crCancel").addEventListener("click", hideCreateRoom);

  // 자유 모드 타임어택 기록 시작
  document.getElementById("attackBtn").addEventListener("click", startAttack);
  document.getElementById("attackCancel").addEventListener("click", cancelAttack);
  document.getElementById("othersToggle").addEventListener("click", () => {
    showOthers = !showOthers;
    try { localStorage.setItem("showOthers", showOthers ? "1" : "0"); } catch {}
    applyOthersToggle();
  });
}

/* 로비 오버레이 배선 : 원형 아이콘 버튼(계정/대시보드/로그아웃/디스코드) + 게이트 클릭 입장 */
function setupLobbyUI() {
  document.getElementById("lobAccount").addEventListener("click", () => {
    if (account.loggedIn) showAccountModal(); // 계정 정보 (아이디/닉네임)
    else showAuthModal();
  });
  document.getElementById("accClose").addEventListener("click", hideAccountModal);
  document.getElementById("accountModal").addEventListener("pointerdown", (e) => {
    if (e.target.id === "accountModal") { SFX.click(); hideAccountModal(); } // 딤 클릭(버튼 아님)
  });

  // 설정 팝업 : 사운드 볼륨 + 미니맵/채팅 모서리 배치
  document.getElementById("lobSettings").addEventListener("click", () => { SFX.resume(); showSettingsModal(); });
  document.getElementById("setClose").addEventListener("click", hideSettingsModal);
  document.getElementById("settingsModal").addEventListener("pointerdown", (e) => {
    if (e.target.id === "settingsModal") { SFX.click(); hideSettingsModal(); } // 딤 클릭(버튼 아님)
  });
  const volInput = document.getElementById("setVolume");
  volInput.addEventListener("input", () => {
    document.getElementById("setVolumeVal").textContent = volInput.value;
    SFX.setVolume(volInput.value / 100);
  });
  volInput.addEventListener("change", () => SFX.click()); // 놓았을 때 현재 볼륨으로 미리듣기
  const fovInput = document.getElementById("setFov");
  fovInput.addEventListener("input", () => {
    const oldMult = fovMult();
    fov = parseInt(fovInput.value, 10);
    document.getElementById("setFovVal").textContent = fovInput.value;
    try { localStorage.setItem("fov", String(fov)); } catch {}
    // 현재 줌을 배율 변화만큼 재조정 → 인게임/로비 어느 상태든 동일하게 즉시 반영
    const ratio = fovMult() / oldMult;
    camera.zoomT *= ratio;
    camera.zoom *= ratio;
  });
  for (const [segId, key] of [["setMmPos", "mm"], ["setChatPos", "chat"]]) {
    document.getElementById(segId).addEventListener("click", (e) => {
      const b = e.target.closest("button[data-pos]");
      if (!b) return;
      hudLayout[key] = b.dataset.pos;
      applyHudLayout();
      saveHudLayout();
      syncSettingsUI();
      SFX.click();
    });
  }
  // 속력 표시 켜기/끄기
  document.getElementById("setSpeed").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-val]");
    if (!b) return;
    showSpeed = b.dataset.val === "on";
    try { localStorage.setItem("showSpeed", showSpeed ? "1" : "0"); } catch {}
    applySpeedVisibility();
    syncSettingsUI();
    SFX.click();
  });
  document.getElementById("lobDash").addEventListener("click", showDashboard);
  document.getElementById("lobLogout").addEventListener("click", () => { sendLogout(); });

  // 게이트 클릭/탭으로도 입장 (모바일 폴백) + 커스텀 스와치 선택
  canvas.addEventListener("pointerdown", (e) => {
    if (gameMode !== "lobby") return;
    const wx = camera.x + e.clientX / camera.zoom;
    const wy = camera.y + e.clientY / camera.zoom;
    if (custom.active) {
      const i = hitCustomSwatch(wx, wy);
      if (i >= 0) {
        // 픽커(선택 링)가 이전 색 → 새 색으로 원호를 따라 슬라이드 (팔레트는 정적)
        const prevI = CAR_COLORS.findIndex((c) => c.toLowerCase() === myColor().toLowerCase());
        if (prevI >= 0 && prevI !== i) {
          const from = custom.selAnim ? currentPickerAngle() : customSwatchAngle(prevI);
          const to = customSwatchAngle(i);
          const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from)); // 최단 방향
          custom.selAnim = { from, delta, at: performance.now() };
        }
        setCarColor(CAR_COLORS[i]);
        SFX.click();
      }
      return; // 커스텀 중엔 게이트 클릭 무시
    }
    for (const g of LOBBY_GATES) {
      if (Math.abs(wx - g.x) < g.w / 2 && Math.abs(wy - g.y) < g.h / 2) {
        if (g.group === "garage") openCustom();
        else if (g.group === "custom") openCustomRooms(); // 커스텀: 로비 위에 방 목록 팝업만
        else if (g.group === "test") wipeTo(() => startGame("test"), { title: "주행 테스트", desc: "테스트 입니다" }); // 테스트 트랙 바로 입장
        else openMapPopup(g.group);
        return;
      }
    }
  });

  // 맵 팝업 닫기 : 닫기 버튼(전역 버튼음) / 배경(딤) 클릭(직접 울림)
  document.getElementById("mapModalClose").addEventListener("click", closeMapPopup);
  document.getElementById("mapModal").addEventListener("pointerdown", (e) => {
    if (e.target.id === "mapModal") { SFX.click(); closeMapPopup(); }
  });

  // 커스텀 방 목록 닫기 : 배경(딤) 클릭 (로비 위에서 브라우징 중일 때만)
  document.getElementById("roomBrowser").addEventListener("pointerdown", (e) => {
    if (e.target.id === "roomBrowser" && gameMode === "lobby") { SFX.click(); closeCustomRooms(); } // 딤 클릭(버튼 아님)
  });

  // 대기실 초대 링크 복사 (원형 버튼) : 누르면 클립보드에 복사 + 체크 표시
  const shareBtn = document.getElementById("shareRoomBtn");
  shareBtn.addEventListener("click", async () => {
    if (race.roomId == null) return;
    const url = `${location.origin}${location.pathname}?room=${race.roomId}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 클립보드 API 실패 시 폴백
      const t = document.createElement("input");
      t.value = url;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    shareBtn.classList.add("copied");
    setTimeout(() => shareBtn.classList.remove("copied"), 1200);
  });

  // 스와치 위에서만 pointer 커서 (호버 확대 효과는 없음)
  canvas.addEventListener("mousemove", (e) => {
    if (!(gameMode === "lobby" && custom.active)) {
      if (canvas.style.cursor) canvas.style.cursor = "";
      return;
    }
    const wx = camera.x + e.clientX / camera.zoom;
    const wy = camera.y + e.clientY / camera.zoom;
    canvas.style.cursor = hitCustomSwatch(wx, wy) >= 0 ? "pointer" : "";
  });

}

/* =============================================================================
 *  로그인 / 회원가입 / 대시보드
 * ========================================================================== */
function sendAuth(obj) {
  if (!net.connected || net.ws.readyState !== WebSocket.OPEN) { alert("서버 연결 중입니다. 잠시 후 다시 시도하세요."); return; }
  net.ws.send(JSON.stringify(obj));
}
// 비밀번호 정책 : 8~64자, 공백 없음, 영문·숫자·특수기호 각 1개 이상 (서버와 동일)
const PW_RULE_MSG = "비밀번호는 8자 이상, 영문·숫자·특수기호를 모두 포함해야 합니다.";
function validPassword(pw) {
  pw = String(pw || "");
  return pw.length >= 8 && pw.length <= 64 && !/\s/.test(pw)
    && /[A-Za-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}
function sendLogin() {
  const id = document.getElementById("loginId").value.trim();
  const pw = document.getElementById("loginPw").value;
  // 로그인은 정책을 강제하지 않는다(기존 계정의 옛 비번도 통과해야 하므로) — 서버가 검증
  if (!id || !pw) { alert("아이디와 비밀번호를 입력하세요."); return; }
  sendAuth({ type: "login", id, password: pw });
}
function sendSignup() {
  const id = document.getElementById("signupId").value.trim();
  const nickname = document.getElementById("signupNick").value.trim();
  const pw = document.getElementById("signupPw").value;
  if (!/^[A-Za-z0-9_]{3,20}$/.test(id)) { alert("아이디는 영문/숫자 3~20자입니다."); return; }
  if (!nickname) { alert("닉네임을 입력하세요."); return; }
  if (!validPassword(pw)) { alert(PW_RULE_MSG); return; }
  sendAuth({ type: "signup", id, nickname, password: pw });
}
function sendLogout() {
  let tk = null;
  try { tk = localStorage.getItem("carGameToken"); localStorage.removeItem("carGameToken"); } catch {}
  if (net.connected && net.ws.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify({ type: "logout", token: tk }));
  account.loggedIn = false; account.isAdmin = false; account.userId = null;
  account.proWins = 0; account.proPlays = 0;
  account.totalTime = 0; account.totalTimeAt = 0; account.bestMs = 0; account.bestHardMs = 0; account.bestSerpMs = 0; account.loginTime = 0;
  updateAuthUI();
}

// 로그인/회원가입 팝업 열기/닫기
function showAuthModal() {
  document.getElementById("loginForm").style.display = "block";
  document.getElementById("signupForm").style.display = "none";
  document.getElementById("authModal").classList.add("show");
}
function hideAuthModal() {
  document.getElementById("authModal").classList.remove("show");
}

// 로그인 상태에 따라 메뉴 인증 영역(버튼) + 대시보드 버튼 토글
function updateAuthUI() {
  const inn = account.loggedIn;
  document.getElementById("authOpenBtn").style.display = inn ? "none" : "block";
  document.getElementById("loggedIn").style.display = inn ? "block" : "none";
  document.getElementById("dashBtn").style.display = "none"; // 구 대시보드 버튼 → 로비 원형 버튼으로 대체
  // 로비 원형 버튼 : 비로그인 = 계정+디스코드만, 로그인 = 4개 전부
  document.getElementById("lobDash").style.display = inn ? "flex" : "none";
  document.getElementById("lobLogout").style.display = inn ? "flex" : "none";
  // 로그인 상태면 닉네임 입력/라벨을 아예 숨긴다(계정 닉네임 사용). 비로그인 시 표시.
  document.getElementById("nameInput").style.display = inn ? "none" : "block";
  document.getElementById("nameLabel").style.display = inn ? "none" : "block";
  if (inn) {
    document.getElementById("welcomeMsg").textContent =
      `${account.nickname}님 환영합니다${account.isAdmin ? " (관리자)" : ""}`;
    const ni = document.getElementById("nameInput");
    ni.value = account.nickname; ni.disabled = true;
  } else {
    document.getElementById("nameInput").disabled = false;
  }
}

let dashTimer = null;
function updateDashboard() {
  document.getElementById("dashWins").textContent = account.proWins;
  document.getElementById("dashPlays").textContent = account.proPlays;
  // 접속 시간 = 서버가 보낸 실시간 평생값 + 수신 후 경과분 (라이브, 이중계산 없음)
  const sinceSync = account.totalTimeAt ? (Date.now() - account.totalTimeAt) : 0;
  const s = Math.floor((account.totalTime + sinceSync) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  document.getElementById("dashTime").textContent =
    (h ? h + "시간 " : "") + m + "분 " + sec + "초";
  // 자유 레이싱 개인 최고 기록
  const best = document.getElementById("dashBest");
  if (best) best.textContent = account.bestMs ? fmtRaceTime(account.bestMs) : "-";
  // 하드코어 레이싱 개인 최고 기록
  const bestHard = document.getElementById("dashBestHard");
  if (bestHard) bestHard.textContent = account.bestHardMs ? fmtRaceTime(account.bestHardMs) : "-";
  // 구불구불 레이싱 개인 최고 기록
  const bestSerp = document.getElementById("dashBestSerp");
  if (bestSerp) bestSerp.textContent = account.bestSerpMs ? fmtRaceTime(account.bestSerpMs) : "-";
}
function showAccountModal() {
  document.getElementById("accId").textContent = account.userId || "-";
  document.getElementById("accName").textContent = account.nickname || "-";
  // 비밀번호 변경 폼 초기화
  const cur = document.getElementById("accCurPw"); if (cur) cur.value = "";
  const nw = document.getElementById("accNewPw"); if (nw) nw.value = "";
  setAccPwMsg("", true);
  document.getElementById("accountModal").classList.add("show");
}
function hideAccountModal() {
  document.getElementById("accountModal").classList.remove("show");
}
// 계정 팝업의 비밀번호 변경 안내문 (성공=초록, 실패=코랄)
function setAccPwMsg(text, ok) {
  const el = document.getElementById("accPwMsg");
  if (!el) return;
  el.textContent = text || "";
  el.style.color = ok ? "var(--green)" : "var(--coral)";
}
// 현재 비번 + 새 비번 검증 후 서버로 변경 요청
function sendChangePassword() {
  const cur = document.getElementById("accCurPw").value;
  const next = document.getElementById("accNewPw").value;
  if (!cur) { setAccPwMsg("현재 비밀번호를 입력하세요.", false); return; }
  if (!validPassword(next)) { setAccPwMsg(PW_RULE_MSG, false); return; }
  if (cur === next) { setAccPwMsg("새 비밀번호가 현재와 같습니다.", false); return; }
  sendAuth({ type: "changePassword", current: cur, next });
}

/* 설정 팝업 : 열 때마다 현재 값(볼륨/배치)을 UI 에 동기화 */
function syncSettingsUI() {
  const vol = document.getElementById("setVolume");
  vol.value = Math.round(SFX.getVolume() * 100);
  document.getElementById("setVolumeVal").textContent = vol.value;
  const fovEl = document.getElementById("setFov");
  fovEl.value = fov;
  document.getElementById("setFovVal").textContent = fov;
  for (const [segId, key] of [["setMmPos", "mm"], ["setChatPos", "chat"]]) {
    for (const b of document.getElementById(segId).querySelectorAll("button[data-pos]")) {
      b.classList.toggle("on", b.dataset.pos === hudLayout[key]);
    }
  }
  for (const b of document.getElementById("setSpeed").querySelectorAll("button[data-val]")) {
    b.classList.toggle("on", b.dataset.val === (showSpeed ? "on" : "off"));
  }
}
function showSettingsModal() {
  syncSettingsUI();
  document.getElementById("settingsModal").classList.add("show");
}
function hideSettingsModal() {
  document.getElementById("settingsModal").classList.remove("show");
}

function showDashboard() {
  document.getElementById("dashboard").classList.add("show");
  updateDashboard();
  clearInterval(dashTimer);
  dashTimer = setInterval(updateDashboard, 1000); // 접속 시간 라이브 갱신
}
function hideDashboard() {
  document.getElementById("dashboard").classList.remove("show");
  clearInterval(dashTimer);
}

function setupAuth() {
  document.getElementById("authOpenBtn").addEventListener("click", showAuthModal);
  document.getElementById("authClose").addEventListener("click", hideAuthModal);
  document.getElementById("loginBtn").addEventListener("click", sendLogin);
  document.getElementById("signupBtn").addEventListener("click", sendSignup);
  document.getElementById("logoutBtn").addEventListener("click", sendLogout);
  document.getElementById("toSignup").addEventListener("click", () => {
    document.getElementById("loginForm").style.display = "none";
    document.getElementById("signupForm").style.display = "block";
  });
  document.getElementById("toLogin").addEventListener("click", () => {
    document.getElementById("signupForm").style.display = "none";
    document.getElementById("loginForm").style.display = "block";
  });
  document.getElementById("dashBtn").addEventListener("click", showDashboard);
  document.getElementById("dashClose").addEventListener("click", hideDashboard);
  document.getElementById("accPwBtn").addEventListener("click", sendChangePassword);
  updateAuthUI();
}

/* =============================================================================
 *  모바일 터치 조작 — 터치 버튼을 키보드 keys 와 동일하게 매핑
 * ========================================================================== */
const isTouch = ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);

function setupTouch() {
  if (isTouch) document.body.classList.add("touch");
  document.querySelectorAll(".touch-btn").forEach((btn) => {
    const k = btn.dataset.key;
    if (!k) return;
    const on = (e) => { e.preventDefault(); keys[k] = true; };
    const off = (e) => { e.preventDefault(); keys[k] = false; };
    btn.addEventListener("touchstart", on, { passive: false });
    btn.addEventListener("touchend", off, { passive: false });
    btn.addEventListener("touchcancel", off, { passive: false });
    btn.addEventListener("mousedown", on);   // 마우스로도 테스트 가능
    btn.addEventListener("mouseup", off);
    btn.addEventListener("mouseleave", off);
  });
}
function updateTouchVisibility() {
  document.getElementById("touchControls").classList.toggle("show", isTouch && gameState === "playing");
}

// 자유 모드 UI (기록 시작 버튼 + TOP10 + 다른 차 토글) 표시/숨김
function updateFreeUI() {
  const show = isTimeAttackMode() && gameState === "playing"; // 자유/하드 둘 다 기록 UI 표시
  document.getElementById("attackBtn").style.display = show ? "flex" : "none";
  document.getElementById("topRecords").style.display = show ? "block" : "none";
  document.getElementById("othersToggle").style.display = show ? "block" : "none";
  if (show) { updateTopRecords(); applyOthersToggle(); }
  updateTop10Offset();
}

// 메인(메뉴) 화면에서만 우측 하단 텍스트 링크 표시
function updateMainLink() {
  const el = document.getElementById("mainLink");
  if (el) el.style.display = (gameState === "menu") ? "block" : "none";
}

// TOP10 기록 렌더 (채팅 아래)
function updateTopRecords() {
  const el = document.getElementById("topRecordsList");
  if (!el) return;
  el.innerHTML = "";
  if (!attack.top.length) {
    const empty = document.createElement("div");
    empty.className = "rec-empty";
    empty.textContent = "아직 기록이 없어요";
    el.appendChild(empty);
    return;
  }
  attack.top.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "rec-row";
    const rank = document.createElement("span");
    rank.className = "rec-rank";
    rank.textContent = i + 1;
    const nm = document.createElement("span");
    nm.className = "rec-name";
    nm.textContent = r.name;
    const t = document.createElement("span");
    t.className = "rec-time";
    t.textContent = fmtRaceTime(r.ms);
    row.append(rank, nm, t);
    el.appendChild(row);
  });
  updateTop10Offset();
}

init();
setupMenu();
setupChat();
setupAuth();
setupTouch();
setupAudio();
setupLobbyUI();
enterLobby();     // 접속하자마자 로비 월드에서 시작 (메뉴 화면 없음)
requestAnimationFrame(frame);

// 효과음 배선 : 첫 사용자 입력에서 오디오 컨텍스트 재개 + 버튼 클릭음
function setupAudio() {
  const wake = () => SFX.resume();
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, wake, { passive: true }));
  // 모든 버튼 클릭에 클릭음 (주행용 터치 버튼 제외 — 조작마다 울리면 시끄러움)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn && !btn.classList.contains("touch-btn")) SFX.click();
  }, true);
}
