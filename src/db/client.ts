import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'
import { config } from '../config'
import * as schema from './schema'

// DB 커넥션 풀 + Drizzle 인스턴스. 앱 전역에서 이 `db`를 import해서 쓴다.
// (Spring의 DataSource + EntityManager 자리. 단 세션/영속성 컨텍스트는 없음 — 쿼리는 명시적)
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
})

export const db = drizzle(pool, { schema, mode: 'default' })
