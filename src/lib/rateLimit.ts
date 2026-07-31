import { and, eq, gte, lte, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { submissions } from '../db/schema'

// 어뷰징 방지 (서버측). 확장의 클라이언트 제한은 우회 가능하므로 서버에서 다시 강제한다.
// 참고: "여러 번 클릭으로 확정 조작"은 이미 집계의 distinct-session 조건이 막는다.
// 여기서는 ① 세션 빈도 제한(스팸/DB 오염) + ② 중복 제보 제거를 담당.

/** 한 세션이 이 간격(초) 안에 다시 제출하면 차단 */
export const MIN_SUBMIT_INTERVAL_SECONDS = 5
/** 같은 지점으로 간주하는 범위(초) — 중복 제거용 */
export const DEDUP_WINDOW_SECONDS = 0.5

/**
 * 세션 빈도 제한: 해당 세션이 최근 MIN_SUBMIT_INTERVAL_SECONDS 이내에 제출한 적 있으면 true.
 * DB의 NOW()로 비교해 앱/DB 시계 차이(skew)에 영향받지 않게 한다.
 */
export async function isRateLimited(sessionId: string): Promise<boolean> {
  const recent = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.sessionId, sessionId),
        sql`${submissions.createdAt} >= (NOW() - INTERVAL ${sql.raw(String(MIN_SUBMIT_INTERVAL_SECONDS))} SECOND)`,
      ),
    )
    .limit(1)
  return recent.length > 0
}

/**
 * 중복 제보: 같은 (콘텐츠, 세션)에서 ±DEDUP_WINDOW_SECONDS 이내에 이미 제보가 있으면 true.
 * (같은 사람이 같은 장면을 다시 제보해도 1건으로만 취급하기 위함)
 */
export async function isDuplicate(
  platformContentId: number,
  sessionId: string,
  atSeconds: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.platformContentId, platformContentId),
        eq(submissions.sessionId, sessionId),
        gte(submissions.atSeconds, atSeconds - DEDUP_WINDOW_SECONDS),
        lte(submissions.atSeconds, atSeconds + DEDUP_WINDOW_SECONDS),
      ),
    )
    .limit(1)
  return rows.length > 0
}
