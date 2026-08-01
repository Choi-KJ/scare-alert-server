import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono, type MiddlewareHandler } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { config } from './config'
import { submissionsRoute } from './routes/submissions'
import { timestampsRoute } from './routes/timestamps'

// 앱 진입점. 하나의 Hono 앱이 웹사이트(정적) + API를 겸한다.
const app = new Hono()

// 미들웨어 (Spring의 필터/인터셉터 자리)
app.use('*', logger())
// 확장은 chrome-extension://<id> origin에서 API를 호출한다. 개발 중엔 전체 허용,
// 배포 시 실제 확장 origin으로 좁힐 것.
app.use('/api/*', cors())

// 헬스체크
app.get('/health', (c) => c.json({ status: 'ok' }))

// API 라우트
app.route('/api/submissions', submissionsRoute)
app.route('/api/timestamps', timestampsRoute)

// === 관리자 (/admin) — Basic Auth 보호 ===
// 계정 미설정 시엔 명확히 500으로 막는다(무방비 노출 방지).
const adminAuth: MiddlewareHandler =
  config.admin.user && config.admin.password
    ? basicAuth({ username: config.admin.user, password: config.admin.password })
    : async (c) => c.text('관리자 계정 미설정 — .env에 ADMIN_USER/ADMIN_PASSWORD 설정 필요', 500)

app.use('/admin', adminAuth)
app.use('/admin/*', adminAuth)

// 임시 관리자 페이지 (인증 확인용). 실제 페이지는 이후 단계(③)에서 Hono JSX로 구현.
app.get('/admin', (c) =>
  c.html('<!doctype html><meta charset="utf-8"><h1>321와 Admin</h1><p>인증됨 ✓ (관리자 페이지는 이후 단계에서 구현)</p>'),
)

// 정적 사이트 (public/) — 랜딩 등. index.html이 '/'로 서빙된다.
app.use('/*', serveStatic({ root: './public' }))

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[3,2,1 와!] server running → http://localhost:${info.port}`)
})
