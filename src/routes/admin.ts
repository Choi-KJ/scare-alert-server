import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono, type Context } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { config } from '../config'
import { checkLogin, recordFailure, recordSuccess } from '../lib/loginRateLimit'
import {
  countAdmins,
  createAdmin,
  deleteAdmin,
  getLastLogin,
  getLoginAttempts,
  listAdmins,
  recordLoginAttempt,
  usernameExists,
  verifyAdmin,
} from '../services/adminService'
import {
  addManualTimestamp,
  deleteManualTimestamp,
  getContentDetail,
  getContentList,
} from '../services/contentService'
import { type Intensity, MIN_SESSIONS } from '../lib/aggregate'

// 관리자 라우트. 세션 쿠키 기반 로그인.
// /admin/login, /admin/logout 은 공개, 그 외 /admin/* 은 인증 필요.
export const adminRoute = new Hono()

const COOKIE = 'admin_session'
const SECRET = config.admin.sessionSecret
const SESSION_MAX_AGE = 60 * 60 * 8 // 8시간

// --- 인증 가드 (login/logout 제외) ---
adminRoute.use('*', async (c, next) => {
  const path = c.req.path
  if (path === '/admin/login' || path === '/admin/logout') return next()
  const session = await getSignedCookie(c, SECRET, COOKIE)
  if (session === 'ok') return next()
  return c.redirect('/admin/login')
})

// --- 로그인 페이지 ---
adminRoute.get('/login', (c) => {
  const error = c.req.query('error') === '1'
  const lockedMins = Number(c.req.query('locked') ?? 0)
  return c.html(loginPage(error, lockedMins))
})

adminRoute.post('/login', async (c) => {
  // 무차별 대입 방지: IP당 실패 횟수 제한
  const ip = clientIp(c)
  const body = await c.req.parseBody()
  const user = String(body.username ?? '')
  const pass = String(body.password ?? '')

  const status = checkLogin(ip)
  if (status.locked) {
    await recordLoginAttempt(user, false, ip) // 잠긴 상태의 시도도 감사 로그에 남김
    return c.redirect('/admin/login?locked=' + Math.ceil(status.retryAfterMs / 60000))
  }

  const ok = await verifyAdmin(user, pass) // DB의 admins 테이블 + bcrypt 검증
  await recordLoginAttempt(user, ok, ip) // 성공/실패 모두 기록 (비밀번호는 저장 안 함)
  if (!ok) {
    recordFailure(ip)
    return c.redirect('/admin/login?error=1')
  }
  recordSuccess(ip)

  await setSignedCookie(c, COOKIE, 'ok', SECRET, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
    // 개발(http)에선 secure=false. 배포(https)에선 true로 바꿀 것.
    secure: false,
  })
  return c.redirect('/admin')
})

adminRoute.get('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' })
  return c.redirect('/admin/login')
})

// --- 대시보드 (로그인 후 첫 화면). 내용은 이후 작업 예정. ---
adminRoute.get('/', (c) =>
  c.html(
    shell(
      'dashboard',
      '대시보드',
      `<p class="muted">대시보드 내용은 이후 작업 예정입니다.</p>`,
    ),
  ),
)

// --- 콘텐츠 목록 (읽기) ---
adminRoute.get('/contents', async (c) => {
  const rows = await getContentList()
  const fmt = (d: Date | null) =>
    d ? new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—'
  const body = rows.length
    ? `<table>
         <thead><tr><th>콘텐츠</th><th>제보</th><th>세션</th><th>확정</th><th>최근 제보</th></tr></thead>
         <tbody>${rows
           .map(
             (r) => `<tr>
             <td><a class="link" href="/admin/contents/${r.id}">${esc(r.platform)} / ${esc(r.contentId)}</a></td>
             <td>${r.submissionCount}</td>
             <td>${r.sessionCount}</td>
             <td>${r.confirmedCount}</td>
             <td class="muted">${fmt(r.lastSubmissionAt)}</td>
           </tr>`,
           )
           .join('')}</tbody>
       </table>`
    : `<p class="muted">아직 제보된 콘텐츠가 없습니다.</p>`
  return c.html(shell('contents', '콘텐츠', body))
})

