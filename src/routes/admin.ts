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
import { getContentList } from '../services/contentService'

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
<style>
  :root{ --bg:#0a0a12; --panel:#12121d; --panel-2:#181826; --ink:#f5f3ed; --muted:#8b8996;
    --marquee:#f2b705; --line:rgba(245,243,237,0.12); --line-strong:rgba(245,243,237,0.18); --danger:#c0453b; --sidebar-w:220px; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif;font-size:14px}
  a{text-decoration:none;color:inherit}
  .muted{color:var(--muted)}
  .link{color:var(--marquee);font-weight:600}
  .app{display:flex;min-height:100vh}
  /* 사이드바 */
  .sidebar{width:var(--sidebar-w);flex:none;border-right:1px solid var(--line);background:var(--panel);
    position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:18px 14px}
  .sidebar .brand{font-weight:700;font-size:16px;padding:6px 10px 16px}
  .sidebar .brand b{color:var(--marquee)} .sidebar .brand .tag{color:var(--muted);font-weight:600;font-size:12px}
  .nav{display:flex;flex-direction:column;gap:2px}
  .nav a{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:8px;font-size:13.5px;color:var(--muted)}
  .nav a:hover{background:rgba(245,243,237,0.05);color:var(--ink)}
  .nav a.active{background:rgba(242,183,5,0.12);color:var(--marquee);font-weight:600}
  .nav a .ic{width:16px;text-align:center;opacity:.9}
  .nav .sep{height:1px;background:var(--line);margin:10px 6px}
  .sidebar .foot{margin-top:auto;padding:8px 10px;font-size:12px;color:var(--muted)}
  /* 메인 */
  .main{flex:1;min-width:0}
  .topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 28px;
    border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(10,10,18,.9);z-index:5}
  .topbar h1{font-size:16px;font-weight:700}
  .topbar .who{font-size:13px;color:var(--muted)}
  .content{max-width:820px;padding:24px 28px 80px}
  h2{font-size:15px;margin:26px 0 12px}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th{text-align:left;font-size:12px;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
  td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
  .btn{font:inherit;font-size:13px;font-weight:600;border-radius:7px;padding:7px 12px;cursor:pointer;
    border:1px solid var(--line-strong);background:transparent;color:var(--ink)}
  .btn-primary{background:var(--marquee);color:#1a1400;border-color:var(--marquee)}
  .btn-danger{color:#e88;border-color:rgba(192,69,59,0.5)}
  .btn-danger:hover:not([disabled]){background:rgba(192,69,59,0.14)}
  .btn[disabled]{opacity:.4;cursor:not-allowed}
  form.add{display:flex;gap:10px;flex-wrap:wrap}
  form.add input{font:inherit;font-size:13px;color:var(--ink);background:var(--panel-2);
    border:1px solid var(--line-strong);border-radius:7px;padding:8px 11px}
  .notice{background:rgba(242,183,5,0.12);color:var(--marquee);border:1px solid rgba(242,183,5,0.3);
    border-radius:8px;padding:9px 12px;margin-bottom:16px;font-size:13px}
  .btn-sm{padding:4px 10px;font-size:12px}
  .user-link{color:var(--marquee);font-weight:600;cursor:pointer;border-bottom:1px dotted rgba(242,183,5,.4)}
  .ok{color:#7fd6a2}.fail{color:#e88}
  .modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:50}
  .modal[hidden]{display:none}
  .modal-panel{background:var(--panel);border:1px solid var(--line-strong);border-radius:12px;width:min(560px,92vw);max-height:80vh;display:flex;flex-direction:column}
  .modal-head{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line);font-weight:700}
  .modal-body{padding:8px 18px 18px;overflow:auto}
</style></head>
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
<style>
  :root{ --bg:#0a0a12; --panel:#12121d; --ink:#f5f3ed; --muted:#8b8996;
    --marquee:#f2b705; --line:rgba(245,243,237,0.14); --danger:#e88; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif;
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--line);
    border-radius:12px;padding:28px 26px}
  .brand{font-size:18px;font-weight:700;margin-bottom:4px}
  .brand b{color:var(--marquee)}
  .sub{color:var(--muted);font-size:13px;margin-bottom:22px}
  label{display:block;font-size:12px;color:var(--muted);margin:14px 0 6px}
  input{width:100%;font:inherit;font-size:14px;color:var(--ink);background:#181826;
    border:1px solid var(--line);border-radius:8px;padding:10px 12px}
  input:focus{outline:none;border-color:var(--marquee)}
  button{width:100%;margin-top:22px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;
    color:#1a1400;background:var(--marquee);border:none;border-radius:8px;padding:11px}
  button:hover{filter:brightness(1.06)}
  .notice{font-size:12.5px;margin-top:14px;padding:9px 11px;border-radius:8px}
  .notice.err{color:var(--danger);background:rgba(192,69,59,0.12);border:1px solid rgba(192,69,59,0.3)}
  .notice.locked{color:var(--marquee);background:rgba(242,183,5,0.12);border:1px solid rgba(242,183,5,0.3)}
</style></head>
<body>
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
</body></html>`
}
