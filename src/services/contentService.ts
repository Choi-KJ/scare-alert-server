import { sql } from 'drizzle-orm'
import { db } from '../db/client'
import { confirmedTimestamps, platformContents, submissions } from '../db/schema'

// 관리자 콘텐츠 목록/집계 조회 (읽기 전용).

export interface ContentRow {
  id: number
  platform: string
  contentId: string
  submissionCount: number
  sessionCount: number
  confirmedCount: number
  lastSubmissionAt: Date | null
}

/** 모든 platform_contents + 콘텐츠별 집계(제보수/세션수/확정수/최근 제보). 최근 제보순 정렬. */
export async function getContentList(): Promise<ContentRow[]> {
  const contents = await db.select().from(platformContents)

  const subStats = await db
    .select({
      pcId: submissions.platformContentId,
      subCount: sql<number>`count(*)`,
      sessionCount: sql<number>`count(distinct ${submissions.sessionId})`,
      lastAt: sql<Date>`max(${submissions.createdAt})`,
    })
    .from(submissions)
    .groupBy(submissions.platformContentId)

  const confStats = await db
    .select({
      pcId: confirmedTimestamps.platformContentId,
      confCount: sql<number>`count(*)`,
    })
    .from(confirmedTimestamps)
    .groupBy(confirmedTimestamps.platformContentId)

  const subMap = new Map(subStats.map((s) => [s.pcId, s]))
  const confMap = new Map(confStats.map((c) => [c.pcId, Number(c.confCount)]))

  const rows: ContentRow[] = contents.map((pc) => {
    const s = subMap.get(pc.id)
    return {
      id: pc.id,
      platform: pc.platform,
      contentId: pc.contentId,
      submissionCount: s ? Number(s.subCount) : 0,
      sessionCount: s ? Number(s.sessionCount) : 0,
      confirmedCount: confMap.get(pc.id) ?? 0,
      lastSubmissionAt: s?.lastAt ? new Date(s.lastAt) : null,
    }
  })

  rows.sort((a, b) => (b.lastSubmissionAt?.getTime() ?? 0) - (a.lastSubmissionAt?.getTime() ?? 0))
  return rows
}
