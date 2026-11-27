# CheckLog (체크로그)

습관 · 할 일 · 일기 · 일정을 하루 단위로 기록하는 개인용 데일리 플래너입니다.
홈 화면에 설치해서 앱처럼 쓰는 PWA이고, 로그인하면 기록이 계정별로 Supabase에 저장됩니다.

## 기술 구성

| 구분 | 사용 |
| --- | --- |
| 화면 | 바닐라 JavaScript (프레임워크 없음) · `index.html` + `app.js` + `style.css` |
| 빌드 | Vite 6 |
| 앱 설치 · 오프라인 | `vite-plugin-pwa` (서비스 워커 자동 갱신, Workbox 캐시) |
| 로그인 · 저장 | Supabase (Auth + `planner_state` 테이블) |
| 음력 | `korean-lunar-calendar` (한국천문연구원 기준, 1000~2050년) |
| 배포 | Vercel (`vercel.json`) |
| 글꼴 | Google Fonts (Chiron GoRound TC, Nanum Gothic, Chango) |

## 파일 구조

```
할일앱/
├─ index.html              # 뼈대: header(제목·로그인 버튼·주간 달력 자리) + <main id="view">
├─ app.js                  # 앱 전체 로직 (저장·로그인·화면 렌더링·라우팅·이벤트 처리)
├─ style.css               # 전체 스타일
├─ vite.config.js          # Vite + PWA 설정 (매니페스트, 캐시 규칙)
├─ vercel.json             # SPA 라우팅 rewrite, sw.js · manifest 캐시 헤더
├─ supabase/schema.sql     # DB 스키마 · RLS 정책 · 트리거 (여러 번 실행해도 안전)
├─ scripts/make-pwa-icons.mjs  # favicon.svg와 같은 그림의 PNG 아이콘 생성
└─ public/                 # 파비콘 · PWA 아이콘
```

## 실행 방법

```bash
npm install
npm run dev       # 개발 서버
npm run build     # dist/ 에 빌드
npm run preview   # 빌드 결과 미리보기
```

### 환경 변수 (`.env`, git에 올리지 않음)

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
```

두 값이 없으면 Supabase 없이 동작합니다. 이때는 이 기기의 `localStorage`에만 저장됩니다.

### Supabase 준비

1. SQL Editor에서 `supabase/schema.sql`을 실행합니다.
2. Authentication > Sign In / Providers > Email 에서 **Confirm email을 끕니다.**
   앱은 아이디를 `아이디@checklog.local` 형태의 내부용 이메일로 바꿔 가입시키기 때문에 실제 메일을 보내지 않습니다.

### 아이콘 다시 만들기

```bash
node scripts/make-pwa-icons.mjs
```

## 화면과 기능

화면은 해시 주소(`#/...`)로 나뉩니다.

| 주소 | 화면 |
| --- | --- |
| `#/` | 메인: 주간 달력 + 습관 · 할 일 · 일기 |
| `#/routines` | 습관 관리 (목록, 순서 변경) |
| `#/routine/new` · `#/routine/edit/:id` | 습관 추가 · 수정 팝업 |
| `#/events` | 일정 관리 (달력 + 목록) |
| `#/event/new` · `#/event/edit/:id` | 일정 추가 · 수정 팝업 |
| `#/stats` | 월간 현황 |
| `#/login` | 로그인 · 회원가입 |

습관 · 일정 관리 화면은 로그인해야 들어갈 수 있습니다.

### 메인 (`#/`)

- **달력**: header 안에 오늘부터 7일이 나오고, 펼치면 한 달 전체를 볼 수 있습니다. 기록이 있는 날에는 점이 찍힙니다. 날짜를 누르면 그날 기록으로 바뀝니다.
- **습관**: 그날 해야 하는 습관만 나옵니다. 체크박스로 완료를 표시하고, 이름을 눌러도 다른 동작은 하지 않습니다. 추가 · 수정은 › 버튼으로 들어가는 습관 관리 화면에서 합니다.
- **할 일**: + 버튼으로 편집 모드를 켜면 추가 · 수정 · 삭제 · **내일로 미루기**를 할 수 있습니다. 미루기는 아직 완료하지 않은 할 일에만 나오고, 누르면 다음 날 목록 맨 아래로 옮겨집니다.
- **일기**: 하루 한 편. 기분 이모지(😄 신남 · 😊 좋음 · 🙂 평온 · 😐 그저 그럼 · 😔 우울 · 😢 슬픔 · 😠 화남 · 😴 피곤)를 함께 고를 수 있습니다.

### 습관

- 이모지, 이름, 색(파스텔 8색), 메모, 시작일을 둘 수 있습니다.
- 빈도는 세 가지입니다.
  - **매일**
  - **요일 지정**: 고른 요일에만 나옵니다.
  - **주 N회**: 매일 나오고, 월요일 시작 기준으로 이번 주 몇 번 했는지 보여줍니다.
- 관리 화면에서 끌어서 순서를 바꿀 수 있습니다.

### 일정

- 제목, 시작 · 종료 날짜와 시간, 하루 종일, 장소, 색, 메모를 둘 수 있습니다.
- 반복: 안 함 · 매일 · 매주 · 매월 · 매년
- **음력 일정**: 날짜를 음력 달력으로 고를 수 있고, 매월 · 매년 반복을 음력 날짜 기준으로 계산합니다(예: 음력 생일). 저장은 항상 양력으로 합니다.

### 월간 현황 (`#/stats`)

달을 골라서 보고, 탭이 네 개 있습니다.

