import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/client'
import { confirmedTimestamps, platformContents } from '../db/schema'

// GET /api/timestamps?platform=<>&contentId=<> — 확장이 재생 중 확정 타임스탬프를 조회.
// (Spring의 @GetMapping + @RequestParam 자리)

export const timestampsRoute = new Hono()

timestampsRoute.get('/', async (c) => {
  const platform = c.req.query('platform')
  const contentId = c.req.query('contentId')
  if (!platform || !contentId) {
    return c.json({ error: 'platform and contentId are required' }, 400)
  }

  const pc = await db
    .select({ id: platformContents.id })
    .from(platformContents)
    .where(and(eq(platformContents.platform, platform), eq(platformContents.contentId, contentId)))
    .limit(1)

  if (pc.length === 0) {
    return c.json({ platform, contentId, points: [] })
  }

  const points = await db
    .select({
      at: confirmedTimestamps.atSeconds,
      confidence: confirmedTimestamps.confidence,
      reportCount: confirmedTimestamps.reportCount,
    })
    .from(confirmedTimestamps)
    .where(eq(confirmedTimestamps.platformContentId, pc[0].id))

  return c.json({ platform, contentId, points })
})
