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
  // 관리자 페이지(/admin) Basic Auth 계정. 서버에만 보관.
  admin: {
    user: process.env.ADMIN_USER ?? '',
    password: process.env.ADMIN_PASSWORD ?? '',
  },
}
