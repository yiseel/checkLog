import { createClient } from '@supabase/supabase-js';
import { registerSW } from 'virtual:pwa-register';
import KoreanLunarCalendar from 'korean-lunar-calendar';

// 앱(PWA) 설치·오프라인용 서비스 워커 등록. 새 버전이 배포되면 자동으로 갱신된다
registerSW({ immediate: true });

(() => {
  'use strict';

  /* =========================================================
   * 저장소 (localStorage)
   * ========================================================= */
  const STORAGE_KEY = 'daily-planner-v1';

  const emptyDB = () => ({
    routines: [],      // [{ id, name, color, freq: { type, days, times }, memo, startDate }]
    routineChecks: {}, // { 'YYYY-MM-DD': [routineId, ...] }
    todos: {},         // { 'YYYY-MM-DD': [{ id, text, done }] }
    diary: {},         // { 'YYYY-MM-DD': '내용' | { text: '내용', mood: '😊' } } — 기분이 있을 때만 객체
    events: [],        // [{ id, title, start, end, startTime, endTime, place, repeat, color, memo }]
  });

  function loadDB() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...emptyDB(), ...JSON.parse(raw) } : emptyDB();
    } catch (e) {
      return emptyDB();
    }
  }

  const UPDATED_KEY = STORAGE_KEY + '-updated-at';
  // 로컬 데이터가 어느 계정 것인지 (계정 id). 다른 계정으로 로그인하면 서버 데이터를 우선한다.
  const OWNER_KEY = STORAGE_KEY + '-owner';

  function createSupabase() {
    const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
    if (!url || !key) return null;
    try {
      return createClient(url, key);
    } catch (e) {
      console.warn('Supabase 클라이언트를 만들지 못했습니다.', e);
      return null;
    }
  }

  const supabase = createSupabase();
  let remoteReady = false;
  let dirtyDuringLoad = false;
  let pushTimer = null;
  let hydrateSeq = 0;

  /* =========================================================
   * 로그인 (Supabase Auth)
   * Supabase Auth는 이메일로만 계정을 만들 수 있어서, 입력한 아이디를
   * "아이디@LOGIN_EMAIL_DOMAIN" 내부용 이메일로 바꿔 쓴다. 실제 메일은 보내지 않는다
   * (대시보드에서 Confirm email 을 꺼 둬야 함).
   * ========================================================= */
  const LOGIN_EMAIL_DOMAIN = 'checklog.local';
  /** 아이디 규칙: 영문 소문자·숫자·밑줄 4~20자 */
  const USERNAME_PATTERN = /^[a-z0-9_]{4,20}$/;

  let currentUser = null;
  let authLoading = Boolean(supabase);

  const normalizeUsername = (value) => value.trim().toLowerCase();

  /** 로그인용 이메일. '@'가 들어 있으면 이메일 계정으로 보고 그대로 쓴다 */
  const loginEmail = (username) => (username.includes('@') ? username : `${username}@${LOGIN_EMAIL_DOMAIN}`);

  /** 화면에 보여줄 아이디 */
  function usernameOf(user) {
    const fromMeta = user.user_metadata?.username;
    if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
    const email = user.email ?? '';
    return email.endsWith(`@${LOGIN_EMAIL_DOMAIN}`) ? email.split('@')[0] : email;
  }

  function authErrorMessage(error) {
    if (error.code === 'invalid_credentials') return '아이디 또는 비밀번호가 올바르지 않습니다.';
    if (error.code === 'email_not_confirmed') {
      return '인증이 완료되지 않은 계정입니다. Supabase에서 Confirm email 설정을 꺼 주세요.';
    }
    if (error.code === 'user_already_exists' || error.code === 'email_exists') return '이미 사용 중인 아이디입니다.';
    if (error.code === 'weak_password') return '비밀번호는 6자 이상으로 입력해 주세요.';
    if (error.code === 'email_address_invalid') return '사용할 수 없는 아이디입니다.';
    // Confirm email 이 켜져 있으면 가입할 때마다 메일을 보내려다 발송 한도에 걸린다
    if (error.code === 'over_email_send_rate_limit') {
      return '인증 메일 발송 한도를 넘었습니다. Supabase에서 Confirm email 설정을 꺼 주세요.';
    }
    if (error.code === 'over_request_rate_limit') return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    return `요청을 처리하지 못했습니다. ${error.message}`;
  }

  async function ensureProfile(user) {
    if (!supabase) return;
    await supabase.from('profiles').upsert({ id: user.id, username: usernameOf(user) });
  }

  /** 성공하면 '', 실패하면 안내 문구 */
  async function signIn(rawUsername, password) {
    if (!supabase) return 'Supabase가 설정되지 않아 로그인할 수 없습니다.';
    const username = normalizeUsername(rawUsername);
    const { data, error } = await supabase.auth.signInWithPassword({ email: loginEmail(username), password });
    if (error) return authErrorMessage(error);
    if (data.user) await ensureProfile(data.user);
    return '';
  }

  /** 세션이 생기면 {}, 확인이 더 필요하면 notice, 실패하면 error */
  async function signUp(rawUsername, password) {
    if (!supabase) return { error: 'Supabase가 설정되지 않아 가입할 수 없습니다.' };
    const username = normalizeUsername(rawUsername);
    if (!USERNAME_PATTERN.test(username)) {
      return { error: '아이디는 영문 소문자·숫자·밑줄(_)로 4~20자 입력해 주세요.' };
    }
    if (password.length < 6) return { error: '비밀번호는 6자 이상으로 입력해 주세요.' };
    const { data, error } = await supabase.auth.signUp({
      email: loginEmail(username),
      password,
      options: { data: { username } },
    });
    if (error) return { error: authErrorMessage(error) };
    if (data.user && (data.user.identities?.length ?? 0) === 0) {
      return { error: '이미 사용 중인 아이디입니다.' };
    }
    if (!data.session) {
      return { notice: '가입은 되었지만 바로 로그인되지 않았습니다. Supabase에서 Confirm email 설정을 꺼 주세요.' };
    }
    if (data.user) await ensureProfile(data.user);
    return {};
  }

  function clearLocalData() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(UPDATED_KEY);
      localStorage.removeItem(OWNER_KEY);
    } catch (e) {
      /* 무시 */
    }
    db = emptyDB();
  }

  function handleSession(session) {
    const next = session?.user ?? null;
    const prevId = currentUser?.id ?? null;
    const wasLoading = authLoading;
    currentUser = next;
    authLoading = false;
    renderAuthSlot();

    // 토큰 갱신 등 같은 계정이면 다시 불러오지 않는다
    if ((next?.id ?? null) === prevId && !wasLoading) return;

    if (!next) {
      hydrateSeq += 1;
      remoteReady = false;
      clearTimeout(pushTimer);
      setSyncStatus('');
      if (prevId) {
        // 로그아웃하면 이 기기에 남은 계정 데이터를 지운다
        clearLocalData();
        resetEditing();
        if (!routineDraft) route();
      }
      // 비로그인으로 확인됐는데 습관·일정 페이지에 있으면 로그인 화면으로
      if (/^#\/(routine|event)/.test(location.hash)) route();
      return;
    }
    if (location.hash === '#/login') location.replace('#/');
    void hydrateFromSupabase();
  }

  function setSyncStatus(state, detail) {
    const el = document.getElementById('sync-status');
    if (!el) return;
    const missingTable = typeof detail === 'string' && detail.includes('Could not find the table');
    const label = {
      loading: '불러오는 중',
      saving: '저장 중',
      saved: '저장됨',
      error: missingTable ? '테이블 없음' : '저장 실패',
    }[state] || '';
    el.textContent = label;
    el.dataset.state = state;
    el.title = state === 'error'
      ? (missingTable
        ? 'Supabase에 planner_state 테이블이 없습니다. supabase/schema.sql을 실행해 주세요.'
        : 'Supabase에 저장하지 못했습니다.')
      : '';
  }

  function hasLocalData(source) {
    return (
      source.routines.length > 0 ||
      Object.keys(source.todos).length > 0 ||
      Object.keys(source.diary).length > 0 ||
      Object.keys(source.routineChecks).length > 0 ||
      (source.events || []).length > 0
    );
  }

  function stampLocal() {
    const ts = new Date().toISOString();
    try {
      localStorage.setItem(UPDATED_KEY, ts);
    } catch (e) {
      /* 용량 초과 등은 서버 시각 비교에만 영향을 준다 */
    }
    return ts;
  }

  function saveDB() {
    if (currentUser && !remoteReady) dirtyDuringLoad = true;
    stampLocal();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (e) {
      console.warn('저장에 실패했습니다.', e);
    }
    schedulePush();
  }

  function schedulePush() {
    if (!supabase || !currentUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      void pushDB();
    }, 350);
  }

  async function pushDB() {
    if (!supabase || !remoteReady || !currentUser) return;
    setSyncStatus('saving');
    const updatedAt = localStorage.getItem(UPDATED_KEY) || stampLocal();
    const row = {
      id: currentUser.id,
      user_id: currentUser.id,
      routines: db.routines,
      routine_checks: db.routineChecks,
      todos: db.todos,
      diary: db.diary,
      events: db.events || [],
      updated_at: updatedAt,
    };
    let { error } = await supabase.from('planner_state').upsert(row);
    if (error && /events/.test(error.message)) {
      // planner_state 에 events 컬럼이 아직 없음(schema.sql 미실행) → 나머지는 저장하고 일정은 이 기기에만 보관
      console.warn('planner_state.events 컬럼이 없어 일정은 이 기기에만 저장됩니다. supabase/schema.sql 을 실행해 주세요.');
      delete row.events;
      ({ error } = await supabase.from('planner_state').upsert(row));
    }
    if (error) {
      console.warn('Supabase 저장에 실패했습니다.', error.message);
      setSyncStatus('error', error.message);
      return;
    }
    setSyncStatus('saved');
  }

  function applyRemote(row) {
    db = {
      ...emptyDB(),
      routines: Array.isArray(row.routines) ? row.routines : [],
      routineChecks: row.routine_checks && typeof row.routine_checks === 'object' ? row.routine_checks : {},
      todos: row.todos && typeof row.todos === 'object' ? row.todos : {},
      diary: row.diary && typeof row.diary === 'object' ? row.diary : {},
      // events 컬럼이 아직 없으면(undefined) 이 기기에 있던 일정을 유지
      events: Array.isArray(row.events) ? row.events : db.events || [],
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      if (row.updated_at) localStorage.setItem(UPDATED_KEY, new Date(row.updated_at).toISOString());
    } catch (e) {
      console.warn('불러온 데이터를 로컬에 저장하지 못했습니다.', e);
    }
  }

  function fetchRemote(uid) {
    return supabase
      .from('planner_state')
      .select('*') // events 컬럼이 아직 없어도 오류 없이 불러오도록 전체 선택
      .eq('user_id', uid)
      .maybeSingle();
  }

  function setOwner(uid) {
    try {
      localStorage.setItem(OWNER_KEY, uid);
    } catch (e) {
      /* 무시 */
    }
  }

  async function hydrateFromSupabase() {
    if (!supabase || !currentUser) return;
    const seq = ++hydrateSeq;
    const uid = currentUser.id;
    remoteReady = false;
    dirtyDuringLoad = false;
    setSyncStatus('loading');

    let { data, error } = await fetchRemote(uid);
    if (!error && !data) {
      // 로그인 기능 이전에 저장된 공용 데이터(id 'default')가 있으면 이 계정으로 가져온다
      const claim = await supabase.rpc('claim_default_planner');
      if (!claim.error) ({ data, error } = await fetchRemote(uid));
    }
    if (seq !== hydrateSeq) return; // 그 사이 로그아웃/계정 변경

    if (error) {
      console.warn('Supabase에서 불러오지 못했습니다.', error.message);
      remoteReady = true;
      setSyncStatus('error', error.message);
      return;
    }

    let owner = null;
    try {
      owner = localStorage.getItem(OWNER_KEY);
    } catch (e) {
      /* 무시 */
    }
    const sameOwner = owner === uid;
    const localTs = localStorage.getItem(UPDATED_KEY);
    const remoteTs = data?.updated_at || '';
    const localNewer =
      sameOwner && Boolean(localTs) && (!remoteTs || new Date(localTs).getTime() > new Date(remoteTs).getTime());

    remoteReady = true;
    setOwner(uid);

    if (dirtyDuringLoad || localNewer || !data) {
      if (dirtyDuringLoad || localNewer || hasLocalData(db)) await pushDB();
      else setSyncStatus('saved');
      return;
    }

    applyRemote(data);
    if (!routineDraft && !eventDraft) route(); // 입력 중인 팝업은 유지
    setSyncStatus('saved');
  }

  let db = loadDB();

  /* =========================================================
   * 날짜 유틸
   * ========================================================= */
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (s, n) => {
    const d = parse(s);
    d.setDate(d.getDate() + n);
    return fmt(d);
  };
  const todayStr = () => fmt(new Date());
  const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);

  function relativeLabel(dateStr) {
    const diff = diffDays(dateStr, todayStr());
    return { '-2': '그제', '-1': '어제', 0: '오늘', 1: '내일', 2: '모레' }[diff] ?? '';
  }

  // 해당 날짜가 속한 주(월~일)의 시작일
  function mondayOf(dateStr) {
    const dow = parse(dateStr).getDay();
    return addDays(dateStr, dow === 0 ? -6 : 1 - dow);
  }

  // 월간 현황 아이콘: 달력 틀 + 막대 그래프 (currentColor라 버튼 글자색을 따른다)
  // 수정(연필) · 삭제(휴지통) 아이콘 — currentColor라 버튼 글자색을 따른다
  const EDIT_ICON = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.5 2.5l3 3L6 13H3v-3z" /><path d="M9 4l3 3" />
    </svg>`;
  const DELETE_ICON = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.5 4.5h11" /><path d="M6 4.5V3h4v1.5" />
      <path d="M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6" />
      <path d="M6.75 7v4.5M9.25 7v4.5" />
    </svg>`;

  const SAVE_ICON = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 8.5l3.2 3L13 4.5" />
    </svg>`;
  const CANCEL_ICON = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"
         stroke-linecap="round" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>`;
  // 내일로 미루기 (오른쪽 화살표 + 세로줄)
  const POSTPONE_ICON = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.5 8h8M7.5 4.5L11 8l-3.5 3.5" /><path d="M13.5 3.5v9" />
    </svg>`;

  const STATS_ICON = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M8 3v4M16 3v4M3.5 9.5h17" />
      <path d="M8.5 17.5v-2.5M12 17.5v-4.5M15.5 17.5v-3" stroke-width="2.2" />
    </svg>`;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* =========================================================
   * 화면 상태
   * ========================================================= */
  const ui = {
    weekStart: todayStr(), // 달력 첫 칸 날짜 (기본: 오늘 ~ +6일)
    selected: todayStr(),
    todoAdding: false,
    todoEditingId: null,
    diaryEditing: false,
    calOpen: false, // 메인 달력: 한 달 전체 펼침
    calMonth: null, // 펼친 달력에 보이는 달 'YYYY-MM'
  };

  let routineDraft = null; // 습관 설정 페이지 입력값
  let eventDraft = null; // 일정 추가·수정 팝업 입력값
  let cameFromMain = false;

  const view = document.getElementById('view');
  // 메인의 주간 달력은 header 안(제목 줄 아래)에 그려서 header와 한 덩어리로 고정
  const headerSub = document.getElementById('header-sub');

  /* =========================================================
   * 습관 도메인
   * ========================================================= */
  // 습관 색상 (파스텔): 파랑 · 초록 · 노랑 · 코랄 · 보라 · 민트 · 분홍 · 회색
  const COLORS = ['#a3bdf2', '#a8dcb5', '#f6d58e', '#f4aaa6', '#c9b0ea', '#97d6cf', '#f5b5d2', '#bcc2cc'];
  // 예전(진한) 색으로 저장된 습관은 같은 자리의 파스텔 색으로 보여준다 (다시 저장하면 새 색으로 바뀜)
  const OLD_COLORS = ['#4f6bed', '#22a06b', '#f5a524', '#e5484d', '#8e4ec6', '#12a594', '#e93d82', '#6b7280'];
  const routineColor = (c) => {
    const i = OLD_COLORS.indexOf(String(c || '').toLowerCase());
    return i >= 0 ? COLORS[i] : c || COLORS[0];
  };

  function routineAppliesTo(r, dateStr) {
    if (r.startDate && dateStr < r.startDate) return false;
    if (r.freq.type === 'days') return r.freq.days.includes(parse(dateStr).getDay());
    return true; // daily, weekly
  }

  function isChecked(routineId, dateStr) {
    return (db.routineChecks[dateStr] || []).includes(routineId);
  }

  function weeklyCount(routineId, dateStr) {
    const start = mondayOf(dateStr);
    let n = 0;
    for (let i = 0; i < 7; i++) if (isChecked(routineId, addDays(start, i))) n++;
    return n;
  }

  function freqText(freq) {
    if (freq.type === 'daily') return '매일';
    if (freq.type === 'days') {
      const sorted = [...freq.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      return sorted.map((d) => WEEKDAYS[d]).join('·');
    }
    return `주 ${freq.times}회`;
  }

  /* --- 일기 (기분 이모지 포함) ---
   * 예전 데이터·DB 호환을 위해 기분이 없으면 문자열 그대로, 있으면 { text, mood } 로 저장한다.
   * 읽을 때는 항상 아래 함수를 쓸 것 */
  const MOODS = [
    ['😄', '신남'],
    ['😊', '좋음'],
    ['🙂', '평온'],
    ['😐', '그저 그럼'],
    ['😔', '우울'],
    ['😢', '슬픔'],
    ['😠', '화남'],
    ['😴', '피곤'],
  ];
  const moodLabel = (m) => (MOODS.find(([e]) => e === m) || [])[1] || '';

  function diaryText(dateStr) {
    const v = db.diary[dateStr];
    return typeof v === 'string' ? v : (v && v.text) || '';
  }
  function diaryMood(dateStr) {
    const v = db.diary[dateStr];
    return v && typeof v === 'object' ? v.mood || '' : '';
  }
  function hasDiary(dateStr) {
    return Boolean(diaryText(dateStr).trim() || diaryMood(dateStr));
  }
  function setDiary(dateStr, text, mood) {
    if (!text.trim() && !mood) delete db.diary[dateStr];
    else db.diary[dateStr] = mood ? { text, mood } : text;
  }

  function hasData(dateStr) {
    return (
      (db.todos[dateStr] || []).length > 0 ||
      hasDiary(dateStr) ||
      (db.routineChecks[dateStr] || []).length > 0 ||
      eventsOn(dateStr).length > 0
    );
  }

  /* =========================================================
   * 메인 페이지 렌더링
   * ========================================================= */
  function renderCalendar() {
    const days = [];
    for (let i = 0; i < 7; i++) days.push(addDays(ui.weekStart, i));

    const first = parse(days[0]);
    const last = parse(days[6]);
    const month =
      first.getMonth() === last.getMonth()
        ? `${first.getFullYear()}년 ${first.getMonth() + 1}월`
        : `${first.getFullYear()}년 ${first.getMonth() + 1}월 – ${last.getMonth() + 1}월`;

    const today = todayStr();
    const showTodayBtn = !days.includes(today) || ui.selected !== today;

    // ▼ 를 누르면 주간 줄 대신 한 달 전체 달력 (날짜를 고르면 다시 접힘)
    const calMonth = ui.calMonth || ui.selected.slice(0, 7);
    const [cy, cm] = calMonth.split('-').map(Number);

    return `
      <section class="calendar ${ui.calOpen ? 'open' : ''}">
        <div class="calendar-top">
          <button type="button" class="calendar-month cal-toggle" data-action="cal-toggle"
                  aria-expanded="${ui.calOpen}" aria-label="${ui.calOpen ? '달력 접기' : '달력 전체 보기'}">
            ${ui.calOpen ? `${cy}년 ${cm}월` : month}
            <span class="cal-caret" aria-hidden="true"><svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.2 4.2h7.6a.6.6 0 0 1 .47.97L6.47 9.6a.6.6 0 0 1-.94 0L1.73 5.17a.6.6 0 0 1 .47-.97z" fill="currentColor" /></svg></span>
          </button>
          <div class="calendar-tools">
            ${showTodayBtn ? '<button class="today-btn" data-action="go-today">오늘</button>' : ''}
            <button class="today-btn stats-btn" data-action="open-stats" aria-label="월간 현황" title="월간 현황">${STATS_ICON}</button>
          </div>
        </div>
        ${ui.calOpen ? renderMonthPicker(calMonth) : `<div class="calendar-row">
          <button class="nav-btn" data-action="prev-week" aria-label="이전 주">&lsaquo;</button>
          <div class="days">
            ${days
              .map((d) => {
                const dt = parse(d);
                const dow = dt.getDay();
                const cls = [
                  'day',
                  d === ui.selected ? 'active' : '',
                  dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
                  hasData(d) ? 'has-data' : '',
                ].join(' ');
                return `
                  <button class="${cls}" data-action="select-day" data-date="${d}">
                    <span class="wd">${WEEKDAYS[dow]}</span>
                    <span class="dn">${dt.getDate()}</span>
                    <span class="lbl">${relativeLabel(d)}</span>
                    <span class="dot"></span>
                  </button>`;
              })
              .join('')}
          </div>
          <button class="nav-btn" data-action="next-week" aria-label="다음 주">&rsaquo;</button>
        </div>`}
      </section>`;
  }

  /** 메인 달력을 펼쳤을 때의 한 달 전체 (기록 있는 날 점, 선택일 금색, 오늘 테두리) */
  function renderMonthPicker(ym) {
    const days = monthDays(ym);
    const lead = parse(days[0]).getDay();
    const today = todayStr();
    return `
      <div class="cal-month">
        <div class="cal-month-nav">
          <button class="nav-btn sm" data-action="cal-month" data-delta="-1" aria-label="이전 달">&lsaquo;</button>
          <button class="nav-btn sm" data-action="cal-month" data-delta="1" aria-label="다음 달">&rsaquo;</button>
        </div>
        <div class="dp-grid">
          ${WEEKDAYS.map((w, i) => `<span class="dp-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}
          ${'<span></span>'.repeat(lead)}
          ${days
            .map((d) => {
              const dow = parse(d).getDay();
              const cls = [
                'dp-day', 'cal-day',
                d === ui.selected ? 'on' : '',
                d === today ? 'today' : '',
                dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
                hasData(d) ? 'has-data' : '',
              ].join(' ');
              return `<button type="button" class="${cls}" data-action="cal-pick" data-date="${d}" aria-label="${dayLabel(d)}">
                        ${Number(d.slice(8))}<i class="dot"></i></button>`;
            })
            .join('')}
        </div>
      </div>`;
  }

  function renderRoutines() {
    const d = ui.selected;
    const list = db.routines.filter((r) => routineAppliesTo(r, d));
    const doneCount = list.filter((r) => isChecked(r.id, d)).length;

    const items = list
      .map((r) => {
        const checked = isChecked(r.id, d);
        let meta = freqText(r.freq);
        if (r.freq.type === 'weekly') meta += ` · 이번 주 ${weeklyCount(r.id, d)}/${r.freq.times}회`;
        return `
          <li class="item routine-item ${checked ? 'done' : ''}">
            <span class="routine-bar" style="background:${esc(routineColor(r.color))}"></span>
            <input type="checkbox" data-action="toggle-routine" data-id="${r.id}" ${checked ? 'checked' : ''} aria-label="${esc(r.name)} 완료" />
            ${r.emoji ? `<span class="routine-emoji">${esc(r.emoji)}</span>` : ''}
            <div class="text">
              <span class="routine-name">${esc(r.name)}</span>
              <span class="routine-meta">${esc(meta)}</span>
            </div>
          </li>`;
      })
      .join('');

    return `
      <section class="section">
        <div class="section-head">
          <h2>습관${list.length ? `<span class="count">${doneCount}/${list.length}</span>` : ''}</h2>
          <button class="add-btn" data-action="new-routine" aria-label="습관 추가">+</button>
        </div>
        ${list.length ? `<ul class="list">${items}</ul>` : '<p class="empty">이 날짜에 해당하는 습관이 없어요.</p>'}
      </section>`;
  }

  /**
   * 할 일 입력 줄 (추가 · 수정 공용). 저장된 줄(.todo-item)과 같은 배치:
   * [체크박스 자리] [입력칸 — 글자 크기·줄 높이 동일] [저장 아이콘] [취소 아이콘]
   */
  function todoInputRow({ form, id = '', value = '', done = false }) {
    const isAdd = form === 'todo-add';
    return `
      <li class="item todo-item todo-editing">
        <form class="todo-inline" data-form="${form}" ${id ? `data-id="${id}"` : ''}>
          <span class="todo-check-slot ${done ? 'done' : ''}" aria-hidden="true"></span>
          <input class="todo-input" name="text" value="${esc(value)}" maxlength="200" autocomplete="off"
                 placeholder="할 일을 입력해주세요" aria-label="${isAdd ? '새 할 일' : '할 일 수정'}" />
          <button class="btn sm icon primary" type="submit" aria-label="저장" title="저장 (Enter)">${SAVE_ICON}</button>
          <button class="btn sm icon" type="button" data-action="${isAdd ? 'cancel-todo-add' : 'cancel-todo-edit'}"
                  aria-label="취소" title="취소 (Esc)">${CANCEL_ICON}</button>
        </form>
      </li>`;
  }

  function renderTodos() {
    const d = ui.selected;
    const todos = db.todos[d] || [];
    const doneCount = todos.filter((t) => t.done).length;

    // 편집 모드(+ 버튼으로 켜고 끔)에서만 수정·삭제 버튼과 추가 입력 줄을 보여준다
    const editMode = ui.todoAdding;

    const items = todos
      .map((t) => {
        if (editMode && ui.todoEditingId === t.id) return todoInputRow({ form: 'todo-edit', id: t.id, value: t.text, done: t.done });
        return `
          <li class="item todo-item ${t.done ? 'done' : ''}">
            <input type="checkbox" data-action="toggle-todo" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="완료" />
            <span class="text">${esc(t.text)}</span>
            ${editMode ? `${t.done ? '' : `
            <button class="btn sm icon" data-action="postpone-todo" data-id="${t.id}" aria-label="내일로 미루기" title="내일로 미루기">${POSTPONE_ICON}</button>`}
            <button class="btn sm icon" data-action="edit-todo" data-id="${t.id}" aria-label="수정" title="수정">${EDIT_ICON}</button>
            <button class="btn sm icon danger" data-action="delete-todo" data-id="${t.id}" aria-label="삭제" title="삭제">${DELETE_ICON}</button>` : ''}
          </li>`;
      })
      .join('');

    // 추가 입력 줄은 목록 맨 아래에 (다른 줄을 수정 중일 때는 숨김)
    const addRow = editMode && !ui.todoEditingId ? todoInputRow({ form: 'todo-add' }) : '';

    return `
      <section class="section">
        <div class="section-head">
          <h2>할 일${todos.length ? `<span class="count">${doneCount}/${todos.length}</span>` : ''}</h2>
          <button class="add-btn ${editMode ? 'on' : ''}" data-action="add-todo"
                  aria-label="${editMode ? '편집 닫기' : '할 일 편집'}" title="${editMode ? '편집 닫기' : '할 일 추가·수정·삭제'}">+</button>
        </div>
        ${todos.length || addRow ? `<ul class="list">${items}${addRow}</ul>` : '<p class="empty">등록된 할 일이 없어요.</p>'}
      </section>`;
  }

  function renderDiary() {
    const d = ui.selected;
    const text = diaryText(d);
    const mood = diaryMood(d);

    let body;
    if (ui.diaryEditing) {
      body = `
        <form class="diary-form" data-form="diary">
          <div class="mood-pick" role="radiogroup" aria-label="오늘의 기분">
            <span class="mood-pick-label">오늘의 기분</span>
            <div class="mood-options">
              ${MOODS.map(
                ([e, label]) => `<button type="button" class="mood-opt ${mood === e ? 'on' : ''}" data-action="pick-mood"
                                   data-mood="${e}" role="radio" aria-checked="${mood === e}" title="${label}">${e}</button>`
              ).join('')}
            </div>
            <input type="hidden" name="mood" value="${mood}" />
          </div>
          <textarea class="field diary-input" name="text" data-autogrow placeholder="오늘 하루는 어땠나요?">${esc(text)}</textarea>
          <div class="diary-actions">
            <button class="btn sm icon primary" type="submit" aria-label="저장" title="저장">${SAVE_ICON}</button>
            <button class="btn sm icon" type="button" data-action="cancel-diary" aria-label="취소" title="취소 (Esc)">${CANCEL_ICON}</button>
          </div>
        </form>`;
    } else if (text.trim() || mood) {
      body = `
        <div class="diary-view">
          ${mood ? `<div class="diary-mood"><span class="diary-mood-label">오늘의 기분</span><span class="diary-mood-emoji" title="${esc(moodLabel(mood))}">${mood}</span></div>` : ''}
          ${text.trim() ? `<p class="diary-text">${esc(text)}</p>` : ''}
        </div>`;
    } else {
      body = '<p class="empty">작성된 일기가 없어요.</p>';
    }

    // 일기는 하루 1개: 작성 전에는 +, 작성 후에는 연필 아이콘으로 같은 자리에서 작성·수정
    const written = hasDiary(d);
    const headBtn = ui.diaryEditing
      ? ''
      : written
        ? `<button class="add-btn icon" data-action="edit-diary" aria-label="일기 수정" title="일기 수정">${EDIT_ICON}</button>`
        : '<button class="add-btn" data-action="edit-diary" aria-label="일기 작성" title="일기 작성">+</button>';

    return `
      <section class="section">
        <div class="section-head">
          <h2>일기</h2>
          ${headBtn}
        </div>
        ${body}
      </section>`;
  }

  function renderMain() {
    if (headerSub) headerSub.innerHTML = `<div class="app-header__sub">${renderCalendar()}</div>`;
    view.innerHTML = (headerSub ? '' : renderCalendar()) + renderEvents() + renderRoutines() + renderTodos() + renderDiary();
  }

  function resetEditing() {
    ui.todoAdding = false;
    ui.todoEditingId = null;
    ui.diaryEditing = false;
  }

  function focusField(selector) {
    const el = view.querySelector(selector);
    if (el) {
      el.focus();
      if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  /* =========================================================
   * 습관 설정 페이지 렌더링
   * ========================================================= */
  /**
   * 습관 관리 페이지 진입.
   *  - id 있음: 습관 수정 팝업 (#/routine/edit/:id)
   *  - id 없음 + modal: 습관 추가 팝업 (#/routine/new)
   *  - id 없음 + !modal: 목록만 (#/routines)
   */
  function openRoutineForm(id, { modal = true } = {}) {
    const existing = id ? db.routines.find((r) => r.id === id) : null;
    if (id && !existing) {
      location.replace('#/routines');
      return;
    }
    routineDraft = existing
      ? JSON.parse(JSON.stringify(existing))
      : {
          id: null,
          emoji: '',
          name: '',
          color: COLORS[0],
          freq: { type: 'daily', days: [], times: 3 },
          memo: '',
        };
    routineDraft.color = routineColor(routineDraft.color);
    routineDraft.error = '';
    routineDraft.pickerOpen = false;
    routineDraft.modal = existing ? true : modal;
    routineDraft.modalEnter = routineDraft.modal; // 처음 열 때만 팝업 애니메이션
    renderRoutineForm();
    if (routineDraft.modal) focusField('#routine-name');
  }

  // 순서 변경 손잡이 (점 6개) — 글꼴에 따라 모양이 달라지지 않게 SVG로 그린다
  const GRIP_ICON = `
    <svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" />
      <circle cx="2.5" cy="8" r="1.4" /><circle cx="7.5" cy="8" r="1.4" />
      <circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" />
    </svg>`;

  const EMOJI_GROUPS = [
    { label: '자주 쓰는', list: ['💧', '📚', '🏃', '🧘', '💪', '🥗', '😴', '☀️', '📝', '💊', '🦷', '🧹'] },
    { label: '표정', list: ['😀', '😊', '😍', '🥰', '😎', '🤓', '😌', '🙂', '😇', '🤗', '🥳', '😤', '😴', '🤒', '😭', '🔥'] },
    { label: '활동', list: ['🏃', '🚶', '🚴', '🏊', '🏋️', '🧘', '⚽', '🏀', '🎾', '⛳', '🧗', '🤸', '🎯', '🎮', '🎨', '🎸'] },
    { label: '음식', list: ['💧', '☕', '🍵', '🥛', '🍎', '🍌', '🥗', '🥦', '🥕', '🍳', '🍚', '🍞', '🥤', '🍫', '🍪', '🍽️'] },
    { label: '생활', list: ['📚', '📖', '✏️', '📝', '💻', '📱', '💰', '🧹', '🧺', '🛁', '🪥', '💊', '🛏️', '⏰', '📅', '🌱'] },
    { label: '자연', list: ['☀️', '🌙', '⭐', '🌈', '☁️', '🌧️', '❄️', '🌸', '🌻', '🍀', '🌳', '🐶', '🐱', '🐰', '🐻', '🦋'] },
    { label: '기호', list: ['❤️', '🧡', '💛', '💚', '💙', '💜', '✅', '✨', '💯', '⚡', '🎉', '🏆', '🔔', '📌', '💡', '🙏'] },
  ];

  function renderEmojiPicker(r) {
    return `
      <div class="emoji-picker" role="dialog" aria-label="이모지 선택">
        <div class="emoji-picker-head">
          <span>이모지 선택</span>
          ${r.emoji ? '<button type="button" class="btn" data-action="pick-emoji" data-emoji="">없음</button>' : ''}
        </div>
        <div class="emoji-picker-body">
          ${EMOJI_GROUPS.map(
            (g) => `
              <div class="emoji-group-label">${g.label}</div>
              <div class="emoji-grid">
                ${g.list
                  .map(
                    (em) => `<button type="button" class="emoji-cell ${r.emoji === em ? 'on' : ''}"
                               data-action="pick-emoji" data-emoji="${em}">${em}</button>`
                  )
                  .join('')}
              </div>`
          ).join('')}
        </div>
      </div>`;
  }

  // 습관 설정 페이지 상단: 전체 습관 목록 (드래그로 순서 변경)
  function renderRoutineSortList(currentId) {
    if (!db.routines.length) {
      return `
      <section class="section">
        <div class="section-head">
          <h2>내 습관 목록<span class="count">0</span></h2>
        </div>
        <p class="empty">등록된 습관이 없어요.</p>
      </section>`;
    }
    return `
      <section class="section">
        <div class="section-head">
          <h2>내 습관 목록<span class="count">${db.routines.length}</span></h2>
          <span class="hint sort-hint" style="margin:0">${GRIP_ICON}를 끌어서 순서 변경</span>
        </div>
        <ul class="list sort-list">
          ${db.routines
            .map(
              (rt) => `
              <li class="item sort-item ${rt.id === currentId ? 'current' : ''}" data-id="${rt.id}">
                <span class="drag-handle" aria-label="순서 변경">${GRIP_ICON}</span>
                <span class="routine-bar" style="background:${esc(routineColor(rt.color))}"></span>
                <button type="button" class="sort-body" data-action="open-routine" data-id="${rt.id}">
                  ${rt.emoji ? `<span class="routine-emoji">${esc(rt.emoji)}</span>` : ''}
                  <span class="sort-name">${esc(rt.name)}</span>
                  ${rt.id === currentId ? '<span class="badge">수정 중</span>' : ''}
                  <span class="routine-meta">${esc(freqText(rt.freq))}</span>
                </button>
              </li>`
            )
            .join('')}
        </ul>
      </section>`;
  }

  /* --- 드래그 정렬 (마우스·터치 공통, pointer 이벤트) --- */
  let drag = null;

  view.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    e.preventDefault();
    const item = handle.closest('.sort-item');
    drag = { item, list: item.parentElement };
    item.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });

  view.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const siblings = [...drag.list.children].filter((li) => li !== drag.item);
    const after = siblings.find((li) => {
      const box = li.getBoundingClientRect();
      return e.clientY < box.top + box.height / 2;
    });
    if (after) {
      if (drag.item.nextElementSibling !== after) drag.list.insertBefore(drag.item, after);
    } else if (drag.list.lastElementChild !== drag.item) {
      drag.list.appendChild(drag.item);
    }
  });

  function endDrag() {
    if (!drag) return;
    drag.item.classList.remove('dragging');
    const order = [...drag.list.children].map((li) => li.dataset.id);
    drag = null;
    const before = db.routines.map((r) => r.id).join();
    if (order.join() === before) return;
    db.routines.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    saveDB();
  }

  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);

  function renderRoutineForm() {
    const r = routineDraft;
    const isEdit = !!r.id;
    const weekOrder = [1, 2, 3, 4, 5, 6, 0];

    // 습관 관리 페이지에서는 header의 CheckLog 제목 자리에 뒤로가기 + 페이지 제목을 둔다
    setHeaderTitle(`
      <div class="page-title">
        <button class="back-btn" data-action="routine-cancel" aria-label="뒤로가기">&lsaquo;</button>
        <h2>습관 관리</h2>
      </div>`);

    const form = `
      <form class="routine-modal-form" data-form="routine" novalidate>
        <div class="section-head">
          <h2 id="routine-form-title">${isEdit ? '습관 수정' : '습관 추가'}</h2>
        </div>
        <div class="form-group">
          <label for="routine-name">습관명 <span class="req">*</span></label>
          <div class="name-row">
            <div class="emoji-wrap">
              <button type="button" class="emoji-btn ${r.emoji ? '' : 'empty'}" data-action="toggle-emoji-picker"
                      aria-label="이모지 선택" aria-expanded="${r.pickerOpen ? 'true' : 'false'}">${r.emoji ? esc(r.emoji) : '☺'}</button>
              ${r.pickerOpen ? renderEmojiPicker(r) : ''}
            </div>
            <input id="routine-name" class="field" name="name" value="${esc(r.name)}" maxlength="50"
                   placeholder="습관명을 입력해주세요" autocomplete="off" />
          </div>
          ${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}
        </div>

        <div class="form-group">
          <span class="label">색상</span>
          <div class="palette">
            ${COLORS.map(
              (c) => `<button type="button" class="swatch ${r.color === c ? 'selected' : ''}" style="background:${c}"
                         data-action="pick-color" data-color="${c}" aria-label="색상 ${c}"></button>`
            ).join('')}
          </div>
        </div>

        <div class="form-group">
          <span class="label">빈도</span>
          <div class="segmented">
            <button type="button" class="${r.freq.type === 'daily' ? 'on' : ''}" data-action="freq-type" data-type="daily">매일</button>
            <button type="button" class="${r.freq.type === 'days' ? 'on' : ''}" data-action="freq-type" data-type="days">요일 선택</button>
            <button type="button" class="${r.freq.type === 'weekly' ? 'on' : ''}" data-action="freq-type" data-type="weekly">주 N회</button>
          </div>
          ${
            r.freq.type === 'days'
              ? `<div class="weekday-pick">
                   ${weekOrder
                     .map(
                       (d) => `<button type="button" class="${r.freq.days.includes(d) ? 'on' : ''}"
                                  data-action="toggle-weekday" data-day="${d}">${WEEKDAYS[d]}</button>`
                     )
                     .join('')}
                 </div>
                 <p class="hint">선택한 요일에만 습관이 표시됩니다.</p>`
              : ''
          }
          ${
            r.freq.type === 'weekly'
              ? `<div class="times-pick">
                   <button type="button" class="btn" data-action="times" data-delta="-1" aria-label="줄이기">−</button>
                   <strong>주 ${r.freq.times}회</strong>
                   <button type="button" class="btn" data-action="times" data-delta="1" aria-label="늘리기">+</button>
                 </div>
                 <p class="hint">매일 표시되며, 이번 주 달성 횟수를 함께 보여줍니다.</p>`
              : ''
          }
        </div>

        <div class="form-group">
          <label for="routine-memo">메모</label>
          <textarea id="routine-memo" class="field" name="memo" placeholder="메모를 입력해주세요">${esc(r.memo)}</textarea>
        </div>

        <div class="form-actions">
          ${isEdit ? '<button type="button" class="btn lg danger" data-action="routine-delete">삭제</button><span class="spacer"></span>' : ''}
          <button type="button" class="btn lg" data-action="routine-close">취소</button>
          <button type="submit" class="btn lg primary">저장</button>
        </div>
      </form>`;

    // 팝업이 이미 떠 있으면 팝업 안의 폼만 다시 그린다.
    // (전체를 다시 그리면 배경 블러·팝업이 새로 만들어지면서 빈도 버튼 등을 누를 때마다 깜빡이고,
    //  팝업 안 스크롤 위치도 맨 위로 돌아간다)
    const openModal = view.querySelector('.routine-modal');
    if (r.modal && !r.modalEnter && openModal) {
      const scrollTop = openModal.scrollTop;
      const activeName = document.activeElement?.name;
      openModal.innerHTML = form;
      openModal.scrollTop = scrollTop;
      if (activeName) openModal.querySelector(`[name="${activeName}"]`)?.focus();
      return;
    }

    const modal = r.modal
      ? `
      <div class="modal-backdrop routine-modal-backdrop ${r.modalEnter ? 'enter' : ''}">
        <div class="modal routine-modal" role="dialog" aria-modal="true" aria-labelledby="routine-form-title">
          ${form}
        </div>
      </div>`
      : '';
    r.modalEnter = false;
    document.body.classList.toggle('modal-open', !!r.modal);

    view.innerHTML = `
      ${renderRoutineSortList(r.id)}
      ${modal}`;
  }

  /** 습관 추가·수정 팝업을 닫고 목록만 있는 습관 관리 화면으로 */
  function closeRoutineEditor() {
    location.replace('#/routines');
  }

  function leaveRoutineForm() {
    routineDraft = null;
    if (cameFromMain) history.back();
    else location.hash = '#/';
  }

  /* =========================================================
   * 일정 (#/events, #/event/new, #/event/edit/:id)
   * 일정: { id, title, start, end, startTime, endTime, place, repeat, lunar, color, memo }
   *  - start/end: 'YYYY-MM-DD' (기간), startTime/endTime 'HH:MM' (선택, 비우면 날짜만)
   *  - repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' (시작일 기준으로 반복, 기간 길이 유지)
   * ========================================================= */
  const REPEATS = [
    ['none', '안 함'],
    ['daily', '매일'],
    ['weekly', '매주'],
    ['monthly', '매월'],
    ['yearly', '매년'],
  ];

  /** 반복 규칙상 b 날짜에 일정이 "시작"하는지 */
  /* --- 음력 (한국천문연구원 기준 korean-lunar-calendar, 1000~2050년) ---
   * 일정의 start/end 는 항상 양력으로 저장하고, lunar: true 면
   *  - 입력할 때 음력 달력으로 고르고(양력으로 바꿔 저장)
   *  - 매월/매년 반복을 음력 날짜 기준으로 계산한다 (예: 음력 생일) */
  const lunarCal = new KoreanLunarCalendar();
  const lunarCache = new Map();

  /** 양력 'YYYY-MM-DD' → { y, m, d, leap } (범위 밖이면 null) */
  function toLunar(d) {
    if (lunarCache.has(d)) return lunarCache.get(d);
    const [y, m, dd] = d.split('-').map(Number);
    let out = null;
    if (lunarCal.setSolarDate(y, m, dd)) {
      const L = lunarCal.getLunarCalendar();
      out = { y: L.year, m: L.month, d: L.day, leap: !!L.intercalation };
    }
    lunarCache.set(d, out);
    return out;
  }

  /** 음력 → 양력 'YYYY-MM-DD' (없는 날짜면 null — 30일이 없는 달, 윤달이 없는 해 등) */
  function fromLunar(y, m, d, leap = false) {
    if (!lunarCal.setLunarDate(y, m, d, leap)) return null;
    const S = lunarCal.getSolarCalendar();
    const out = `${S.year}-${pad(S.month)}-${pad(S.day)}`;
    const back = toLunar(out); // 라이브러리가 없는 날짜도 넘겨줄 때가 있어 되돌려서 확인
    return back && back.m === m && back.d === d && back.leap === leap ? out : null;
  }
  const lunarMonthLength = (y, m, leap) => (fromLunar(y, m, 30, leap) ? 30 : 29);
  const hasLeapMonth = (y, m) => Boolean(fromLunar(y, m, 1, true));

  /** 음력 달 이동 (윤달 포함 순서: … 6월 → 윤6월 → 7월 …) */
  function shiftLunarMonth({ y, m, leap }, delta) {
    if (delta > 0) {
      if (!leap && hasLeapMonth(y, m)) return { y, m, leap: true };
      return m === 12 ? { y: y + 1, m: 1, leap: false } : { y, m: m + 1, leap: false };
    }
    if (leap) return { y, m, leap: false };
    const p = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
    return { ...p, leap: hasLeapMonth(p.y, p.m) };
  }

  function eventStartsOn(ev, b) {
    if (b < ev.start) return false;
    if (b === ev.start) return true;
    // 음력 일정의 매월·매년 반복: 음력 날짜가 같은 날
    if (ev.lunar && (ev.repeat === 'monthly' || ev.repeat === 'yearly')) {
      const L = toLunar(b);
      const S = toLunar(ev.start);
      if (!L || !S || L.d !== S.d) return false;
      if (ev.repeat === 'monthly') return true;
      // 매년: 같은 음력 월·일 (윤달에 시작한 일정도 해마다는 평달 기준으로)
      return L.m === S.m && !L.leap;
    }
    const s = parse(ev.start);
    const t = parse(b);
    switch (ev.repeat) {
      case 'daily':
        return true;
      case 'weekly':
        return t.getDay() === s.getDay();
      case 'monthly':
        return t.getDate() === s.getDate();
      case 'yearly':
        return t.getMonth() === s.getMonth() && t.getDate() === s.getDate();
      default:
        return false;
    }
  }

  /** d 날짜에 걸치는 회차의 시작일 (없으면 null). 기간이 여러 날이면 그 안의 날짜도 포함 */
  function eventOccurrenceOn(ev, d) {
    if (d < ev.start) return null;
    const dur = Math.max(0, diffDays(ev.end || ev.start, ev.start));
    if (!ev.repeat || ev.repeat === 'none') return d <= (ev.end || ev.start) ? ev.start : null;
    for (let k = 0; k <= Math.min(dur, 366); k++) {
      const b = addDays(d, -k);
      if (eventStartsOn(ev, b)) return b;
    }
    return null;
  }

  /** d 날짜의 일정 목록 [{ ev, base }] — 시간 없는 일정 먼저, 그다음 시작 시각 순 */
  function eventsOn(d) {
    return (db.events || [])
      .map((ev) => ({ ev, base: eventOccurrenceOn(ev, d) }))
      .filter((x) => x.base)
      .sort(
        (a, b) =>
          evStartTime(a.ev).localeCompare(evStartTime(b.ev)) ||
          a.ev.title.localeCompare(b.ev.title)
      );
  }

  /** 기간 문구 (회차 시작일 base 기준) */
  // 시간은 선택 입력: 비어 있으면 날짜만 (예전 데이터의 allDay: true 도 시간 없음으로 취급)
  const evStartTime = (ev) => (ev.allDay ? '' : ev.startTime || '');
  const evEndTime = (ev) => (ev.allDay ? '' : ev.endTime || '');

  /** 기간 문구 (회차 시작일 base 기준) — 날짜와 시간만, 반복·하루 종일 문구는 넣지 않음 */
  function eventPeriodText(ev, base = ev.start) {
    const dur = Math.max(0, diffDays(ev.end || ev.start, ev.start));
    const s = base;
    const e = addDays(base, dur);
    const st = evStartTime(ev);
    const et = evEndTime(ev);
    const join = (...parts) => parts.filter(Boolean).join(' ');
    if (s === e) {
      // 같은 날: 11월 25일 (화) 14:00 – 15:00
      return join(dayLabel(s), st && et ? `${st} – ${et}` : st || (et ? `~ ${et}` : ''));
    }
    // 여러 날: 11월 24일 (화) 14:00 – 11월 26일 (목) 18:00
    return `${join(dayLabel(s), st)} – ${join(dayLabel(e), et)}`;
  }

  /** 일정 카드: 선택한 색상 배경 + 왼쪽 색 띠, 일정명 / 기간(작게·회색) */
  // action 이 없으면 누를 수 없는 카드(div) — 메인 목록용
  function eventCard({ ev, base }, action = '') {
    const inner = `
          <span class="event-title">${esc(ev.title)}</span>
          <span class="event-period">${esc(eventPeriodText(ev, base))}</span>`;
    const attrs = `class="event-card" style="--ec:${esc(ev.color || COLORS[0])}" ${ev.memo ? `title="${esc(ev.memo)}"` : ''}`;
    return action
      ? `<li><button type="button" ${attrs} data-action="${action}" data-id="${ev.id}">${inner}</button></li>`
      : `<li><div ${attrs}>${inner}</div></li>`;
  }

  // 메인: 선택한 날짜의 일정
  function renderEvents() {
    const list = eventsOn(ui.selected);
    return `
      <section class="section">
        <div class="section-head">
          <h2>일정${list.length ? `<span class="count">${list.length}</span>` : ''}</h2>
          <button class="add-btn" data-action="open-events" aria-label="일정 관리">+</button>
        </div>
        ${
          list.length
            ? `<ul class="event-list">${list.map((x) => eventCard(x)).join('')}</ul>`
            : '<p class="empty">이 날짜에 일정이 없어요.</p>'
        }
      </section>`;
  }

  let eventPage = null; // { month: 'YYYY-MM', selected: 'YYYY-MM-DD' }
  // eventDraft 는 위쪽(routineDraft 옆)에 선언

  function ensureEventPage() {
    eventPage ||= { month: ui.selected.slice(0, 7), selected: ui.selected };
  }

  /**
   * 일정 관리 페이지 진입.
   *  - id 있음: 일정 수정 팝업 (#/event/edit/:id)
   *  - id 없음 + modal: 일정 추가 팝업 (#/event/new)
   *  - id 없음 + !modal: 달력 + 목록만 (#/events)
   */
  function openEventForm(id, { modal = true } = {}) {
    ensureEventPage();
    const existing = id ? (db.events || []).find((x) => x.id === id) : null;
    if (id && !existing) {
      location.replace('#/events');
      return;
    }
    if (!existing && !modal) {
      eventDraft = null;
    } else {
      eventDraft = existing
        ? (() => {
            const st = evStartTime(existing);
            const et = evEndTime(existing);
            // 시간이 하나도 없으면 하루 종일로 연다
            return { ...JSON.parse(JSON.stringify(existing)), allDay: !st && !et, startTime: st || '09:00', endTime: et || '10:00' };
          })()
        : {
            id: null,
            title: '',
            start: eventPage.selected,
            end: eventPage.selected,
            allDay: false,
            startTime: '09:00',
            endTime: '10:00',
            place: '',
            repeat: 'none',
            color: COLORS[0],
            memo: '',
          };
      eventDraft.error = '';
      eventDraft.picker = null;
      eventDraft.modalEnter = true;
    }
    renderEventPage();
    if (eventDraft) focusField('#event-title');
  }

  /* --- 기간 선택기: 브라우저 기본 달력·시간창 대신 앱 스타일 팝업 ---
   * eventDraft.picker = { field: 'start' | 'end' | 'startTime' | 'endTime', month: 'YYYY-MM' } | null */
  const CAL_ICON = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </svg>`;
  const CLOCK_ICON = `
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" /><path d="M8 5v3.25l2 1.25" />
    </svg>`;
  const MINUTE_STEPS = Array.from({ length: 12 }, (_, i) => i * 5);

  function pickDateText(d) {
    if (!d) return '날짜 선택';
    const dt = parse(d);
    return `${dt.getFullYear()}. ${dt.getMonth() + 1}. ${dt.getDate()} (${WEEKDAYS[dt.getDay()]})`;
  }
  const hourText = (h) => `${h < 12 ? '오전' : '오후'} ${((h + 11) % 12) + 1}`;
  function pickTimeText(t) {
    if (!t) return '시간 선택';
    const [h, m] = t.split(':').map(Number);
    return `${hourText(h)}:${pad(m)}`;
  }

  function periodField(field) {
    const r = eventDraft;
    const isTime = field.endsWith('Time');
    const open = r.picker?.field === field;
    const label = { start: '시작일', end: '종료일', startTime: '시작 시각', endTime: '종료 시각' }[field];
    return `
      <div class="picker-wrap ${isTime ? 'time' : 'date'}">
        <button type="button" class="field picker-btn ${open ? 'open' : ''}" data-action="ev-picker" data-field="${field}"
                aria-label="${label}" aria-expanded="${open}" ${isTime && r.allDay ? 'disabled' : ''}>
          <span>${isTime ? pickTimeText(r[field]) : r.lunar ? lunarDateText(r[field]) : pickDateText(r[field])}</span>${isTime ? CLOCK_ICON : CAL_ICON}
        </button>
        ${open ? (isTime ? renderTimePop(field) : renderDatePop(field)) : ''}
      </div>`;
  }

  /** 음력 날짜 문구: '음 10. 17' (윤달이면 '음 윤6. 3') */
  function lunarDateText(d) {
    const L = d && toLunar(d);
    return L ? `음 ${L.leap ? '윤' : ''}${L.m}. ${L.d}` : '날짜 선택';
  }

  /** 음력 달력: 음력 날짜(크게) + 그날의 양력 날짜(작게). 고르면 양력으로 저장 */
  function renderLunarPop(field) {
    const r = eventDraft;
    const { y, m, leap } = r.picker.lunar;
    const len = lunarMonthLength(y, m, leap);
    const today = todayStr();
    const min = field === 'end' ? r.start : '';
    const first = fromLunar(y, m, 1, leap);
    const lead = first ? parse(first).getDay() : 0;
    const cells = Array.from({ length: len }, (_, i) => {
      const d = fromLunar(y, m, i + 1, leap);
      if (!d) return '<span></span>';
      const dt = parse(d);
      const dow = dt.getDay();
      const cls = ['dp-day', 'lunar', d === r[field] ? 'on' : '', d === today ? 'today' : '', dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''].join(' ');
      return `<button type="button" class="${cls}" data-action="ev-pick-date" data-date="${d}" ${min && d < min ? 'disabled' : ''}
                title="양력 ${dt.getMonth() + 1}월 ${dt.getDate()}일"><b>${i + 1}</b><small>${dt.getMonth() + 1}/${dt.getDate()}</small></button>`;
    }).join('');
    return `
      <div class="picker-pop dp" role="dialog" aria-label="음력 날짜 선택">
        <div class="dp-head">
          <button type="button" class="dp-nav" data-action="ev-pick-month" data-delta="-1" aria-label="이전 달">&lsaquo;</button>
          <strong>${y}년 ${leap ? '윤' : ''}${m}월 <span class="dp-badge">음력</span></strong>
          <button type="button" class="dp-nav" data-action="ev-pick-month" data-delta="1" aria-label="다음 달">&rsaquo;</button>
        </div>
        <div class="dp-grid">
          ${WEEKDAYS.map((w, i) => `<span class="dp-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}
          ${'<span></span>'.repeat(lead)}${cells}
        </div>
        <div class="dp-foot">
          <button type="button" class="dp-today" data-action="ev-pick-date" data-date="${today}" ${min && today < min ? 'disabled' : ''}>오늘</button>
        </div>
      </div>`;
  }

  function renderDatePop(field) {
    const r = eventDraft;
    if (r.lunar) return renderLunarPop(field);
    const ym = r.picker.month;
    const [y, m] = ym.split('-').map(Number);
    const days = monthDays(ym);
    const today = todayStr();
    const lead = parse(days[0]).getDay();
    const min = field === 'end' ? r.start : '';
    return `
      <div class="picker-pop dp" role="dialog" aria-label="날짜 선택">
        <div class="dp-head">
          <button type="button" class="dp-nav" data-action="ev-pick-month" data-delta="-1" aria-label="이전 달">&lsaquo;</button>
          <strong>${y}년 ${m}월</strong>
          <button type="button" class="dp-nav" data-action="ev-pick-month" data-delta="1" aria-label="다음 달">&rsaquo;</button>
        </div>
        <div class="dp-grid">
          ${WEEKDAYS.map((w, i) => `<span class="dp-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</span>`).join('')}
          ${'<span></span>'.repeat(lead)}
          ${days
            .map((d) => {
              const dow = parse(d).getDay();
              const cls = ['dp-day', d === r[field] ? 'on' : '', d === today ? 'today' : '', dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''].join(' ');
              return `<button type="button" class="${cls}" data-action="ev-pick-date" data-date="${d}" ${min && d < min ? 'disabled' : ''}>${Number(d.slice(8))}</button>`;
            })
            .join('')}
        </div>
        <div class="dp-foot">
          <button type="button" class="dp-today" data-action="ev-pick-date" data-date="${today}" ${min && today < min ? 'disabled' : ''}>오늘</button>
        </div>
      </div>`;
  }

  function renderTimePop(field) {
    const [h, m] = (eventDraft[field] || '09:00').split(':').map(Number);
    return `
      <div class="picker-pop tp" role="dialog" aria-label="시간 선택">
        <div class="tp-col" data-col="hour">
          <span class="tp-label">시</span>
          ${Array.from({ length: 24 }, (_, i) => `<button type="button" class="${i === h ? 'on' : ''}" data-action="ev-pick-hour" data-h="${i}">${hourText(i)}시</button>`).join('')}
        </div>
        <div class="tp-col" data-col="min">
          <span class="tp-label">분</span>
          ${MINUTE_STEPS.map((mm) => `<button type="button" class="${mm === m ? 'on' : ''}" data-action="ev-pick-min" data-m="${mm}">${pad(mm)}분</button>`).join('')}
        </div>
      </div>`;
  }

  /** 시간 목록: 선택된 시·분이 목록 가운데 오도록 스크롤 */
  function centerTimeColumns() {
    view.querySelectorAll('.tp-col').forEach((col) => {
      const on = col.querySelector('button.on');
      if (on) col.scrollTop = on.offsetTop - col.clientHeight / 2 + on.offsetHeight / 2;
    });
  }

  function renderEventForm() {
    const r = eventDraft;
    const isEdit = !!r.id;
    return `
      <form class="routine-modal-form" data-form="event" novalidate>
        <div class="section-head">
          <h2 id="event-form-title">${isEdit ? '일정 수정' : '일정 추가'}</h2>
        </div>

        <div class="form-group">
          <label for="event-title">일정 <span class="req">*</span></label>
          <input id="event-title" class="field" name="title" value="${esc(r.title)}" maxlength="60"
                 placeholder="일정을 입력해주세요" autocomplete="off" />
          ${r.error ? `<p class="error">${esc(r.error)}</p>` : ''}
        </div>

        <div class="form-group">
          <div class="label-row">
            <span class="label">기간</span>
            <div class="label-checks">
              <label class="check-inline">
                <input type="checkbox" data-action="ev-lunar" ${r.lunar ? 'checked' : ''} /> 음력
              </label>
              <label class="check-inline">
                <input type="checkbox" data-action="ev-allday" ${r.allDay ? 'checked' : ''} /> 하루 종일
              </label>
            </div>
          </div>
          <div class="period-row">${periodField('start')}${periodField('startTime')}</div>
          <div class="period-sep" aria-hidden="true">~</div>
          <div class="period-row">${periodField('end')}${periodField('endTime')}</div>
          ${
            r.lunar
              ? `<p class="lunar-hint">양력 ${pickDateText(r.start)}${r.end !== r.start ? ` ~ ${pickDateText(r.end)}` : ''}</p>`
              : ''
          }
        </div>

        <div class="form-group">
          <label for="event-place">장소</label>
          <input id="event-place" class="field" name="place" value="${esc(r.place)}" maxlength="60"
                 placeholder="장소를 입력해주세요" autocomplete="off" />
        </div>

        <div class="form-group">
          <span class="label">반복</span>
          <div class="segmented">
            ${REPEATS.map(
              ([k, label]) => `<button type="button" class="${r.repeat === k ? 'on' : ''}" data-action="ev-repeat" data-repeat="${k}">${label}</button>`
            ).join('')}
          </div>
          ${r.repeat !== 'none' ? '<p class="hint">시작일을 기준으로 반복돼요.</p>' : ''}
        </div>

        <div class="form-group">
          <span class="label">색상</span>
          <div class="palette">
            ${COLORS.map(
              (c) => `<button type="button" class="swatch ${r.color === c ? 'selected' : ''}" style="background:${c}"
                         data-action="ev-color" data-color="${c}" aria-label="색상 ${c}"></button>`
            ).join('')}
          </div>
        </div>

        <div class="form-group">
          <label for="event-memo">간단 설명</label>
          <textarea id="event-memo" class="field" name="memo" maxlength="300" placeholder="간단 설명을 입력해주세요">${esc(r.memo)}</textarea>
        </div>

        <div class="form-actions">
          ${isEdit ? '<button type="button" class="btn lg danger" data-action="event-delete">삭제</button><span class="spacer"></span>' : ''}
          <button type="button" class="btn lg" data-action="event-close">취소</button>
          <button type="submit" class="btn lg primary">저장</button>
        </div>
      </form>`;
  }

  function renderEventPage() {
    const p = eventPage;
    const [y, m] = p.month.split('-').map(Number);
    const today = todayStr();

    setHeaderTitle(`
      <div class="page-title">
        <button class="back-btn" data-action="events-back" aria-label="뒤로가기">&lsaquo;</button>
        <h2>일정 관리</h2>
      </div>`);

    // 팝업이 이미 떠 있으면 팝업 안의 폼만 다시 그린다 (깜빡임·스크롤 초기화 방지)
    const openModal = view.querySelector('.event-modal');
    if (eventDraft && !eventDraft.modalEnter && openModal) {
      const scrollTop = openModal.scrollTop;
      const activeName = document.activeElement?.name;
      openModal.innerHTML = renderEventForm();
      openModal.scrollTop = scrollTop;
      if (activeName) openModal.querySelector(`[name="${activeName}"]`)?.focus();
      return;
    }

    const days = monthDays(p.month);
    const lead = parse(days[0]).getDay();
    const blanks = Array.from({ length: lead }, () => '<div class="ecal-cell blank"></div>').join('');
    const cells = days
      .map((d) => {
        const dow = parse(d).getDay();
        const evs = eventsOn(d);
        const cls = [
          'ecal-cell',
          d === p.selected ? 'active' : '',
          d === today ? 'today' : '',
          dow === 0 ? 'sun' : dow === 6 ? 'sat' : '',
        ].join(' ');
        return `
          <button type="button" class="${cls}" data-action="ev-select" data-date="${d}"
                  aria-label="${dayLabel(d)}${evs.length ? ` 일정 ${evs.length}개` : ''}">
            <span class="ecal-date">${Number(d.slice(8))}</span>
            <span class="ecal-dots">
              ${evs.slice(0, 3).map(({ ev }) => `<i style="background:${esc(ev.color || COLORS[0])}"></i>`).join('')}
              ${evs.length > 3 ? '<small>+</small>' : ''}
            </span>
          </button>`;
      })
      .join('');

    const list = eventsOn(p.selected);

    const modal = eventDraft
      ? `
      <div class="modal-backdrop routine-modal-backdrop ${eventDraft.modalEnter ? 'enter' : ''}">
        <div class="modal routine-modal event-modal" role="dialog" aria-modal="true" aria-labelledby="event-form-title">
          ${renderEventForm()}
        </div>
      </div>`
      : '';
    if (eventDraft) eventDraft.modalEnter = false;
    document.body.classList.toggle('modal-open', !!eventDraft);

    view.innerHTML = `
      <section class="ecal-card">
        <div class="ecal-top">
          <button class="nav-btn sm" data-action="ev-month" data-delta="-1" aria-label="이전 달">&lsaquo;</button>
          <strong class="calendar-month">${y}년 ${m}월</strong>
          <button class="nav-btn sm" data-action="ev-month" data-delta="1" aria-label="다음 달">&rsaquo;</button>
        </div>
        <div class="ecal">
          ${WEEKDAYS.map((w, i) => `<div class="ecal-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
          ${blanks}${cells}
        </div>
      </section>

      <section class="section">
        <div class="section-head">
          <h2>${dayLabel(p.selected)}${list.length ? `<span class="count">${list.length}</span>` : ''}</h2>
        </div>
        ${
          list.length
            ? `<ul class="event-list">${list.map((x) => eventCard(x, 'open-event')).join('')}</ul>`
            : '<p class="empty">이 날짜에 일정이 없어요.</p>'
        }
      </section>
      ${modal}`;
  }

  /** 일정 추가·수정 팝업을 닫고 달력만 있는 일정 관리 화면으로 */
  function closeEventEditor() {
    location.replace('#/events');
  }

  function leaveEvents() {
    eventDraft = null;
    eventPage = null;
    if (cameFromMain) history.back();
    else location.hash = '#/';
  }

  /* =========================================================
   * 월간 현황 페이지 (#/stats)
   * ========================================================= */
  let statsMonth = null; // 'YYYY-MM'
  let statsTab = 'all'; // 'all' | 'routine' | 'todo' | 'diary'

  function monthDays(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    const out = [];
    for (let i = 1; i <= last; i++) out.push(`${ym}-${pad(i)}`);
    return out;
  }

  function shiftMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  // 빈도만 보고 그 날 해야 하는 습관인지 (시작일과 무관 — 월간 목표 계산용)
  function routineDueByFreq(r, dateStr) {
    if (r.freq.type === 'days') return r.freq.days.includes(parse(dateStr).getDay());
    return true; // daily, weekly
  }

  // 습관 하나의 월간 통계: 목표 횟수는 그 달 전체 기준
  // (매일 = 그 달 일수, 요일 선택 = 그 달에 해당 요일 수, 주 N회 = N × 일수 / 7)
  function routineMonthStats(r, ym) {
    const days = monthDays(ym);
    const due = days.filter((d) => routineDueByFreq(r, d));
    const done = days.filter((d) => isChecked(r.id, d)).length;

    const target =
      r.freq.type === 'weekly' ? Math.max(1, Math.round((r.freq.times * days.length) / 7)) : due.length;
    const rate = target ? Math.min(100, Math.round((done / target) * 100)) : null;
    return { days, done, target, rate };
  }

  // 하루 단위 집계 (종합 달력용)
  function dayStats(dateStr) {
    // 습관: 그 날 해야 하는 습관(매일·요일) 중 체크한 비율. 주 N회 습관은 체크한 날만 분모에 넣는다.
    const due = db.routines.filter(
      (r) => routineAppliesTo(r, dateStr) && (r.freq.type !== 'weekly' || isChecked(r.id, dateStr))
    );
    const routineDone = due.filter((r) => isChecked(r.id, dateStr)).length;
    const todos = db.todos[dateStr] || [];
    const todoDone = todos.filter((t) => t.done).length;
    return {
      routineRate: due.length ? Math.round((routineDone / due.length) * 100) : null,
      routineText: `${routineDone}/${due.length}`,
      todoRate: todos.length ? Math.round((todoDone / todos.length) * 100) : null,
      todoText: `${todoDone}/${todos.length}`,
      diary: hasDiary(dateStr),
      mood: diaryMood(dateStr),
    };
  }

  // 종합: 그 달 달력에 날마다 습관·할 일 달성률, 일기 작성 여부 표시
  function renderMonthCalendar(ym) {
    const today = todayStr();
    const days = monthDays(ym);
    const lead = parse(days[0]).getDay(); // 일요일 시작
    const blanks = Array.from({ length: lead }, () => '<div class="mcal-cell blank"></div>').join('');
    const pct = (n) => `${n}<small>%</small>`;

    const cells = days
      .map((d) => {
        const dow = parse(d).getDay();
        const s = dayStats(d);
        const tip = [
          dayLabel(d),
          s.routineRate !== null ? `습관 ${s.routineText} (${s.routineRate}%)` : '',
          s.todoRate !== null ? `할 일 ${s.todoText} (${s.todoRate}%)` : '',
          s.diary ? '일기 작성' : '',
        ]
          .filter(Boolean)
          .join('\n');
        return `
          <div class="mcal-cell ${d === today ? 'today' : ''} ${d > today ? 'future' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}" title="${tip}">
            <div class="mcal-top">
              <span class="mcal-date">${Number(d.slice(8))}</span>
              ${s.diary ? `<span class="mcal-diary" aria-label="일기 작성">${DIARY_ICON}</span>` : ''}
            </div>
            ${s.routineRate !== null ? `<span class="mcal-rate routine" style="--p:${s.routineRate}%">${pct(s.routineRate)}</span>` : ''}
            ${s.todoRate !== null ? `<span class="mcal-rate todo" style="--p:${s.todoRate}%">${pct(s.todoRate)}</span>` : ''}
          </div>`;
      })
      .join('');

    return `
      <section class="section">
        <div class="section-head"><h2>월간 달력</h2></div>
        <div class="mcal">
          ${WEEKDAYS.map((w, i) => `<div class="mcal-wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
          ${blanks}${cells}
        </div>
        <div class="mcal-legend">
          <span><i class="mcal-key routine"></i>습관 달성률</span>
          <span><i class="mcal-key todo"></i>할 일 달성률</span>
          <span><span class="mcal-diary">${DIARY_ICON}</span>일기 작성</span>
        </div>
      </section>`;
  }

  // 일기 작성 표시 아이콘 (연필)
  const DIARY_ICON = `
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.5 2.5l3 3L6 13H3v-3z" /><path d="M9 4l3 3" />
    </svg>`;

  function renderStats() {
    const ym = statsMonth;
    const [y, m] = ym.split('-').map(Number);
    const isFuture = ym > todayStr().slice(0, 7);
    const today = todayStr();

    const rows = db.routines.map((r) => ({ r, s: routineMonthStats(r, ym) }));
    const rated = rows.filter((x) => x.s.rate !== null);
    const avg = rated.length ? Math.round(rated.reduce((a, x) => a + x.s.rate, 0) / rated.length) : null;

    const list = rows
      .map(({ r, s }) => {
        const unit = r.freq.type === 'weekly' ? '회' : '일';
        const strip = s.days
          .map((d) => {
            const cls = isChecked(r.id, d)
              ? 'on'
              : d > today || !routineDueByFreq(r, d)
                ? 'off'
                : 'miss';
            return `<span class="cell ${cls}" title="${d}"></span>`;
          })
          .join('');
        return `
          <li class="stat-item">
            <div class="stat-top">
              ${r.emoji ? `<span class="routine-emoji">${esc(r.emoji)}</span>` : ''}
              <div class="text">
                <span class="sort-name">${esc(r.name)}</span>
                <span class="routine-meta">${esc(freqText(r.freq))}</span>
              </div>
              <div class="stat-rate">
                ${s.rate === null ? '<span class="muted">-</span>' : `<strong>${s.rate}%</strong>`}
                <span class="routine-meta">${s.done}/${s.target}${unit}</span>
              </div>
            </div>
            <div class="progress"><span style="width:${s.rate || 0}%;background:${esc(routineColor(r.color))}"></span></div>
            <div class="month-strip" style="--c:${esc(routineColor(r.color))}">${strip}</div>
          </li>`;
      })
      .join('');

    // 습관 관리 페이지와 같이 header 제목 자리에 뒤로가기 + 페이지 제목을 둔다
    setHeaderTitle(`
      <div class="page-title">
        <button class="back-btn" data-action="stats-back" aria-label="뒤로가기">&lsaquo;</button>
        <h2>월간 현황</h2>
      </div>`);

    // 할 일 · 일기 집계
    const todoAll = Object.keys(db.todos)
      .filter((d) => d.startsWith(ym + '-'))
      .flatMap((d) => db.todos[d] || []);
    const todoDone = todoAll.filter((t) => t.done).length;
    const todoRate = todoAll.length ? Math.round((todoDone / todoAll.length) * 100) : null;
    const diaryCount = Object.keys(db.diary).filter((d) => d.startsWith(ym + '-') && hasDiary(d)).length;

    const cell = (label, value) => `<div><span class="routine-meta">${label}</span><strong>${value}</strong></div>`;
    const avgText = avg === null ? '-' : avg + '%';
    const summaryCells = {
      all: [
        cell('습관 달성률', avgText),
        cell('할 일 달성률', todoRate === null ? '-' : todoRate + '%'),
        cell('작성한 일기', `${diaryCount}개`),
      ],
      routine: [cell('습관 달성률', avgText), cell('습관 수', `${db.routines.length}개`)],
      todo: [
        cell('할 일 달성률', todoRate === null ? '-' : todoRate + '%'),
        cell('작성한 할 일', `${todoAll.length}개`),
        cell('완료한 할 일', `${todoDone}개`),
      ],
      diary: [cell('작성한 일기', `${diaryCount}개`)],
    }[statsTab];

    const TABS = [
      ['all', '종합'],
      ['routine', '습관'],
      ['todo', '할 일'],
      ['diary', '일기'],
    ];

    // 탭은 header 안(제목 줄 아래)에 그려서 스크롤해도 header와 함께 고정
    const tabsHtml = `
      <div class="segmented stats-tabs" role="tablist">
        ${TABS.map(
          ([key, label]) => `<button type="button" role="tab" aria-selected="${statsTab === key}"
                               class="${statsTab === key ? 'on' : ''}" data-action="stats-tab" data-tab="${key}">${label}</button>`
        ).join('')}
      </div>`;
    if (headerSub) headerSub.innerHTML = `<div class="app-header__sub">${tabsHtml}</div>`;

    view.innerHTML = `
      ${headerSub ? '' : tabsHtml}

      <section class="section">
        <div class="month-nav">
          <button class="nav-btn sm" data-action="stats-month" data-delta="-1" aria-label="이전 달">&lsaquo;</button>
          <strong>${y}년 ${m}월</strong>
          <button class="nav-btn sm" data-action="stats-month" data-delta="1" aria-label="다음 달">&rsaquo;</button>
        </div>
        <div class="summary" style="--cols:${summaryCells.length}${summaryCells.length > 3 ? ';--cols-sm:2' : ''}">
          ${summaryCells.join('')}
        </div>
        ${statsTab === 'diary' ? moodSummary(ym) : ''}
      </section>

      ${
        {
          all: () => renderMonthCalendar(ym),
          routine: renderMonthRoutines,
          todo: () => renderMonthTodos(ym),
          diary: () => renderMonthDiary(ym),
        }[statsTab]()
      }`;

    function renderMonthRoutines() {
      return `
      <section class="section">
        <div class="section-head"><h2>습관별 달성률</h2></div>
        ${
          !db.routines.length
            ? '<p class="empty">등록된 습관이 없어요.</p>'
            : isFuture
              ? `${FUTURE_NOTE}<ul class="list">${list}</ul>`
              : `<ul class="list">${list}</ul>`
        }
        <p class="hint">달성률은 그 달 전체에 해야 하는 횟수 기준이에요. <br>주 N회 습관은 주 단위 목표를 그 달 날짜 수에 맞춰 계산해요.</p>
      </section>`;
    }
  }

  // 일기 summary: 그 달에 고른 기분별 개수 (8가지 모두 표시, 0개는 흐리게)
  function moodSummary(ym) {
    const counts = Object.fromEntries(MOODS.map(([e]) => [e, 0]));
    monthDays(ym).forEach((d) => {
      const m = diaryMood(d);
      if (m && m in counts) counts[m] += 1;
    });
    return `
      <ul class="mood-summary" aria-label="기분별 개수">
        ${MOODS.map(
          ([e, label]) => `
          <li class="${counts[e] ? '' : 'zero'}" title="${label} ${counts[e]}개">
            <span class="mood-summary-emoji">${e}</span>
            <span class="mood-summary-count">${counts[e]}</span>
          </li>`
        ).join('')}
      </ul>`;
  }

  // 월간 현황: 아직 오지 않은 달 안내 (습관 · 일기 공용)
  const FUTURE_NOTE = `
    <p class="future-note" role="note">
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
      </svg>
      아직 오지 않은 달이에요.
    </p>`;

  // 'YYYY-MM-DD' → '11월 3일 (월)'
  function dayLabel(dateStr) {
    const d = parse(dateStr);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  }

  // 날짜 머리줄 (표시만): 주차 카드 안이라 월은 빼고 '3일 (월)'
  function statsDayHead(dateStr, extra = '') {
    const dow = parse(dateStr).getDay();
    return `
      <div class="stats-day-head ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}">
        <span class="stats-day-label">${Number(dateStr.slice(8))}일 (${WEEKDAYS[dow]})</span>
        ${extra}
      </div>`;
  }

  // 그 달에 쓴 할 일 (날짜순)
  function renderMonthTodos(ym) {
    const dates = Object.keys(db.todos)
      .filter((d) => d.startsWith(ym + '-') && (db.todos[d] || []).length)
      .sort();
    const all = dates.flatMap((d) => db.todos[d]);
    const doneCount = all.filter((t) => t.done).length;
    // 아직 오지 않은 달: 습관·일기와 같은 안내 상자 (미리 적어 둔 할 일이 있으면 그 아래에 그대로)
    const isFutureMonth = ym > todayStr().slice(0, 7);

    const dayHtml = (d) => {
      const todos = db.todos[d];
      const done = todos.filter((t) => t.done).length;
      const rate = Math.round((done / todos.length) * 100);
      return `
        <li class="stats-day">
          ${statsDayHead(d, `<span class="routine-meta stats-day-count">${done}/${todos.length} · ${rate}%</span>`)}
          <div class="progress todo-progress"><span style="width:${rate}%"></span></div>
          <ul class="stats-todo-list">
            ${todos
              .map(
                (t) => `
                <li class="stats-todo ${t.done ? 'done' : ''}">
                  <span class="stats-check" aria-label="${t.done ? '완료' : '미완료'}">${t.done ? '✓' : ''}</span>
                  <span class="text">${esc(t.text)}</span>
                </li>`
              )
              .join('')}
          </ul>
        </li>`;
    };

    // 일기와 같은 기준: 일요일 시작 주차 (달 밖 날짜는 넣지 않음), 할 일이 있는 주만 보여준다
    const weeks = [];
    let week = [];
    monthDays(ym).forEach((d) => {
      if (week.length && parse(d).getDay() === 0) {
        weeks.push(week);
        week = [];
      }
      week.push(d);
    });
    if (week.length) weeks.push(week);
    const md = (d) => `${Number(d.slice(5, 7))}.${Number(d.slice(8))}`;

    const body = dates.length
      ? `<div class="dweeks dweeks--todo">
          ${weeks
            .map((w, i) => {
              const wDates = dates.filter((d) => d >= w[0] && d <= w[w.length - 1]);
              if (!wDates.length) return '';
              const wTodos = wDates.flatMap((d) => db.todos[d]);
              const wDone = wTodos.filter((t) => t.done).length;
              return `
              <div class="dweek">
                <div class="dweek-head">
                  <strong>${i + 1}주차</strong>
                  <span class="routine-meta">${md(w[0])} – ${md(w[w.length - 1])} · ${wDone}/${wTodos.length} · ${Math.round((wDone / wTodos.length) * 100)}%</span>
                </div>
                <ul class="stats-days">${wDates.map(dayHtml).join('')}</ul>
              </div>`;
            })
            .join('')}
        </div>`
      : isFutureMonth
        ? ''
        : '<p class="empty">이 달에 쓴 할 일이 없어요.</p>';

    return `
      <section class="section">
        <div class="section-head">
          <h2>할 일</h2>
        </div>
        ${isFutureMonth ? FUTURE_NOTE : ''}
        ${
          all.length
            ? `<div class="todo-total">
                 <div class="todo-total-head">
                   <span class="todo-total-label">이번 달 전체</span>
                   <span class="routine-meta stats-day-count">${doneCount}/${all.length} · ${Math.round((doneCount / all.length) * 100)}%</span>
                 </div>
                 <div class="progress todo-progress todo-progress--total"><span style="width:${Math.round((doneCount / all.length) * 100)}%"></span></div>
               </div>`
            : ''
        }
        ${body}
      </section>`;
  }

  // 그 달의 일기: 위클리 플래너처럼 주(일~토)마다 카드 하나,
  // 카드 안은 하루 한 줄 [날짜·요일 | 기분 이모지(기분 없이 쓴 날은 연필) | 일기 한 줄 …]
  // 일기를 쓴 줄을 누르면 일기장 모양 팝업으로 전체 내용을 보여준다
  function renderMonthDiary(ym) {
    const days = monthDays(ym);
    const written = days.filter(hasDiary).length;

    // 일요일 시작 주 단위로 자르기 (달 밖 날짜는 넣지 않음)
    const weeks = [];
    let week = [];
    days.forEach((d) => {
      if (week.length && parse(d).getDay() === 0) {
        weeks.push(week);
        week = [];
      }
      week.push(d);
    });
    if (week.length) weeks.push(week);

    const rowHtml = (d) => {
      const dow = parse(d).getDay();
      const mood = diaryMood(d);
      const text = diaryText(d).trim();
      const has = hasDiary(d);
      const cls = `dweek-row ${has ? 'has' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}`;
      const inner = `
          <span class="dweek-date"><b>${Number(d.slice(8))}</b><small>${WEEKDAYS[dow]}</small></span>
          <span class="dweek-mood">${mood || (text ? DIARY_ICON : '')}</span>
          <span class="dweek-text">${text ? esc(text.split('\n')[0]) : ''}</span>`;
      return has
        ? `<li><button type="button" class="${cls}" data-action="open-diary" data-date="${d}"
                   aria-label="${dayLabel(d)} 일기 보기">${inner}</button></li>`
        : `<li><div class="${cls}">${inner}</div></li>`;
    };

    const md = (d) => `${Number(d.slice(5, 7))}.${Number(d.slice(8))}`;
    // 아직 오지 않은 달은 안내 문구 + 빈 위클리를 그대로 보여준다
    const isFuture = ym > todayStr().slice(0, 7);
    const body = written || isFuture
      ? `${isFuture ? FUTURE_NOTE : ''}<div class="dweeks dweeks--paper">
          ${weeks
            .map(
              (w, i) => `
              <div class="dweek">
                <div class="dweek-head">
                  <strong>${i + 1}주차</strong>
                  <span class="routine-meta">${md(w[0])} – ${md(w[w.length - 1])} · ${w.filter(hasDiary).length}일 작성</span>
                </div>
                <ul class="dweek-days">${w.map(rowHtml).join('')}</ul>
              </div>`
            )
            .join('')}
        </div>`
      : '<p class="empty">이 달에 쓴 일기가 없어요.</p>';

    return `
      <section class="section">
        <div class="section-head">
          <h2>일기</h2>
        </div>
        ${body}
      </section>`;
  }

  // 일기장 모양 팝업 (월간 현황 일기에서 줄을 누르면). 바깥·닫기·Esc 로 닫힘
  function showDiaryPopup(d) {
    const mood = diaryMood(d);
    const text = diaryText(d).trim();
    const dt = parse(d);
    const dow = dt.getDay();
    const prevFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop diary-popup-backdrop';
    backdrop.innerHTML = `
      <div class="diary-popup" role="dialog" aria-modal="true" aria-labelledby="diary-popup-date">
        <div class="diary-popup-head">
          <div class="diary-popup-date ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}" id="diary-popup-date">
            <small>${dt.getFullYear()}년 ${dt.getMonth() + 1}월</small>
            <strong>${dt.getDate()}일 <span>${WEEKDAYS[dow]}요일</span></strong>
          </div>
          ${mood ? `<div class="diary-popup-mood" title="${esc(moodLabel(mood))}" aria-label="기분: ${esc(moodLabel(mood))}">${mood}</div>` : ''}
        </div>
        <div class="diary-popup-paper">${text ? esc(text) : '<span class="diary-popup-empty">기분만 남긴 날이에요.</span>'}</div>
        <div class="diary-popup-actions">
          <button type="button" class="btn lg primary" data-close>닫기</button>
        </div>
      </div>`;

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) prevFocus.focus();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    backdrop.querySelector('[data-close]').focus();
  }

  /* =========================================================
   * 라우팅 (해시 기반: #/, #/routines, #/routine/new, #/routine/edit/:id, #/stats)
   * ========================================================= */
  /* =========================================================
   * 모달 (window.alert / confirm 대신 사용)
   * showDialog({ message, title?, confirmText?, cancelText?, danger? }) → Promise<boolean>
   * cancelText가 없으면 확인 버튼만 있는 알림창이 된다.
   * ========================================================= */
  function showDialog({ message, title = '', confirmText = '확인', cancelText = '', danger = false }) {
    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="${cancelText ? 'dialog' : 'alertdialog'}" aria-modal="true" aria-labelledby="modal-message">
          ${title ? `<h3 class="modal-title">${esc(title)}</h3>` : ''}
          <p class="modal-message" id="modal-message">${esc(message)}</p>
          <div class="modal-actions">
            ${cancelText ? `<button type="button" class="btn lg" data-modal="cancel">${esc(cancelText)}</button>` : ''}
            <button type="button" class="btn lg ${danger ? 'danger-fill' : 'primary'}" data-modal="ok">${esc(confirmText)}</button>
          </div>
        </div>`;

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) prevFocus.focus();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(false);
        } else if (e.key === 'Tab') {
          // 포커스를 모달 안에 가둔다
          const btns = [...backdrop.querySelectorAll('button')];
          const i = btns.indexOf(document.activeElement);
          e.preventDefault();
          btns[(i + (e.shiftKey ? btns.length - 1 : 1)) % btns.length].focus();
        }
      };
      backdrop.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-modal]');
        if (btn) close(btn.dataset.modal === 'ok');
        else if (e.target === backdrop) close(false);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(backdrop);
      backdrop.querySelector('[data-modal="ok"]').focus();
    });
  }

  let toastTimer = null;
  function showToast(message) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  /* =========================================================
   * 로그인 페이지 / header 로그인 버튼
   * ========================================================= */
  const authSlot = document.getElementById('auth-slot');
  let loginState = null; // { mode: 'signIn' | 'signUp', username, password, error, notice, submitting }

  function renderAuthSlot() {
    if (!authSlot) return;
    if (/^#\/routine/.test(location.hash)) {
      // 습관 관리 페이지: 로그인/로그아웃 자리에 습관 추가 버튼
      authSlot.innerHTML = `<button type="button" class="btn primary" data-action="routine-add">+ 습관 추가</button>`;
    } else if (/^#\/event/.test(location.hash)) {
      // 일정 관리 페이지: 로그인/로그아웃 자리에 일정 추가 버튼
      authSlot.innerHTML = `<button type="button" class="btn primary" data-action="event-add">+ 일정 추가</button>`;
    } else if (authLoading) {
      authSlot.innerHTML = '';
    } else if (currentUser) {
      authSlot.innerHTML = `<button type="button" class="btn auth-btn" data-action="sign-out" title="${esc(usernameOf(currentUser))}">로그아웃</button>`;
    } else {
      authSlot.innerHTML = `<a href="#/login" class="btn auth-btn">로그인</a>`;
    }
  }

  function renderLogin() {
    const s = loginState;
    const signUpMode = s.mode === 'signUp';
    view.innerHTML = `
      <div class="login-card">
        <a href="#/" class="back-link">← 체크로그</a>
        <h1>${signUpMode ? '회원가입' : '로그인'}</h1>
        ${supabase ? '' : '<p class="form-error" role="alert">Supabase가 설정되지 않아 로그인할 수 없습니다.</p>'}
        <form class="login-form" data-form="login" novalidate>
          <label>
            <span>아이디</span>
            <input name="username" class="field" value="${esc(s.username)}"
              placeholder="${signUpMode ? '영문 소문자·숫자·밑줄 4~20자' : '아이디'}"
              autocomplete="username" autocapitalize="none" spellcheck="false" required />
          </label>
          <label>
            <span>비밀번호</span>
            <input name="password" type="password" class="field" value="${esc(s.password)}"
              autocomplete="${signUpMode ? 'new-password' : 'current-password'}" required />
          </label>
          ${s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''}
          ${s.notice ? `<p class="login-card__note">${esc(s.notice)}</p>` : ''}
          <button type="submit" class="btn primary lg" ${s.submitting || !supabase ? 'disabled' : ''}>
            ${s.submitting ? '처리 중…' : signUpMode ? '가입하기' : '로그인'}
          </button>
        </form>
        <button type="button" class="login-card__switch" data-action="login-switch">
          ${signUpMode ? '이미 계정이 있으면 로그인' : '계정이 없으면 회원가입'}
        </button>
      </div>`;
  }

  async function submitLogin(form) {
    const s = loginState;
    s.username = form.username.value;
    s.password = form.password.value;
    if (!s.username.trim() || !s.password) {
      s.error = '아이디와 비밀번호를 입력해 주세요.';
      renderLogin();
      return;
    }
    s.submitting = true;
    s.error = '';
    s.notice = '';
    renderLogin();

    if (s.mode === 'signUp') {
      const result = await signUp(s.username, s.password);
      s.submitting = false;
      if (result.error) s.error = result.error;
      else if (result.notice) {
        s.notice = result.notice;
        s.mode = 'signIn';
      } else return; // 세션이 생기면 handleSession이 메인으로 보낸다
    } else {
      const message = await signIn(s.username, s.password);
      s.submitting = false;
      if (!message) return;
      s.error = message;
    }
    if (loginState === s && location.hash === '#/login') renderLogin();
  }

  /* header 왼쪽 제목 영역. html이 없으면 기본 CheckLog 제목 */
  const headerTitle = document.getElementById('header-title');
  const DEFAULT_HEADER_TITLE = '<h1>CheckLog</h1>';
  function setHeaderTitle(html) {
    if (!headerTitle) return;
    const next = html || DEFAULT_HEADER_TITLE;
    if (headerTitle.innerHTML !== next) headerTitle.innerHTML = next;
  }

  headerTitle?.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="routine-cancel"]') && routineDraft) leaveRoutineForm();
    else if (e.target.closest('[data-action="stats-back"]') && statsMonth) leaveStats();
    else if (e.target.closest('[data-action="events-back"]') && eventPage) leaveEvents();
  });

  function leaveStats() {
    statsMonth = null;
    statsTab = 'all';
    if (cameFromMain) history.back();
    else location.hash = '#/';
  }

  function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    let m;
    document.body.dataset.route = hash === '/login' ? 'login' : '';
    setHeaderTitle(null);
    if (headerSub) headerSub.innerHTML = ''; // 메인이 아니면 header 달력 비움 (메인은 renderMain에서 다시 채움)
    document.body.classList.remove('modal-open');
    if (hash !== '/login') loginState = null;
    // 습관 관리·추가·수정 페이지는 로그인 후에만 (주소로 직접 들어와도 로그인 화면으로).
    // 세션 확인 중(authLoading)에는 막지 않고, 확인 결과 비로그인이면 handleSession → route 에서 다시 걸러진다
    if ((hash.startsWith('/routine') || hash.startsWith('/event')) && needLogin() && !authLoading) {
      location.replace('#/login');
      return;
    }
    if (hash === '/login') {
      if (currentUser) {
        location.replace('#/');
        return;
      }
      routineDraft = null;
      statsMonth = null;
      eventDraft = null;
      eventPage = null;
      loginState ||= { mode: 'signIn', username: '', password: '', error: '', notice: '', submitting: false };
      renderLogin();
      focusField('.login-form input[name="username"]');
    } else if (hash === '/stats') {
      routineDraft = null;
      eventDraft = null;
      eventPage = null;
      if (!statsMonth) statsMonth = ui.selected.slice(0, 7);
      renderStats();
    } else if (hash === '/events') {
      routineDraft = null;
      openEventForm(null, { modal: false });
    } else if (hash === '/event/new') {
      routineDraft = null;
      openEventForm(null, { modal: true });
    } else if ((m = hash.match(/^\/event\/edit\/([\w-]+)$/))) {
      routineDraft = null;
      openEventForm(m[1]);
    } else if (hash === '/routines') {
      eventDraft = null;
      eventPage = null;
      openRoutineForm(null, { modal: false });
    } else if (hash === '/routine/new') {
      openRoutineForm(null, { modal: true });
    } else if ((m = hash.match(/^\/routine\/edit\/([\w-]+)$/))) {
      openRoutineForm(m[1]);
    } else {
      cameFromMain = false;
      routineDraft = null;
      statsMonth = null;
      eventDraft = null;
      eventPage = null;
      renderMain();
    }
    renderAuthSlot();
    window.scrollTo(0, 0);
  }

  function goRoutine(path) {
    cameFromMain = true;
    location.hash = path;
  }

  /* =========================================================
   * 이벤트 처리
   * ========================================================= */
  /* ---------- 로그인 필요 동작 ---------- */
  const WRITE_ACTIONS = new Set([
    'new-routine', 'toggle-routine',
    'add-todo', 'toggle-todo', 'edit-todo', 'delete-todo', 'postpone-todo',
    'edit-diary',
    'open-events',
  ]);

  /** Supabase가 설정돼 있는데 로그인하지 않은 상태 */
  const needLogin = () => Boolean(supabase) && !currentUser;

  function askLogin() {
    void showDialog({
      title: '로그인이 필요해요',
      message: '로그인 후 작성할 수 있어요.',
      confirmText: '로그인',
      cancelText: '취소',
    }).then((ok) => {
      if (ok) location.hash = '#/login';
    });
  }

  // 본문(view)과 header 안 달력(headerSub)의 클릭을 같은 처리기로
  view.addEventListener('click', onViewClick);
  headerSub?.addEventListener('click', onViewClick);

  function onViewClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;

    // 로그인 전에는 작성·수정·체크 동작을 막고 로그인 안내
    if (WRITE_ACTIONS.has(action) && needLogin()) {
      e.preventDefault(); // 체크박스가 체크된 모양으로 바뀌지 않게
      askLogin();
      return;
    }

    switch (action) {
      /* --- 달력 --- */
      case 'select-day':
        ui.selected = el.dataset.date;
        resetEditing();
        renderMain();
        break;
      case 'prev-week':
      case 'next-week': {
        const delta = action === 'prev-week' ? -7 : 7;
        const offset = diffDays(ui.selected, ui.weekStart);
        ui.weekStart = addDays(ui.weekStart, delta);
        ui.selected = addDays(ui.weekStart, offset >= 0 && offset < 7 ? offset : 0);
        resetEditing();
        renderMain();
        break;
      }
      case 'cal-toggle':
        ui.calOpen = !ui.calOpen;
        ui.calMonth = ui.selected.slice(0, 7);
        renderMain();
        break;
      case 'cal-month':
        ui.calMonth = shiftMonth(ui.calMonth || ui.selected.slice(0, 7), Number(el.dataset.delta));
        renderMain();
        break;
      case 'cal-pick': {
        const d = el.dataset.date;
        // 지금 보이는 주 안이면 주는 그대로, 아니면 그 날짜부터 한 주 (오늘 버튼과 같은 방식)
        const offset = diffDays(d, ui.weekStart);
        if (offset < 0 || offset > 6) ui.weekStart = d;
        ui.selected = d;
        ui.calOpen = false;
        resetEditing();
        renderMain();
        break;
      }
      case 'go-today':
        ui.calOpen = false;
        ui.weekStart = todayStr();
        ui.selected = todayStr();
        resetEditing();
        renderMain();
        break;

      /* --- 습관 --- */
      case 'new-routine':
        goRoutine('/routines');
        break;
      case 'toggle-routine': {
        const list = db.routineChecks[ui.selected] || [];
        db.routineChecks[ui.selected] = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
        if (!db.routineChecks[ui.selected].length) delete db.routineChecks[ui.selected];
        saveDB();
        renderMain();
        break;
      }

      /* --- 할 일 --- */
      case 'add-todo':
        // + 버튼: 편집 모드 켜기/끄기
        ui.todoAdding = !ui.todoAdding;
        ui.todoEditingId = null;
        renderMain();
        if (ui.todoAdding) focusField('[data-form="todo-add"] .todo-input');
        break;
      case 'cancel-todo-add':
        ui.todoAdding = false;
        ui.todoEditingId = null;
        renderMain();
        break;
      case 'toggle-todo': {
        const t = (db.todos[ui.selected] || []).find((x) => x.id === id);
        if (t) {
          t.done = !t.done;
          saveDB();
          renderMain();
        }
        break;
      }
      case 'postpone-todo': {
        // 선택한 날짜에서 빼서 다음 날 목록 맨 아래로 옮긴다
        const from = ui.selected;
        const to = addDays(from, 1);
        const list = db.todos[from] || [];
        const t = list.find((x) => x.id === id);
        if (!t) break;
        db.todos[from] = list.filter((x) => x.id !== id);
        if (!db.todos[from].length) delete db.todos[from];
        (db.todos[to] ||= []).push(t);
        if (ui.todoEditingId === id) ui.todoEditingId = null;
        saveDB();
        renderMain();
        showToast(`${Number(to.slice(5, 7))}월 ${Number(to.slice(8))}일로 미뤘어요.`);
        break;
      }
      case 'edit-todo':
        ui.todoEditingId = id; // 편집 모드는 유지
        renderMain();
        focusField('[data-form="todo-edit"] .todo-input');
        break;
      case 'cancel-todo-edit':
        ui.todoEditingId = null;
        renderMain();
        break;
      case 'delete-todo': {
        const date = ui.selected;
        void showDialog({ message: '이 할 일을 삭제할까요?', confirmText: '삭제', cancelText: '취소', danger: true }).then(
          (ok) => {
            if (!ok) return;
            db.todos[date] = (db.todos[date] || []).filter((x) => x.id !== id);
            if (!db.todos[date].length) delete db.todos[date];
            saveDB();
            if (!routineDraft && !statsMonth && !loginState && !eventPage) renderMain();
          }
        );
        break;
      }

      /* --- 일기 --- */
      case 'edit-diary':
        ui.diaryEditing = true;
        renderMain();
        focusField('[data-form="diary"] textarea');
        autoGrow(view.querySelector('[data-form="diary"] textarea'));
        break;
      case 'pick-mood': {
        // 다시 그리지 않고 버튼 상태만 바꾼다 (입력 중인 일기 내용 유지). 같은 걸 다시 누르면 선택 해제
        const box = el.closest('.mood-pick');
        const input = box.querySelector('input[name="mood"]');
        input.value = input.value === el.dataset.mood ? '' : el.dataset.mood;
        box.querySelectorAll('.mood-opt').forEach((b) => {
          const on = b.dataset.mood === input.value;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', on);
        });
        break;
      }
      case 'cancel-diary':
        ui.diaryEditing = false;
        renderMain();
        break;

      /* --- 로그인 --- */
      case 'login-switch':
        loginState.mode = loginState.mode === 'signUp' ? 'signIn' : 'signUp';
        loginState.error = '';
        loginState.notice = '';
        renderLogin();
        break;

      /* --- 습관 설정 페이지 --- */
      /* --- 월간 현황 --- */
      case 'open-stats':
        goRoutine('/stats');
        break;
      case 'stats-month':
        statsMonth = shiftMonth(statsMonth, Number(el.dataset.delta));
        renderStats();
        break;
      case 'stats-tab':
        statsTab = el.dataset.tab;
        renderStats();
        break;
      case 'open-diary':
        showDiaryPopup(el.dataset.date);
        break;
      case 'stats-back':
        leaveStats();
        break;

      /* --- 일정 --- */
      case 'open-events':
        // 메인 + : 선택한 날짜로 일정 관리 페이지 열기
        eventPage = { month: ui.selected.slice(0, 7), selected: ui.selected };
        goRoutine('/events');
        break;
      case 'ev-select':
        if (!eventPage) break;
        eventPage.selected = el.dataset.date;
        renderEventPage();
        break;
      case 'ev-month': {
        if (!eventPage) break;
        eventPage.month = shiftMonth(eventPage.month, Number(el.dataset.delta));
        const t = todayStr();
        // 바뀐 달에 오늘이 있으면 오늘, 아니면 1일 선택
        eventPage.selected = t.startsWith(eventPage.month) ? t : `${eventPage.month}-01`;
        renderEventPage();
        break;
      }
      case 'open-event':
        location.replace(`#/event/edit/${id}`);
        break;
      case 'ev-repeat':
        eventDraft.repeat = el.dataset.repeat;
        renderEventPage();
        break;
      case 'ev-picker': {
        const f = el.dataset.field;
        if (eventDraft.picker?.field === f) eventDraft.picker = null;
        else {
          const base = eventDraft[f] || eventDraft.start || todayStr();
          const L = toLunar(base);
          eventDraft.picker = {
            field: f,
            month: base.slice(0, 7),
            lunar: L ? { y: L.y, m: L.m, leap: L.leap } : null,
          };
        }
        renderEventPage();
        if (eventDraft.picker && f.endsWith('Time')) centerTimeColumns();
        break;
      }
      case 'ev-pick-month': {
        const p = eventDraft.picker;
        const delta = Number(el.dataset.delta);
        if (eventDraft.lunar && p.lunar) {
          const next = shiftLunarMonth(p.lunar, delta);
          if (fromLunar(next.y, next.m, 1, next.leap)) p.lunar = next; // 변환 범위(1000~2050년) 안에서만
        } else {
          p.month = shiftMonth(p.month, delta);
        }
        renderEventPage();
        break;
      }
      case 'ev-lunar':
        if (!eventDraft) break;
        // 날짜는 그대로(양력 기준 같은 날), 입력 달력과 반복 기준만 음력으로
        eventDraft.lunar = el.checked;
        eventDraft.picker = null;
        renderEventPage();
        break;
      case 'ev-pick-date': {
        const f = eventDraft.picker.field;
        eventDraft[f] = el.dataset.date;
        // 종료일이 시작일보다 앞이면 시작일로 맞춘다
        if (f === 'start' && eventDraft.end < eventDraft.start) eventDraft.end = eventDraft.start;
        eventDraft.picker = null;
        renderEventPage();
        break;
      }
      case 'ev-pick-hour': {
        const f = eventDraft.picker.field;
        const mm = (eventDraft[f] || '09:00').split(':')[1];
        eventDraft[f] = `${pad(Number(el.dataset.h))}:${mm}`;
        renderEventPage(); // 시를 고른 뒤 분을 고를 수 있게 팝업 유지
        centerTimeColumns();
        break;
      }
      case 'ev-pick-min': {
        const f = eventDraft.picker.field;
        const hh = (eventDraft[f] || '09:00').split(':')[0];
        eventDraft[f] = `${hh}:${pad(Number(el.dataset.m))}`;
        eventDraft.picker = null;
        renderEventPage();
        break;
      }
      case 'ev-allday':
        if (!eventDraft) break;
        eventDraft.picker = null;
        eventDraft.allDay = el.checked;
        renderEventPage();
        break;
      case 'ev-color':
        eventDraft.color = el.dataset.color;
        renderEventPage();
        break;
      case 'event-close':
        closeEventEditor();
        break;
      case 'event-delete': {
        const eid = eventDraft.id;
        void showDialog({ message: '이 일정을 삭제할까요?', confirmText: '삭제', cancelText: '취소', danger: true }).then(
          (ok) => {
            if (!ok || !eventDraft || eventDraft.id !== eid) return;
            db.events = (db.events || []).filter((x) => x.id !== eid);
            saveDB();
            closeEventEditor();
            showToast('일정을 삭제했어요.');
          }
        );
        break;
      }

      case 'open-routine':
        if (routineDraft && routineDraft.id === id) break;
        // 습관 페이지 안에서의 이동은 히스토리를 쌓지 않음 (취소 시 메인으로 바로 복귀)
        location.replace(`#/routine/edit/${id}`);
        break;
      case 'toggle-emoji-picker':
        routineDraft.pickerOpen = !routineDraft.pickerOpen;
        renderRoutineForm();
        break;
      case 'pick-emoji':
        routineDraft.emoji = el.dataset.emoji;
        routineDraft.pickerOpen = false;
        renderRoutineForm();
        break;
      case 'pick-color':
        routineDraft.color = el.dataset.color;
        renderRoutineForm();
        break;
      case 'freq-type':
        routineDraft.freq.type = el.dataset.type;
        if (el.dataset.type === 'days' && !routineDraft.freq.days.length) {
          routineDraft.freq.days = [parse(todayStr()).getDay()];
        }
        renderRoutineForm();
        break;
      case 'toggle-weekday': {
        const day = Number(el.dataset.day);
        const days = routineDraft.freq.days;
        routineDraft.freq.days = days.includes(day) ? days.filter((x) => x !== day) : [...days, day];
        renderRoutineForm();
        break;
      }
      case 'times':
        routineDraft.freq.times = Math.min(7, Math.max(1, routineDraft.freq.times + Number(el.dataset.delta)));
        renderRoutineForm();
        break;
      case 'routine-cancel':
        leaveRoutineForm();
        break;
      case 'routine-add':
        // 습관 페이지 안에서의 이동은 히스토리를 쌓지 않음
        location.replace('#/routine/new');
        break;
      case 'routine-close':
        closeRoutineEditor();
        break;
      case 'routine-delete': {
        const rid = routineDraft.id;
        void showDialog({
          message: '이 습관을 삭제할까요?\n완료 기록도 함께 삭제됩니다.',
          confirmText: '삭제',
          cancelText: '취소',
          danger: true,
        }).then((ok) => {
          if (!ok || !routineDraft || routineDraft.id !== rid) return;
          db.routines = db.routines.filter((r) => r.id !== rid);
          Object.keys(db.routineChecks).forEach((k) => {
            db.routineChecks[k] = db.routineChecks[k].filter((x) => x !== rid);
            if (!db.routineChecks[k].length) delete db.routineChecks[k];
          });
          saveDB();
          closeRoutineEditor();
          showToast('습관을 삭제했어요.');
        });
        break;
      }
    }
  }

  // 일기 입력칸: 크기 조절 손잡이 대신 내용에 맞춰 높이가 자동으로 늘어난다
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 2 + 'px'; // +2: 위아래 border
  }
  view.addEventListener('input', (e) => {
    if (e.target.matches('textarea[data-autogrow]')) autoGrow(e.target);
  });

  // 습관 설정 폼: 입력값을 draft에 유지 (재렌더링 시 보존)
  view.addEventListener('input', (e) => {
    if (!routineDraft) return;
    const { name, value } = e.target;
    if (name === 'name') routineDraft.name = value;
    else if (name === 'memo') routineDraft.memo = value;
  });

  // 일정 폼: 입력값을 draft에 유지 (재렌더링 시 보존)
  view.addEventListener('input', (e) => {
    if (!eventDraft) return;
    const { name, value } = e.target;
    if (!['title', 'place', 'memo'].includes(name)) return;
    eventDraft[name] = value;
  });

  // 일정 기간 선택기 바깥을 누르면 닫기
  document.addEventListener('click', (e) => {
    if (eventDraft && eventDraft.picker && !e.target.closest('.picker-wrap')) {
      eventDraft.picker = null;
      renderEventPage();
    }
  });

  // 이모지 팝업 바깥을 누르면 닫기
  document.addEventListener('click', (e) => {
    if (routineDraft && routineDraft.pickerOpen && !e.target.closest('.emoji-wrap')) {
      routineDraft.pickerOpen = false;
      renderRoutineForm();
    }
  });

  view.addEventListener('submit', (e) => {
    const form = e.target;
    e.preventDefault();
    const type = form.dataset.form;

    // 로그인 전에는 저장하지 않음 (로그인 폼은 제외)
    if (type !== 'login' && needLogin()) {
      askLogin();
      return;
    }

    if (type === 'login') {
      if (!loginState.submitting) void submitLogin(form);
    } else if (type === 'todo-add') {
      const text = form.text.value.trim();
      if (!text) return form.text.focus();
      (db.todos[ui.selected] ||= []).push({ id: uid(), text, done: false });
      saveDB();
      renderMain();
      focusField('[data-form="todo-add"] .todo-input'); // 연속 입력 가능하도록 입력창 유지
    } else if (type === 'todo-edit') {
      const text = form.text.value.trim();
      if (!text) return form.text.focus();
      const t = (db.todos[ui.selected] || []).find((x) => x.id === form.dataset.id);
      if (t) t.text = text;
      ui.todoEditingId = null;
      saveDB();
      renderMain();
    } else if (type === 'diary') {
      setDiary(ui.selected, form.text.value, form.mood.value);
      ui.diaryEditing = false;
      saveDB();
      renderMain();
    } else if (type === 'event') {
      const r = eventDraft;
      r.title = r.title.trim();
      if (!r.title) {
        r.error = '일정을 입력해주세요.';
        renderEventPage();
        return focusField('#event-title');
      }
      if (!r.start) {
        void showDialog({ message: '시작일을 선택해주세요.' });
        return;
      }
      if (!r.end || r.end < r.start) r.end = r.start;
      if (!r.allDay && r.start === r.end && r.startTime && r.endTime && r.endTime < r.startTime) {
        void showDialog({ message: '종료 시각이 시작 시각보다 빨라요.' });
        return;
      }
      const data = {
        title: r.title,
        start: r.start,
        end: r.end,
        allDay: r.allDay,
        startTime: r.allDay ? '' : r.startTime || '',
        endTime: r.allDay ? '' : r.endTime || '',
        place: r.place.trim(),
        repeat: r.repeat,
        lunar: Boolean(r.lunar),
        color: r.color,
        memo: r.memo.trim(),
      };
      r.error = '';
      db.events ||= [];
      if (r.id) Object.assign(db.events.find((x) => x.id === r.id), data);
      else db.events.push({ id: uid(), ...data });
      saveDB();
      if (eventPage) eventPage.selected = eventPage.selected || r.start;
      closeEventEditor();
      showToast(r.id ? '일정을 저장했어요.' : '일정을 추가했어요.');
    } else if (type === 'routine') {
      const r = routineDraft;
      r.name = r.name.trim();
      if (!r.name) {
        r.error = '습관명을 입력해주세요.';
        renderRoutineForm();
        return focusField('#routine-name');
      }
      if (r.freq.type === 'days' && !r.freq.days.length) {
        void showDialog({ message: '반복할 요일을 하나 이상 선택해주세요.' });
        return;
      }
      const data = { emoji: r.emoji || '', name: r.name, color: r.color, freq: r.freq, memo: r.memo.trim() };
      r.error = '';
      if (r.id) {
        const target = db.routines.find((x) => x.id === r.id);
        Object.assign(target, data);
        saveDB();
        // 수정 팝업을 닫고 습관 관리 목록에 남는다 (목록에 바뀐 내용이 바로 반영됨)
        closeRoutineEditor();
        showToast('습관을 저장했어요.');
      } else {
        db.routines.push({ id: uid(), ...data, startDate: todayStr() });
        saveDB();
        // 추가 팝업을 닫고 습관 관리 목록에 남는다
        closeRoutineEditor();
        showToast('습관을 추가했어요.');
      }
    }
  });

  // ESC로 인라인 입력 취소
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (eventDraft) {
      if (eventDraft.picker) {
        eventDraft.picker = null;
        renderEventPage();
      } else {
        closeEventEditor();
      }
      return;
    }
    if (routineDraft) {
      // 습관 추가·수정 팝업: ESC로 닫기 (이모지 선택창이 열려 있으면 그것만 닫기)
      if (routineDraft.pickerOpen) {
        routineDraft.pickerOpen = false;
        renderRoutineForm();
      } else if (routineDraft.modal) {
        closeRoutineEditor();
      }
      return;
    }
    if (ui.todoEditingId) {
      // 할 일 한 줄 수정 중이면 그 수정만 취소 (편집 모드 유지)
      ui.todoEditingId = null;
      renderMain();
    } else if (ui.todoAdding || ui.diaryEditing) {
      resetEditing();
      renderMain();
    }
  });

  authSlot?.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="routine-add"]')) {
      location.replace('#/routine/new');
      return;
    }
    if (e.target.closest('[data-action="event-add"]')) {
      location.replace('#/event/new');
      return;
    }
    if (!e.target.closest('[data-action="sign-out"]') || !supabase) return;
    void supabase.auth.signOut();
  });

  window.addEventListener('hashchange', route);
  route();
  renderAuthSlot();
  if (supabase) {
    // INITIAL_SESSION 포함. 콜백 안에서 supabase 호출을 기다리면 교착되므로 다음 틱으로 미룬다
    supabase.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => handleSession(session), 0);
    });
  }
})();
