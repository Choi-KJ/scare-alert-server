import { eq, sql } from 'drizzle-orm'
import { db } from '../db/client'
import { buildClusters, MIN_SESSIONS } from '../lib/aggregate'
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

export interface ConfirmedRow {
  atSeconds: number
  confidence: number
  reportCount: number
  source: 'aggregated' | 'manual'
  status: string
}

export interface ClusterRow {
  atSeconds: number
  reportCount: number
  sessionCount: number
  confirmed: boolean
}

export interface ContentDetail {
  id: number
  platform: string
  contentId: string
  movieId: number | null
  submissionCount: number
  sessionCount: number
  confirmed: ConfirmedRow[]
  clusters: ClusterRow[]
}

/** 콘텐츠 상세: 확정 타임스탬프 + 제보 클러스터(미달 포함). 없으면 null. */
export async function getContentDetail(pcId: number): Promise<ContentDetail | null> {
  const pcRows = await db.select().from(platformContents).where(eq(platformContents.id, pcId)).limit(1)
  if (pcRows.length === 0) return null
  const pc = pcRows[0]

  const subs = await db
    .select({ atSeconds: submissions.atSeconds, sessionId: submissions.sessionId })
    .from(submissions)
    .where(eq(submissions.platformContentId, pcId))

  const confirmed = await db
    .select({
      atSeconds: confirmedTimestamps.atSeconds,
      confidence: confirmedTimestamps.confidence,
      reportCount: confirmedTimestamps.reportCount,
      source: confirmedTimestamps.source,
      status: confirmedTimestamps.status,
    })
    .from(confirmedTimestamps)
    .where(eq(confirmedTimestamps.platformContentId, pcId))
    .orderBy(confirmedTimestamps.atSeconds)

  const clusters: ClusterRow[] = buildClusters(subs).map((cl) => ({
    ...cl,
    confirmed: cl.sessionCount >= MIN_SESSIONS,
  }))

  return {
    id: pc.id,
    platform: pc.platform,
    contentId: pc.contentId,
    movieId: pc.movieId,
    submissionCount: subs.length,
    sessionCount: new Set(subs.map((s) => s.sessionId)).size,
    confirmed,
    clusters,
  }
}
