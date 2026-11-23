import { createClient } from '@supabase/supabase-js';

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
    diary: {},         // { 'YYYY-MM-DD': '내용' }
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

  function createSupabase() {
    const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
    if (!url || !key) return null;
    try {
      return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
    } catch (e) {
      console.warn('Supabase 클라이언트를 만들지 못했습니다.', e);
      return null;
    }
  }

  const supabase = createSupabase();
  let remoteReady = false;
  let dirtyDuringLoad = false;
  let pushTimer = null;

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
      Object.keys(source.routineChecks).length > 0
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
    if (!remoteReady) dirtyDuringLoad = true;
    stampLocal();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (e) {
      console.warn('저장에 실패했습니다.', e);
    }
    schedulePush();
  }

  function schedulePush() {
    if (!supabase) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      void pushDB();
    }, 350);
  }

  async function pushDB() {
    if (!supabase || !remoteReady) return;
    setSyncStatus('saving');
    const updatedAt = localStorage.getItem(UPDATED_KEY) || stampLocal();
    const { error } = await supabase.from('planner_state').upsert({
      id: 'default',
      routines: db.routines,
      routine_checks: db.routineChecks,
      todos: db.todos,
      diary: db.diary,
      updated_at: updatedAt,
    });
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
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      if (row.updated_at) localStorage.setItem(UPDATED_KEY, new Date(row.updated_at).toISOString());
    } catch (e) {
      console.warn('불러온 데이터를 로컬에 저장하지 못했습니다.', e);
    }
  }

  async function hydrateFromSupabase() {
    if (!supabase) return;
    setSyncStatus('loading');
    const { data, error } = await supabase
      .from('planner_state')
      .select('routines, routine_checks, todos, diary, updated_at')
      .eq('id', 'default')
      .maybeSingle();

    if (error) {
      console.warn('Supabase에서 불러오지 못했습니다.', error.message);
      remoteReady = true;
      setSyncStatus('error', error.message);
      return;
    }

    const localTs = localStorage.getItem(UPDATED_KEY);
    const remoteTs = data?.updated_at || '';
    const localNewer = Boolean(localTs) && (!remoteTs || new Date(localTs).getTime() > new Date(remoteTs).getTime());

    remoteReady = true;

    if (dirtyDuringLoad || localNewer || !data) {
      if (dirtyDuringLoad || localNewer || hasLocalData(db)) await pushDB();
      else setSyncStatus('saved');
      return;
    }

    applyRemote(data);
    if (!routineDraft) route();
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
  };

  let routineDraft = null; // 루틴 설정 페이지 입력값
  let cameFromMain = false;

  const view = document.getElementById('view');

  /* =========================================================
   * 루틴 도메인
   * ========================================================= */
  const COLORS = ['#4f6bed', '#22a06b', '#f5a524', '#e5484d', '#8e4ec6', '#12a594', '#e93d82', '#6b7280'];

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

  function hasData(dateStr) {
    return (
      (db.todos[dateStr] || []).length > 0 ||
      !!(db.diary[dateStr] || '').trim() ||
      (db.routineChecks[dateStr] || []).length > 0
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

    return `
      <section class="calendar">
        <div class="calendar-top">
          <span class="calendar-month">${month}</span>
          <div class="calendar-tools">
            ${showTodayBtn ? '<button class="today-btn" data-action="go-today">오늘</button>' : ''}
            <button class="today-btn stats-btn" data-action="open-stats">📊 월간 현황</button>
          </div>
        </div>
        <div class="calendar-row">
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
        </div>
      </section>`;
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
          <li class="item ${checked ? 'done' : ''}">
            <span class="routine-bar" style="background:${esc(r.color)}"></span>
            <input type="checkbox" data-action="toggle-routine" data-id="${r.id}" ${checked ? 'checked' : ''} aria-label="${esc(r.name)} 완료" />
            ${r.emoji ? `<span class="routine-emoji">${esc(r.emoji)}</span>` : ''}
            <div class="text">
              <button class="routine-name" data-action="edit-routine" data-id="${r.id}">${esc(r.name)}</button>
              <span class="routine-meta">${esc(meta)}</span>
            </div>
          </li>`;
      })
      .join('');

    return `
      <section class="section">
        <div class="section-head">
          <h2>루틴${list.length ? `<span class="count">${doneCount}/${list.length}</span>` : ''}</h2>
          <button class="add-btn" data-action="new-routine" aria-label="루틴 추가">+</button>
        </div>
        ${list.length ? `<ul class="list">${items}</ul>` : '<p class="empty">이 날짜에 해당하는 루틴이 없어요.</p>'}
      </section>`;
  }

  function renderTodos() {
    const d = ui.selected;
    const todos = db.todos[d] || [];
    const doneCount = todos.filter((t) => t.done).length;

    const items = todos
      .map((t) => {
        if (ui.todoEditingId === t.id) {
          return `
            <li class="item">
              <form class="inline-form" style="flex:1" data-form="todo-edit" data-id="${t.id}">
                <input class="field" name="text" value="${esc(t.text)}" maxlength="200" autocomplete="off" />
                <button class="btn primary" type="submit">저장</button>
                <button class="btn" type="button" data-action="cancel-todo-edit">취소</button>
              </form>
            </li>`;
        }
        return `
          <li class="item ${t.done ? 'done' : ''}">
            <input type="checkbox" data-action="toggle-todo" data-id="${t.id}" ${t.done ? 'checked' : ''} aria-label="완료" />
            <span class="text">${esc(t.text)}</span>
            <button class="btn" data-action="edit-todo" data-id="${t.id}">수정</button>
            <button class="btn danger" data-action="delete-todo" data-id="${t.id}">삭제</button>
          </li>`;
      })
      .join('');

    const addForm = ui.todoAdding
      ? `
        <form class="inline-form" data-form="todo-add">
          <input class="field" name="text" placeholder="할 일을 입력하세요" maxlength="200" autocomplete="off" />
          <button class="btn primary" type="submit">확인</button>
          <button class="btn" type="button" data-action="cancel-todo-add">취소</button>
        </form>`
      : '';

    return `
      <section class="section">
        <div class="section-head">
          <h2>해야 할 일${todos.length ? `<span class="count">${doneCount}/${todos.length}</span>` : ''}</h2>
          <button class="add-btn" data-action="add-todo" aria-label="할 일 추가">+</button>
        </div>
        ${addForm}
        ${todos.length ? `<ul class="list">${items}</ul>` : ui.todoAdding ? '' : '<p class="empty">등록된 할 일이 없어요.</p>'}
      </section>`;
  }

  function renderDiary() {
    const d = ui.selected;
    const text = db.diary[d] || '';

    let body;
    if (ui.diaryEditing) {
      body = `
        <form class="inline-form col" data-form="diary">
          <textarea class="field" name="text" placeholder="오늘 하루는 어땠나요?">${esc(text)}</textarea>
          <div style="display:flex;gap:8px">
            <button class="btn" type="button" data-action="cancel-diary">취소</button>
            <button class="btn primary" type="submit">확인</button>
          </div>
        </form>`;
    } else if (text.trim()) {
      body = `
        <p class="diary-text">${esc(text)}</p>
        <div class="diary-actions">
          <button class="btn" data-action="edit-diary">수정</button>
        </div>`;
    } else {
      body = '<p class="empty">작성된 일기가 없어요.</p>';
    }

    // 일기는 하루 1개이므로, 이미 작성된 경우 + 버튼은 숨기고 수정 버튼으로 편집
    const showAdd = !ui.diaryEditing && !text.trim();

    return `
      <section class="section">
        <div class="section-head">
          <h2>일기</h2>
          ${showAdd ? '<button class="add-btn" data-action="edit-diary" aria-label="일기 작성">+</button>' : ''}
        </div>
        ${body}
      </section>`;
  }

  function renderMain() {
    view.innerHTML = renderCalendar() + renderRoutines() + renderTodos() + renderDiary();
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
   * 루틴 설정 페이지 렌더링
   * ========================================================= */
  function openRoutineForm(id) {
    const existing = id ? db.routines.find((r) => r.id === id) : null;
    if (id && !existing) {
      location.hash = '#/';
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
    routineDraft.error = '';
    routineDraft.pickerOpen = false;
    renderRoutineForm();
    focusField('#routine-name');
  }

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

  // 루틴 설정 페이지 상단: 전체 루틴 목록 (드래그로 순서 변경)
  function renderRoutineSortList(currentId) {
    if (!db.routines.length) return '';
    return `
      <section class="section">
        <div class="section-head">
          <h2>내 루틴<span class="count">${db.routines.length}</span></h2>
          <span class="hint" style="margin:0">⋮⋮ 를 끌어서 순서 변경</span>
        </div>
        <ul class="list sort-list">
          ${db.routines
            .map(
              (rt) => `
              <li class="item sort-item ${rt.id === currentId ? 'current' : ''}" data-id="${rt.id}">
                <span class="drag-handle" aria-label="순서 변경">⋮⋮</span>
                <span class="routine-bar" style="background:${esc(rt.color)}"></span>
                <button type="button" class="sort-body" data-action="open-routine" data-id="${rt.id}">
                  ${rt.emoji ? `<span class="routine-emoji">${esc(rt.emoji)}</span>` : ''}
                  <span class="text">
                    <span class="sort-name">${esc(rt.name)}</span>
                    <span class="routine-meta">${esc(freqText(rt.freq))}</span>
                  </span>
                  ${rt.id === currentId ? '<span class="badge">수정 중</span>' : ''}
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

    view.innerHTML = `
      <div class="page-title">
        <button class="back-btn" data-action="routine-cancel" aria-label="뒤로가기">&lsaquo;</button>
        <h2>${isEdit ? '루틴 수정' : '새 루틴'}</h2>
      </div>

      ${renderRoutineSortList(r.id)}

      <form class="section" data-form="routine" novalidate>
        <div class="form-group">
          <label for="routine-name">루틴명 <span class="req">*</span></label>
          <div class="name-row">
            <div class="emoji-wrap">
              <button type="button" class="emoji-btn ${r.emoji ? '' : 'empty'}" data-action="toggle-emoji-picker"
                      aria-label="이모지 선택" aria-expanded="${r.pickerOpen ? 'true' : 'false'}">${r.emoji ? esc(r.emoji) : '☺'}</button>
              ${r.pickerOpen ? renderEmojiPicker(r) : ''}
            </div>
            <input id="routine-name" class="field" name="name" value="${esc(r.name)}" maxlength="50"
                   placeholder="예: 아침 물 한 잔 마시기, 독서 30분" autocomplete="off" />
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
                 <p class="hint">선택한 요일에만 루틴이 표시됩니다.</p>`
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
          <textarea id="routine-memo" class="field" name="memo" placeholder="다짐이나 세부 목표, 참고사항을 적어보세요.">${esc(r.memo)}</textarea>
        </div>

        <div class="form-actions">
          ${isEdit ? '<button type="button" class="btn lg danger" data-action="routine-delete">삭제</button><span class="spacer"></span>' : ''}
          <button type="button" class="btn lg" data-action="routine-cancel">취소</button>
          <button type="submit" class="btn lg primary">저장</button>
        </div>
      </form>`;
  }

  function leaveRoutineForm() {
    routineDraft = null;
    if (cameFromMain) history.back();
    else location.hash = '#/';
  }

  /* =========================================================
   * 월간 현황 페이지 (#/stats)
   * ========================================================= */
  let statsMonth = null; // 'YYYY-MM'

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

  // 루틴 하나의 월간 통계: 목표 횟수는 오늘까지(미래 제외) 기준
  function routineMonthStats(r, ym) {
    const today = todayStr();
    const days = monthDays(ym);
    const elapsed = days.filter((d) => d <= today && routineAppliesTo(r, d));
    const done = days.filter((d) => isChecked(r.id, d)).length;

    let target;
    if (r.freq.type === 'weekly') {
      target = elapsed.length ? Math.max(1, Math.round((r.freq.times * elapsed.length) / 7)) : 0;
    } else {
      target = elapsed.length;
    }
    const rate = target ? Math.min(100, Math.round((done / target) * 100)) : null;
    return { days, done, target, rate };
  }

  function renderStats() {
    const ym = statsMonth;
    const [y, m] = ym.split('-').map(Number);
    const isFuture = ym > todayStr().slice(0, 7);
    const today = todayStr();

    const rows = db.routines.map((r) => ({ r, s: routineMonthStats(r, ym) }));
    const rated = rows.filter((x) => x.s.rate !== null);
    const avg = rated.length ? Math.round(rated.reduce((a, x) => a + x.s.rate, 0) / rated.length) : null;
    const totalDone = rows.reduce((a, x) => a + x.s.done, 0);
    const totalTarget = rows.reduce((a, x) => a + x.s.target, 0);

    const list = rows
      .map(({ r, s }) => {
        const unit = r.freq.type === 'weekly' ? '회' : '일';
        const strip = s.days
          .map((d) => {
            const cls = isChecked(r.id, d)
              ? 'on'
              : d > today || !routineAppliesTo(r, d)
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
            <div class="progress"><span style="width:${s.rate || 0}%;background:${esc(r.color)}"></span></div>
            <div class="month-strip" style="--c:${esc(r.color)}">${strip}</div>
          </li>`;
      })
      .join('');

    view.innerHTML = `
      <div class="page-title">
        <button class="back-btn" data-action="stats-back" aria-label="뒤로가기">&lsaquo;</button>
        <h2>월간 현황</h2>
      </div>

      <section class="section">
        <div class="month-nav">
          <button class="nav-btn sm" data-action="stats-month" data-delta="-1" aria-label="이전 달">&lsaquo;</button>
          <strong>${y}년 ${m}월</strong>
          <button class="nav-btn sm" data-action="stats-month" data-delta="1" aria-label="다음 달">&rsaquo;</button>
        </div>
        <div class="summary">
          <div><span class="routine-meta">평균 달성률</span><strong>${avg === null ? '-' : avg + '%'}</strong></div>
          <div><span class="routine-meta">완료 / 목표</span><strong>${totalDone} / ${totalTarget}</strong></div>
          <div><span class="routine-meta">루틴 수</span><strong>${db.routines.length}개</strong></div>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><h2>루틴별 달성률</h2></div>
        ${
          !db.routines.length
            ? '<p class="empty">등록된 루틴이 없어요.</p>'
            : isFuture
              ? `<p class="empty">아직 오지 않은 달이에요.</p><ul class="list">${list}</ul>`
              : `<ul class="list">${list}</ul>`
        }
        <p class="hint">달성률은 오늘까지 해야 했던 횟수 기준이에요. 주 N회 루틴은 주 단위 목표를 날짜 수에 맞춰 계산해요.</p>
      </section>`;
  }

  /* =========================================================
   * 라우팅 (해시 기반: #/, #/routine/new, #/routine/edit/:id, #/stats)
   * ========================================================= */
  function route() {
    const hash = location.hash.replace(/^#/, '') || '/';
    let m;
    if (hash === '/stats') {
      routineDraft = null;
      if (!statsMonth) statsMonth = ui.selected.slice(0, 7);
      renderStats();
    } else if (hash === '/routine/new') {
      openRoutineForm(null);
    } else if ((m = hash.match(/^\/routine\/edit\/([\w-]+)$/))) {
      openRoutineForm(m[1]);
    } else {
      cameFromMain = false;
      routineDraft = null;
      statsMonth = null;
      renderMain();
    }
    window.scrollTo(0, 0);
  }

  function goRoutine(path) {
    cameFromMain = true;
    location.hash = path;
  }

  /* =========================================================
   * 이벤트 처리
   * ========================================================= */
  view.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;

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
      case 'go-today':
        ui.weekStart = todayStr();
        ui.selected = todayStr();
        resetEditing();
        renderMain();
        break;

      /* --- 루틴 --- */
      case 'new-routine':
        goRoutine('/routine/new');
        break;
      case 'edit-routine':
        goRoutine(`/routine/edit/${id}`);
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
        ui.todoAdding = true;
        ui.todoEditingId = null;
        renderMain();
        focusField('[data-form="todo-add"] input');
        break;
      case 'cancel-todo-add':
        ui.todoAdding = false;
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
      case 'edit-todo':
        ui.todoEditingId = id;
        ui.todoAdding = false;
        renderMain();
        focusField(`[data-form="todo-edit"] input`);
        break;
      case 'cancel-todo-edit':
        ui.todoEditingId = null;
        renderMain();
        break;
      case 'delete-todo':
        if (!confirm('이 할 일을 삭제할까요?')) break;
        db.todos[ui.selected] = (db.todos[ui.selected] || []).filter((x) => x.id !== id);
        if (!db.todos[ui.selected].length) delete db.todos[ui.selected];
        saveDB();
        renderMain();
        break;

      /* --- 일기 --- */
      case 'edit-diary':
        ui.diaryEditing = true;
        renderMain();
        focusField('[data-form="diary"] textarea');
        break;
      case 'cancel-diary':
        ui.diaryEditing = false;
        renderMain();
        break;

      /* --- 루틴 설정 페이지 --- */
      /* --- 월간 현황 --- */
      case 'open-stats':
        goRoutine('/stats');
        break;
      case 'stats-month':
        statsMonth = shiftMonth(statsMonth, Number(el.dataset.delta));
        renderStats();
        break;
      case 'stats-back':
        statsMonth = null;
        if (cameFromMain) history.back();
        else location.hash = '#/';
        break;

      case 'open-routine':
        if (routineDraft && routineDraft.id === id) break;
        // 루틴 페이지 안에서의 이동은 히스토리를 쌓지 않음 (취소 시 메인으로 바로 복귀)
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
      case 'routine-delete': {
        if (!confirm('이 루틴을 삭제할까요? 완료 기록도 함께 삭제됩니다.')) break;
        const rid = routineDraft.id;
        db.routines = db.routines.filter((r) => r.id !== rid);
        Object.keys(db.routineChecks).forEach((k) => {
          db.routineChecks[k] = db.routineChecks[k].filter((x) => x !== rid);
          if (!db.routineChecks[k].length) delete db.routineChecks[k];
        });
        saveDB();
        leaveRoutineForm();
        break;
      }
    }
  });

  // 루틴 설정 폼: 입력값을 draft에 유지 (재렌더링 시 보존)
  view.addEventListener('input', (e) => {
    if (!routineDraft) return;
    const { name, value } = e.target;
    if (name === 'name') routineDraft.name = value;
    else if (name === 'memo') routineDraft.memo = value;
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

    if (type === 'todo-add') {
      const text = form.text.value.trim();
      if (!text) return form.text.focus();
      (db.todos[ui.selected] ||= []).push({ id: uid(), text, done: false });
      saveDB();
      renderMain();
      focusField('[data-form="todo-add"] input'); // 연속 입력 가능하도록 입력창 유지
    } else if (type === 'todo-edit') {
      const text = form.text.value.trim();
      if (!text) return form.text.focus();
      const t = (db.todos[ui.selected] || []).find((x) => x.id === form.dataset.id);
      if (t) t.text = text;
      ui.todoEditingId = null;
      saveDB();
      renderMain();
    } else if (type === 'diary') {
      const text = form.text.value;
      if (text.trim()) db.diary[ui.selected] = text;
      else delete db.diary[ui.selected];
      ui.diaryEditing = false;
      saveDB();
      renderMain();
    } else if (type === 'routine') {
      const r = routineDraft;
      r.name = r.name.trim();
      if (!r.name) {
        r.error = '루틴명을 입력해주세요.';
        renderRoutineForm();
        return focusField('#routine-name');
      }
      if (r.freq.type === 'days' && !r.freq.days.length) {
        alert('반복할 요일을 하나 이상 선택해주세요.');
        return;
      }
      const data = { emoji: r.emoji || '', name: r.name, color: r.color, freq: r.freq, memo: r.memo.trim() };
      if (r.id) {
        const target = db.routines.find((x) => x.id === r.id);
        Object.assign(target, data);
      } else {
        db.routines.push({ id: uid(), ...data, startDate: todayStr() });
      }
      saveDB();
      leaveRoutineForm();
    }
  });

  // ESC로 인라인 입력 취소
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || routineDraft) return;
    if (ui.todoAdding || ui.todoEditingId || ui.diaryEditing) {
      resetEditing();
      renderMain();
    }
  });

  window.addEventListener('hashchange', route);
  route();
  void hydrateFromSupabase();
})();
