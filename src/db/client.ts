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
  // mysql2가 DB datetime을 UTC로 해석/전송하게 한다.
  timezone: 'Z',
})

// 모든 커넥션의 세션 타임존을 UTC로 고정 → 저장/조회가 서버 위치와 무관하게 일관.
// (서버가 KST여도 now()가 UTC로 저장되고, 표시할 때 원하는 지역시각으로 변환)
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'")
})

export const db = drizzle(pool, { schema, mode: 'default' })