// --- 콘텐츠 상세 (읽기): 확정 타임스탬프 + 제보 클러스터 ---
adminRoute.get('/contents/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const d = await getContentDetail(id)
  if (!d) {
    return c.html(
      shell('contents', '콘텐츠', '<p class="muted">콘텐츠를 찾을 수 없습니다. <a class="link" href="/admin/contents">← 목록으로</a></p>'),
      404,
    )
  }

  const mmss = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  const timeCell = (s: number) => `<td class="time">${mmss(s)}<span class="sec">${s}s</span></td>`
  const msg = c.req.query('msg')
  const notice = msg ? `<div class="notice">${esc(decodeURIComponent(msg))}</div>` : ''

  const confirmedRows =
    d.confirmed.length === 0
      ? `<tr><td colspan="6" class="muted">아직 확정된 지점이 없습니다.</td></tr>`
      : d.confirmed
          .map(
            (t) => `<tr>
              ${timeCell(t.atSeconds)}
              <td>${intensityLabel(t.intensity)}</td>
              <td>${t.source === 'manual' ? '—' : t.confidence.toFixed(2)}</td>
              <td>${t.source === 'manual' ? '—' : t.reportCount}</td>
              <td><span class="badge badge-${t.source}">${t.source === 'manual' ? '수동' : '집계'}</span></td>
              <td style="text-align:right">${
                t.source === 'manual'
                  ? `<form method="post" action="/admin/contents/${d.id}/confirmed/${t.id}/delete" onsubmit="return confirm('삭제할까요?')"><button class="btn btn-sm btn-danger">삭제</button></form>`
                  : '<span class="muted" style="font-size:12px">자동 관리</span>'
              }</td>
            </tr>`,
          )
          .join('')

  const clusterRows =
    d.clusters.length === 0
      ? `<tr><td colspan="4" class="muted">제보가 없습니다.</td></tr>`
      : d.clusters
          .map(
            (cl) => `<tr>
              ${timeCell(cl.atSeconds)}
              <td>${cl.reportCount}</td>
              <td>${cl.sessionCount}</td>
              <td>${
                cl.confirmed
                  ? '<span class="badge badge-ok">확정</span>'
                  : `<span class="badge badge-pending">미달 (세션 ${cl.sessionCount}/${MIN_SESSIONS})</span>`
              }</td>
            </tr>`,
          )
          .join('')

  const body = `
    <div class="crumb"><a class="link" href="/admin/contents">← 콘텐츠</a></div>
    ${notice}
    <div class="stats">
      <span>원시 제보 <b>${d.submissionCount}</b></span>
      <span>서로 다른 세션 <b>${d.sessionCount}</b></span>
      <span>확정 <b>${d.confirmed.length}</b>곳</span>
      <span>${d.movieId ? '영화 연결됨' : '영화 미연결'}</span>
    </div>

    <h2>확정 타임스탬프 <span class="link">${d.confirmed.length}</span></h2>
    <p class="muted" style="font-size:12.5px">알림(오버레이)에 반영되는 지점. 집계/수동 구분.</p>
    <table>
      <thead><tr><th>시각</th><th>강도</th><th>신뢰도</th><th>제보수</th><th>출처</th><th></th></tr></thead>
      <tbody>${confirmedRows}</tbody>
    </table>

    <h2>수동 타임스탬프 등록</h2>
    <p class="muted" style="font-size:12.5px">콜드스타트 시딩용. 등록하면 '수동' 확정으로 즉시 알림에 반영되고 재집계에도 보존됩니다.</p>
    <form method="post" action="/admin/contents/${d.id}/manual" class="add">
      <input name="time" placeholder="시각 (예: 02:03 또는 123.4)" required />
      <select name="intensity">
        <option value="moderate">보통</option>
        <option value="mild">약함</option>
        <option value="intense">강함</option>
      </select>
      <button class="btn btn-primary">등록</button>
    </form>

    <h2>제보 클러스터 <span class="link">${d.clusters.length}</span></h2>
    <p class="muted" style="font-size:12.5px">±2초로 묶은 제보 그룹. 서로 다른 세션 ${MIN_SESSIONS}개 이상이면 자동 확정.</p>
    <table>
      <thead><tr><th>대표 시각</th><th>제보수</th><th>세션수</th><th>상태</th></tr></thead>
      <tbody>${clusterRows}</tbody>
    </table>`

  return c.html(shell('contents', `${esc(d.platform)} / ${esc(d.contentId)}`, body))
})

// 수동 타임스탬프 등록
adminRoute.post('/contents/:id/manual', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.parseBody()
  const at = parseTime(String(body.time ?? ''))
  const intensity = String(body.intensity ?? 'moderate') as Intensity
  const back = `/admin/contents/${id}`
  if (at === null || at < 0) {
    return c.redirect(`${back}?msg=` + encodeURIComponent('시각 형식이 올바르지 않습니다. (예: 02:03 또는 123.4)'))
  }
  if (!['mild', 'moderate', 'intense'].includes(intensity)) {
    return c.redirect(`${back}?msg=` + encodeURIComponent('강도 값이 올바르지 않습니다.'))
  }
  await addManualTimestamp(id, Number(at.toFixed(2)), intensity)
  return c.redirect(`${back}?msg=` + encodeURIComponent(`수동 확정 등록됨 · ${at.toFixed(1)}초`))
})

