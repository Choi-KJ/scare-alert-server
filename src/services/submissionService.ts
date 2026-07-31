import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { platformContents, submissions } from '../db/schema'
import { recomputeConfirmed } from '../lib/aggregate'
import { isDuplicate, isRateLimited } from '../lib/rateLimit'

// 서비스 레이어 (Spring의 @Service). 라우트는 이 함수들만 호출하고, DB 접근은 여기서.

export interface SubmissionInput {
  platform: string
  contentId: string
  at: number
  intensity: 'mild' | 'moderate' | 'intense'
  sessionId: string
}

/** 제보 처리 결과 (라우트가 HTTP 상태로 매핑) */
export type SubmissionResult = 'created' | 'duplicate' | 'rate_limited'

/**
 * (platform, contentId)에 해당하는 platform_contents 행을 찾고, 없으면 생성해 id를 반환.
 * MySQL/MariaDB는 RETURNING이 없어 Drizzle의 $returningId()로 auto increment id를 받는다.
 */
async function findOrCreatePlatformContent(platform: string, contentId: string): Promise<number> {
  const existing = await db
    .select({ id: platformContents.id })
    .from(platformContents)
    .where(and(eq(platformContents.platform, platform), eq(platformContents.contentId, contentId)))
    .limit(1)

  if (existing.length > 0) return existing[0].id

  const inserted = await db
    .insert(platformContents)
    .values({ platform, contentId })
    .$returningId()
  return inserted[0].id
}

/**
 * 제보 1건 처리: 어뷰징 방지(빈도 제한·중복) 통과 시 저장 후 재집계.
 * 반환값으로 결과를 알려 라우트가 HTTP 상태로 매핑한다.
 */
export async function createSubmission(input: SubmissionInput): Promise<SubmissionResult> {
  // ① 세션 빈도 제한 — DB 쓰기 전에 먼저 차단 (스팸이 pc/제보를 만들지 못하게)
  if (await isRateLimited(input.sessionId)) return 'rate_limited'

  const platformContentId = await findOrCreatePlatformContent(input.platform, input.contentId)

  // ② 중복 제보 — 같은 세션이 같은 지점을 이미 제보했으면 무시(멱등)
  if (await isDuplicate(platformContentId, input.sessionId, input.at)) return 'duplicate'

  await db.insert(submissions).values({
    platformContentId,
    atSeconds: input.at,
    intensity: input.intensity,
    sessionId: input.sessionId,
  })
  // 제보 후 해당 콘텐츠를 즉시 재집계 → confirmed_timestamps 갱신.
  // (MVP: 소규모라 매 제보마다 재계산. 규모 커지면 배치/큐로 전환)
  await recomputeConfirmed(platformContentId)
  return 'created'
}
