import {
  mysqlTable, int, varchar, double, mysqlEnum, timestamp, uniqueIndex, index,
} from 'drizzle-orm/mysql-core'

// Drizzle 스키마 = 테이블 정의 + 타입 소스. Spring의 @Entity 자리(단, 애노테이션이 아니라 코드).
// 설계 근거: PLANNING.md 4장. 타임스탬프는 "영화"가 아니라 "(플랫폼, 콘텐츠ID)"에 묶는다
// (같은 영화라도 플랫폼 버전마다 재생시간이 어긋나기 때문).

/** 점프스케어 강도 — 확장의 ScareIntensity와 동일하게 유지 */
export const INTENSITY = ['mild', 'moderate', 'intense'] as const

/** 표시용 canonical 영화 (여러 플랫폼 콘텐츠를 묶는 상위 개념) */
export const movies = mysqlTable('movies', {
  id: int('id').primaryKey().autoincrement(),
  title: varchar('title', { length: 255 }).notNull(),
  poster: varchar('poster', { length: 512 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

/** 플랫폼별 콘텐츠 — 타임스탬프의 실제 소속. (netflix, /watch/{id}) 등 */
export const platformContents = mysqlTable('platform_contents', {
  id: int('id').primaryKey().autoincrement(),
  movieId: int('movie_id'), // 아직 canonical 영화에 안 묶였으면 null 허용
  platform: varchar('platform', { length: 32 }).notNull(),
  contentId: varchar('content_id', { length: 128 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  platformContentUq: uniqueIndex('platform_content_uq').on(t.platform, t.contentId),
}))

/** 원시 제보 (검수/집계 전) */
export const submissions = mysqlTable('submissions', {
  id: int('id').primaryKey().autoincrement(),
  platformContentId: int('platform_content_id').notNull(),
  atSeconds: double('at_seconds').notNull(),
  intensity: mysqlEnum('intensity', INTENSITY).notNull().default('moderate'),
  sessionId: varchar('session_id', { length: 64 }).notNull(), // 익명 세션 (개인식별 정보 아님)
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  submissionsPcIdx: index('submissions_pc_idx').on(t.platformContentId),
}))

/** 집계로 확정된 타임스탬프 (알림에 반영되는 최종 데이터) */
export const confirmedTimestamps = mysqlTable('confirmed_timestamps', {
  id: int('id').primaryKey().autoincrement(),
  platformContentId: int('platform_content_id').notNull(),
  atSeconds: double('at_seconds').notNull(),
  confidence: double('confidence').notNull().default(0),
  reportCount: int('report_count').notNull().default(0),
  status: varchar('status', { length: 16 }).notNull().default('confirmed'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  confirmedPcIdx: index('confirmed_pc_idx').on(t.platformContentId),
}))
