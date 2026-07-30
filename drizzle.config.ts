import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit 설정 (마이그레이션 생성/적용용). Spring의 Flyway 설정에 해당.
// generate 는 DB 접속 없이 스키마만 읽지만, migrate/push/studio 는 아래 접속정보를 쓴다.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'scare_alert',
  },
})
