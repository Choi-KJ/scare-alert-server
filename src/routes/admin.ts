import { Hono } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { config } from '../config'

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
adminRoute.get('/login', (c) => c.html(loginPage(c.req.query('error') === '1')))

adminRoute.post('/login', async (c) => {
  const body = await c.req.parseBody()
  const user = String(body.username ?? '')
  const pass = String(body.password ?? '')
  const ok = config.admin.user !== '' && user === config.admin.user && pass === config.admin.password
  if (!ok) return c.redirect('/admin/login?error=1')

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

// --- 임시 관리자 홈 (인증됨). 실제 페이지는 이후 단계에서 Hono JSX로 구현. ---
adminRoute.get('/', (c) =>
  c.html(
    '<!doctype html><meta charset="utf-8"><title>321와 Admin</title>' +
      '<body style="font-family:system-ui;background:#0a0a12;color:#f5f3ed;padding:40px">' +
      '<h1>321와 Admin</h1><p>로그인됨 ✓ (관리자 페이지는 이후 단계에서 구현)</p>' +
      '<p><a href="/admin/logout" style="color:#f2b705">로그아웃</a></p></body>',
  ),
)

// 로그인 페이지 HTML (다크 + 앰버 톤)
function loginPage(error: boolean): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>321와 Admin — 로그인</title>
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
  .err{color:var(--danger);font-size:12.5px;margin-top:12px;${error ? '' : 'display:none'}}
</style></head>
<body>
  <form class="card" method="post" action="/admin/login">
    <div class="brand"><b>321와</b> Admin</div>
    <div class="sub">관리자 로그인</div>
    <label for="u">아이디</label>
    <input id="u" name="username" autocomplete="username" autofocus />
    <label for="p">비밀번호</label>
    <input id="p" name="password" type="password" autocomplete="current-password" />
    <div class="err">아이디 또는 비밀번호가 올바르지 않습니다.</div>
    <button type="submit">로그인</button>
  </form>
</body></html>`
}
