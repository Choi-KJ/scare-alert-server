import { getConnInfo } from '@hono/node-server/conninfo'
import { Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { config } from '../config'
import { checkLogin, recordFailure, recordSuccess } from '../lib/loginRateLimit'
import {
  countAdmins,
  createAdmin,
  deleteAdmin,
  listAdmins,
  usernameExists,
  verifyAdmin,
} from '../services/adminService'

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
  // 무차별 대입 방지: IP당 실패 횟수 제한 (프록시 뒤에선 x-forwarded-for 신뢰 설정 필요)
  const ip = getConnInfo(c).remote.address ?? 'unknown'
  const status = checkLogin(ip)
  if (status.locked) {
    return c.redirect('/admin/login?locked=' + Math.ceil(status.retryAfterMs / 60000))
  }

  const body = await c.req.parseBody()
  const user = String(body.username ?? '')
  const pass = String(body.password ?? '')
  const ok = await verifyAdmin(user, pass) // DB의 admins 테이블 + bcrypt 검증
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

// --- 관리자 홈 (임시). 콘텐츠/대시보드 페이지는 이후 단계(③)에서 구현. ---
adminRoute.get('/', (c) =>
  c.html(
    page(
      '홈',
      `<h1>3,2,1 와! Admin</h1><p class="muted">로그인됨 ✓ 콘텐츠/대시보드 페이지는 이후 단계에서 구현.</p>
       <p><a class="link" href="/admin/admins">관리자 관리 →</a></p>`,
    ),
  ),
)

// --- 관리자 관리 (목록/추가/삭제) ---
adminRoute.get('/admins', async (c) => {
  const rows = await listAdmins()
  const msg = c.req.query('msg')
  const notice = msg ? `<div class="notice">${esc(decodeURIComponent(msg))}</div>` : ''
  const list = rows
    .map(
      (a) => `<tr>
        <td>${a.id}</td>
        <td>${esc(a.username)}</td>
        <td class="muted">${new Date(a.createdAt).toLocaleString('ko-KR')}</td>
        <td style="text-align:right">
          <form method="post" action="/admin/admins/${a.id}/delete" onsubmit="return confirm('삭제할까요?')">
            <button class="btn btn-danger"${rows.length <= 1 ? ' disabled title="마지막 관리자는 삭제 불가"' : ''}>삭제</button>
          </form>
        </td></tr>`,
    )
    .join('')
  return c.html(
    page(
      '관리자 관리',
      `<h1>관리자 관리</h1>
       ${notice}
       <table>
         <thead><tr><th>ID</th><th>아이디</th><th>생성</th><th></th></tr></thead>
         <tbody>${list}</tbody>
       </table>
       <h2>관리자 추가</h2>
       <form method="post" action="/admin/admins" class="add">
         <input name="username" placeholder="아이디" autocomplete="off" required />
         <input name="password" type="password" placeholder="비밀번호(6자 이상)" required />
         <button class="btn btn-primary">추가</button>
       </form>`,
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

// HTML 이스케이프 (사용자 입력 표시 시 XSS 방지)
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  )
}

// 관리자 공통 레이아웃 (다크 + 앰버, 실무형)
function page(title: string, body: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>3,2,1 와! Admin — ${esc(title)}</title>
<style>
  :root{ --bg:#0a0a12; --panel:#12121d; --ink:#f5f3ed; --muted:#8b8996; --marquee:#f2b705;
    --line:rgba(245,243,237,0.12); --line-strong:rgba(245,243,237,0.18); --danger:#c0453b; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,sans-serif;font-size:14px}
  .topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 28px;border-bottom:1px solid var(--line)}
  .topbar .brand{font-weight:700}.topbar .brand b{color:var(--marquee)}
  .wrap{max-width:720px;margin:0 auto;padding:26px 28px 80px}
  h1{font-size:20px;margin-bottom:14px}
  h2{font-size:15px;margin:26px 0 12px}
  .muted{color:var(--muted)}
  .link{color:var(--marquee);font-weight:600;text-decoration:none}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  th{text-align:left;font-size:12px;color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--line)}
  td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
  .btn{font:inherit;font-size:13px;font-weight:600;border-radius:7px;padding:7px 12px;cursor:pointer;
    border:1px solid var(--line-strong);background:transparent;color:var(--ink)}
  .btn-primary{background:var(--marquee);color:#1a1400;border-color:var(--marquee)}
  .btn-danger{color:#e88;border-color:rgba(192,69,59,0.5)}
  .btn-danger:hover:not([disabled]){background:rgba(192,69,59,0.14)}
  .btn[disabled]{opacity:0.4;cursor:not-allowed}
  form.add{display:flex;gap:10px;flex-wrap:wrap}
  form.add input{font:inherit;font-size:13px;color:var(--ink);background:#181826;
    border:1px solid var(--line-strong);border-radius:7px;padding:8px 11px}
  .notice{background:rgba(242,183,5,0.12);color:var(--marquee);border:1px solid rgba(242,183,5,0.3);
    border-radius:8px;padding:9px 12px;margin-bottom:16px;font-size:13px}
</style></head>
<body>
  <div class="topbar">
    <div class="brand"><b>3,2,1 와!</b> Admin</div>
    <div><a class="link" href="/admin">홈</a> &nbsp; <a class="link" href="/admin/logout">로그아웃</a></div>
  </div>
  <div class="wrap">${body}</div>
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
