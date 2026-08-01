import 'dotenv/config'

// 환경변수 로딩 (Spring의 application.yml + @Value 자리). .env 파일에서 읽는다.
export const config = {
  port: Number(process.env.PORT ?? 3000),
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'scare_alert',
  },
  // 관리자 페이지(/admin) 로그인 계정 + 세션 쿠키 서명 시크릿. 서버에만 보관.
  admin: {
    user: process.env.ADMIN_USER ?? '',
    password: process.env.ADMIN_PASSWORD ?? '',
    // 세션 쿠키 서명용. 운영에선 반드시 .env의 SESSION_SECRET을 설정할 것.
    sessionSecret: process.env.SESSION_SECRET ?? 'dev-insecure-secret-change-me',
  },
}