// 수동 확정 삭제
adminRoute.post('/contents/:id/confirmed/:cid/delete', async (c) => {
  const id = Number(c.req.param('id'))
  const cid = Number(c.req.param('cid'))
  await deleteManualTimestamp(cid)
  return c.redirect(`/admin/contents/${id}?msg=` + encodeURIComponent('수동 확정 삭제됨'))
})

// --- 관리자 관리 (목록/추가/삭제) ---
adminRoute.get('/admins', async (c) => {
  const rows = await listAdmins()
  const withLogin = await Promise.all(
    rows.map(async (a) => ({ ...a, lastLogin: await getLastLogin(a.username) })),
  )
  const msg = c.req.query('msg')
  const notice = msg ? `<div class="notice">${esc(decodeURIComponent(msg))}</div>` : ''
  const fmt = (d: Date) => new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })
  const list = withLogin
    .map(
      (a) => `<tr>
        <td>${a.id}</td>
        <td><a href="#" class="user-link" data-username="${esc(a.username)}">${esc(a.username)}</a></td>
        <td class="muted">${a.lastLogin ? fmt(a.lastLogin) : '<span class="muted">기록 없음</span>'}</td>
        <td style="text-align:right">
          <form method="post" action="/admin/admins/${a.id}/delete" onsubmit="return confirm('삭제할까요?')">
            <button class="btn btn-danger"${rows.length <= 1 ? ' disabled title="마지막 관리자는 삭제 불가"' : ''}>삭제</button>
          </form>
        </td></tr>`,
    )
    .join('')
  return c.html(
    shell(
      'admins',
      '관리자 관리',
      `${notice}
       <table>
         <thead><tr><th>ID</th><th>아이디</th><th>최종 로그인</th><th></th></tr></thead>
         <tbody>${list}</tbody>
       </table>
       <p class="muted" style="font-size:12.5px;margin-top:-2px">아이디를 클릭하면 로그인 이력을 볼 수 있습니다.</p>
       <h2>관리자 추가</h2>
       <form method="post" action="/admin/admins" class="add">
         <input name="username" placeholder="아이디" autocomplete="off" required />
         <input name="password" type="password" placeholder="비밀번호(6자 이상)" required />
         <button class="btn btn-primary">추가</button>
       </form>
       <div id="logModal" class="modal" hidden>
         <div class="modal-panel">
           <div class="modal-head"><span id="logTitle"></span><button class="btn btn-sm" id="logClose">닫기</button></div>
           <div class="modal-body">
             <table><thead><tr><th>시각</th><th>결과</th><th>IP</th></tr></thead><tbody id="logRows"></tbody></table>
           </div>
         </div>
       </div>
       <script>${loginLogScript}</script>`,
    ),
  )
})

adminRoute.post('/admins', async (c) => {
  const body = await c.req.parseBody()
  const username = String(body.username ?? '').trim()
  const password = String(body.password ?? '')
  if (username.length < 2 || password.length < 6) {
    return c.redirect('/admin/admins?msg=' + encodeURIComponent('아이디 2자·비밀번호 6자 이상이어야 합니다.'))
  }
  if (await usernameExists(username)) {
    return c.redirect('/admin/admins?msg=' + encodeURIComponent('이미 존재하는 아이디입니다.'))
  }
  await createAdmin(username, password)
  return c.redirect('/admin/admins?msg=' + encodeURIComponent(`관리자 '${username}' 추가됨`))
})

adminRoute.post('/admins/:id/delete', async (c) => {
  const id = Number(c.req.param('id'))
  // 마지막 관리자는 삭제 금지 (락아웃 방지)
  if ((await countAdmins()) <= 1) {
    return c.redirect('/admin/admins?msg=' + encodeURIComponent('마지막 관리자는 삭제할 수 없습니다.'))
  }
  await deleteAdmin(id)
  return c.redirect('/admin/admins?msg=' + encodeURIComponent('삭제됨'))
})

// 특정 아이디의 로그인 이력 (관리 페이지 팝업에서 fetch) — JSON
adminRoute.get('/login-log', async (c) => {
  const username = c.req.query('username') ?? ''
  if (!username) return c.json({ username, attempts: [] })
  const attempts = await getLoginAttempts(username)
  return c.json({ username, attempts })
})

