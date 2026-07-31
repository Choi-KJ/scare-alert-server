import { eq } from 'drizzle-orm'
import { db } from '../db/client'
import { confirmedTimestamps, submissions } from '../db/schema'

// 집계/확정 엔진 (프로젝트의 핵심).
// 흐름: ① 가까운 제보끼리 묶기(±N초) → ② 서로 다른 세션 M개 이상인 묶음만 확정 → ③ 중앙값을 대표 시각으로.

export interface RawReport {
  atSeconds: number
  sessionId: string
}

export interface ConfirmedPoint {
  atSeconds: number // 대표 시각 (클러스터 중앙값)
  reportCount: number // 클러스터 내 총 제보 수
  sessionCount: number // 서로 다른 세션 수
  confidence: number // 신뢰도 0..1 (현재는 세션 수 기반 — 추후 정교화)
}

export interface AggregateOptions {
  /** 이 간격(초) 이내로 이어지는 제보를 한 클러스터로 묶는다 */
  windowSeconds?: number
  /** 확정에 필요한 "서로 다른 세션" 최소 수 (어뷰징 방지 핵심) */
  minSessions?: number
}

// 초기값: N=2초 / M=2. M은 우연·조작 방지를 위해 운영하며 3+로 올리는 걸 권장.
const DEFAULTS: Required<AggregateOptions> = { windowSeconds: 2, minSessions: 2 }

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 순수 함수: 원시 제보 목록 → 확정 지점 목록. DB에 의존하지 않아 단위 테스트가 쉽다.
 */
export function aggregateReports(reports: RawReport[], options: AggregateOptions = {}): ConfirmedPoint[] {
  const { windowSeconds, minSessions } = { ...DEFAULTS, ...options }
  if (reports.length === 0) return []

  const sorted = [...reports].sort((a, b) => a.atSeconds - b.atSeconds)

  // ① 클러스터링: 정렬 후 연속 간격이 windowSeconds를 넘으면 새 묶음 시작
  const clusters: RawReport[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].atSeconds - sorted[i - 1].atSeconds
    if (gap <= windowSeconds) {
      clusters[clusters.length - 1].push(sorted[i])
    } else {
      clusters.push([sorted[i]])
    }
  }

  // ② 서로 다른 세션 M개 이상인 묶음만 확정, ③ 중앙값을 대표 시각으로
  const confirmed: ConfirmedPoint[] = []
  for (const cluster of clusters) {
    const sessions = new Set(cluster.map((r) => r.sessionId))
    if (sessions.size < minSessions) continue // 미달 → 확정 안 함(대기)
    confirmed.push({
      atSeconds: Number(median(cluster.map((r) => r.atSeconds)).toFixed(2)),
      reportCount: cluster.length,
      sessionCount: sessions.size,
      confidence: Math.min(1, sessions.size / (minSessions + 1)),
    })
  }
  return confirmed
}

/**
 * 특정 콘텐츠의 제보를 다시 집계해 confirmed_timestamps를 갱신한다.
 * 전량 재계산(기존 확정 삭제 후 재삽입) — idempotent해서 언제 호출해도 안전.
 */
export async function recomputeConfirmed(
  platformContentId: number,
  options?: AggregateOptions,
): Promise<ConfirmedPoint[]> {
  const rows = await db
    .select({ atSeconds: submissions.atSeconds, sessionId: submissions.sessionId })
    .from(submissions)
    .where(eq(submissions.platformContentId, platformContentId))

  const points = aggregateReports(rows, options)

  await db.delete(confirmedTimestamps).where(eq(confirmedTimestamps.platformContentId, platformContentId))
  if (points.length > 0) {
    await db.insert(confirmedTimestamps).values(
      points.map((p) => ({
        platformContentId,
        atSeconds: p.atSeconds,
        confidence: p.confidence,
        reportCount: p.reportCount,
        status: 'confirmed',
      })),
    )
  }
  return points
}
