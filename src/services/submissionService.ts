import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { platformContents, submissions } from '../db/schema'

// 서비스 레이어 (Spring의 @Service). 라우트는 이 함수들만 호출하고, DB 접근은 여기서.

export interface SubmissionInput {
  platform: string
  contentId: string
  at: number
  intensity: 'mild' | 'moderate' | 'intense'
  sessionId: string
}

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

/** 제보 1건 저장. (집계/확정은 별도 단계 — lib/aggregate에서 다룰 예정) */
export async function createSubmission(input: SubmissionInput): Promise<void> {
  const platformContentId = await findOrCreatePlatformContent(input.platform, input.contentId)
  await db.insert(submissions).values({
    platformContentId,
    atSeconds: input.at,
    intensity: input.intensity,
    sessionId: input.sessionId,
  })
}