// 관리 페이지 로그인 이력 팝업 스크립트 (아이디 클릭 → /admin/login-log fetch → 모달 표시).
// 값은 textContent로 넣어 XSS를 피한다.
const loginLogScript = `
(function(){
  var modal = document.getElementById('logModal');
  if(!modal) return;
  function closeLog(){ modal.hidden = true; }
  document.getElementById('logClose').addEventListener('click', closeLog);
  modal.addEventListener('click', function(e){ if(e.target === modal) closeLog(); });
  document.querySelectorAll('.user-link').forEach(function(el){
    el.addEventListener('click', function(e){ e.preventDefault(); openLog(el.getAttribute('data-username')); });
  });
  async function openLog(username){
    document.getElementById('logTitle').textContent = username + ' — 로그인 이력';
    var tbody = document.getElementById('logRows');
    tbody.textContent = '';
    modal.hidden = false;
    function addFull(text, cls){
      var tr = document.createElement('tr'); var td = document.createElement('td');
      td.colSpan = 3; td.className = cls || 'muted'; td.textContent = text;
      tr.appendChild(td); tbody.appendChild(tr);
    }
    try{
      var res = await fetch('/admin/login-log?username=' + encodeURIComponent(username));
      var data = await res.json();
      if(!data.attempts || !data.attempts.length){ addFull('이력 없음'); return; }
      data.attempts.forEach(function(a){
        var tr = document.createElement('tr');
        var t1 = document.createElement('td'); t1.textContent = new Date(a.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        var t2 = document.createElement('td'); t2.textContent = a.success ? '성공' : '실패'; t2.className = a.success ? 'ok' : 'fail';
        var t3 = document.createElement('td'); t3.className = 'muted'; t3.textContent = a.ip || '';
        tr.appendChild(t1); tr.appendChild(t2); tr.appendChild(t3); tbody.appendChild(tr);
      });
    }catch(e){ addFull('불러오기 실패', 'fail'); }
  }
})();
`

// 클라이언트 IP 추출. 프록시 뒤에선 X-Forwarded-For(첫 항목)를 우선 사용.
// (X-Forwarded-For는 신뢰된 프록시 뒤에서만 신뢰할 것 — 로깅 용도라 허용)
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for')
  const raw = xff ? (xff.split(',')[0] ?? '').trim() : (getConnInfo(c).remote.address ?? 'unknown')
  return raw.replace(/^::ffff:/, '') // IPv4-mapped IPv6(::ffff:1.2.3.4) → 1.2.3.4
}

// 강도 표시 라벨
function intensityLabel(i: Intensity): string {
  return i === 'mild' ? '약함' : i === 'intense' ? '강함' : '보통'
}

// "mm:ss"(예 02:03) 또는 "초"(예 123.4)를 초로 파싱. 실패 시 null.
function parseTime(s: string): number | null {
  const v = s.trim()
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v)
  const m = v.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  return null
}

// HTML 이스케이프 (사용자 입력 표시 시 XSS 방지)
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  )
}

// 관리자 공통 레이아웃 (좌측 사이드바 + 메인). active = 현재 메뉴 키.
function shell(active: string, title: string, body: string): string {
  const items = [
    { key: 'dashboard', label: '대시보드', href: '/admin', ic: '▦' },
    { key: 'contents', label: '콘텐츠', href: '/admin/contents', ic: '🎬' },
    { key: 'review', label: '제보 검수', href: '#', ic: '🔎' },
    { key: 'admins', label: '관리자 관리', href: '/admin/admins', ic: '⚙' },
  ]
  const nav = items
    .map(
      (n) =>
        `<a class="${n.key === active ? 'active' : ''}" href="${n.href}"><span class="ic">${n.ic}</span> ${n.label}</a>`,
    )
    .join('')
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>3,2,1 와! — ${esc(title)}</title>
<link rel="stylesheet" href="/admin.css" />
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="brand"><b>3,2,1 와!</b> <span class="tag">Admin</span></div>
      <nav class="nav">${nav}<div class="sep"></div><a href="/admin/logout"><span class="ic">⎋</span> 로그아웃</a></nav>
      <div class="foot">v0.0.1 · dev</div>
    </aside>
    <main class="main">
      <div class="topbar"><h1>${esc(title)}</h1><div class="who">admin</div></div>
      <div class="content">${body}</div>
    </main>
  </div>
</body></html>`
}

// 로그인 페이지 HTML (다크 + 앰버 톤)
function loginPage(error: boolean, lockedMins: number): string {
  const notice =
    lockedMins > 0
      ? `<div class="notice locked">시도가 너무 많습니다. 약 ${lockedMins}분 후 다시 시도해 주세요.</div>`
      : error
        ? `<div class="notice err">아이디 또는 비밀번호가 올바르지 않습니다.</div>`
        : ''
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>3,2,1 와! — 로그인</title>
<link rel="stylesheet" href="/admin.css" />
</head>
<body>
  <div class="login-wrap">
    <form class="card" method="post" action="/admin/login">
      <div class="brand"><b>3,2,1 와!</b></div>
      <div class="sub">로그인</div>
      <label for="u">아이디</label>
      <input id="u" name="username" autocomplete="username" autofocus />
      <label for="p">비밀번호</label>
      <input id="p" name="password" type="password" autocomplete="current-password" />
      ${notice}
      <button type="submit">로그인</button>
    </form>
  </div>
</body></html>`
}
