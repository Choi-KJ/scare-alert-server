import { Hono } from 'hono'
import { z } from 'zod'
import { createSubmission } from '../services/submissionService'

// POST /api/submissions — 확장에서 제보를 받는 엔드포인트.
// (Spring의 @RestController + @PostMapping + @Valid @RequestBody 자리)

// Zod 스키마 = 입력 검증 (Spring Bean Validation의 @Valid 역할). 어뷰징 1차 방어선.
const submissionSchema = z.object({
  platform: z.string().min(1).max(32),
  contentId: z.string().min(1).max(128),
  at: z.number().nonnegative(),
  intensity: z.enum(['mild', 'moderate', 'intense']).default('moderate'),
  sessionId: z.string().min(1).max(64),
})

export const submissionsRoute = new Hono()

submissionsRoute.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = submissionSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid payload', details: parsed.error.flatten() }, 400)
  }

  const result = await createSubmission(parsed.data)

  if (result === 'rate_limited') {
    c.header('Retry-After', '5')
    return c.json({ error: 'too many requests' }, 429)
  }
  if (result === 'duplicate') {
    // 멱등 처리 — 이미 접수된 제보라 에러 대신 정상 응답
    return c.json({ ok: true, duplicate: true }, 200)
  }
  return c.json({ ok: true }, 201)
})