- **종합**: 월간 달력에 날짜별 기록을 모아 보여줍니다.
- **습관**: 습관별 그 달 달성률
- **할 일**: 그 달 전체 완료율과, 주차별 카드(일요일 시작) 안에 날짜(`3일 (월)`)별 할 일 목록 · 완료율. 할 일이 없는 주는 카드를 만들지 않습니다.
- **일기**: 기분 요약과 주차별 일기 카드. 일기를 쓴 줄을 누르면 일기장 모양 팝업으로 전체 내용을 봅니다.

아직 오지 않은 달은 안내 문구를 함께 보여줍니다.

## 데이터

### 앱 안의 데이터 구조

`app.js`의 `emptyDB()`가 기준입니다.

```js
{
  routines: [],      // [{ id, emoji, name, color, freq: { type: 'daily'|'days'|'weekly', days, times }, memo, startDate }]
  routineChecks: {}, // { 'YYYY-MM-DD': [routineId, ...] }
  todos: {},         // { 'YYYY-MM-DD': [{ id, text, done }] }
  diary: {},         // { 'YYYY-MM-DD': '내용' | { text, mood } }   ← 기분이 있을 때만 객체
  events: [],        // [{ id, title, start, end, startTime, endTime, place, repeat, lunar, color, memo }]
}
```

- 일기는 예전 데이터와 맞추려고 두 가지 모양으로 저장됩니다. 읽을 때는 꼭 `diaryText()` · `diaryMood()` · `hasDiary()`를 씁니다.
- 예전 진한 색으로 저장된 습관은 `routineColor()`가 같은 자리의 파스텔 색으로 바꿔 보여줍니다.

### 저장 흐름

1. 바뀔 때마다 `saveDB()`가 `localStorage`(`daily-planner-v1`)에 바로 저장하고 수정 시각을 남깁니다.
2. 로그인 상태면 0.35초 뒤 `pushDB()`가 Supabase `planner_state`에 계정당 한 줄로 upsert 합니다.
3. 로그인하면 `hydrateFromSupabase()`가 서버 데이터를 불러옵니다.
   - 같은 계정이고 이 기기 데이터가 더 최근이면 → 이 기기 데이터를 서버에 올립니다.
   - 그 밖에는 → 서버 데이터로 바꿉니다.
   - 서버에 데이터가 없으면 → 로그인 기능 이전의 공용 데이터(`id = 'default'`)가 있을 때 `claim_default_planner()`로 이 계정 것으로 가져옵니다.
4. 로그인하지 않으면 습관 체크 · 할 일 · 일기 쓰기 같은 저장 동작(`WRITE_ACTIONS`)을 누를 때 로그인을 안내합니다.

### Supabase 테이블

| 테이블 | 내용 |
| --- | --- |
| `profiles` | 계정 아이디(`username`). 가입하면 트리거 `handle_new_user`가 자동으로 만듭니다. |
| `planner_state` | 계정별 전체 기록(`routines` · `routine_checks` · `todos` · `diary` · `events`, 모두 jsonb). RLS로 본인 줄만 읽고 씁니다. |

`events` 컬럼이 없는 예전 DB에서는 일정만 이 기기에 남기고 나머지는 저장합니다. 이 경우 `schema.sql`을 다시 실행하면 됩니다.

### 로그인 규칙

- 아이디: 영문 소문자 · 숫자 · 밑줄 4~20자
- 비밀번호: 6자 이상
- `@`가 들어간 값을 넣으면 이메일 계정으로 보고 그대로 로그인합니다.

## app.js 구성

파일 하나에 기능별 단락으로 나뉘어 있습니다. 위에서부터 순서대로:

| 단락 | 주요 함수 |
| --- | --- |
| 저장소 · 동기화 | `loadDB`, `saveDB`, `pushDB`, `hydrateFromSupabase` |
| 로그인 | `signIn`, `signUp`, `handleSession` |
| 날짜 유틸 | `fmt`, `parse`, `addDays`, `mondayOf` |
| 화면 상태 | `ui` (선택 날짜, 편집 모드 등) |
| 습관 · 일기 도메인 | `routineAppliesTo`, `weeklyCount`, `diaryText`, `setDiary` |
| 메인 렌더링 | `renderCalendar`, `renderRoutines`, `renderTodos`, `renderDiary`, `renderMain` |
| 습관 관리 | `openRoutineForm`, `renderRoutineForm`, `renderRoutineSortList` |
| 일정 · 음력 | `toLunar`, `fromLunar`, `eventsOn`, `openEventForm`, `renderEventPage` |
| 월간 현황 | `renderStats`, `renderMonthCalendar`, `renderMonthTodos`, `renderMonthDiary`, `showDiaryPopup` |
| 공용 UI | `showDialog`(alert/confirm 대체), `showToast` |
| 로그인 화면 · 라우팅 | `renderLogin`, `route` |
| 이벤트 처리 | `onViewClick` — 버튼의 `data-action` 값으로 동작을 나눕니다 |

새 버튼을 만들 때는 `data-action="이름"`을 달고 `onViewClick`의 `switch`에 `case`를 추가합니다. 저장이 일어나는 동작이면 `WRITE_ACTIONS`에도 넣습니다.

## 배포

- Vercel에 올리고, 환경 변수 두 개(`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`)를 프로젝트 설정에 넣습니다.
- `vercel.json`이 정적 파일을 뺀 모든 주소를 `index.html`로 돌리고, `sw.js` · `manifest.webmanifest`는 캐시하지 않게 합니다. 새 버전을 배포하면 서비스 워커가 자동으로 갱신됩니다.
