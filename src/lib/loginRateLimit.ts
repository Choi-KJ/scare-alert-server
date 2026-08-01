// 로그인 무차별 대입(brute-force) 방지.
// IP당 실패 횟수를 세어, 짧은 시간에 너무 많이 실패하면 일정 시간 잠근다.
// (단일 서버 인메모리. 다중 인스턴스/영속 필요 시 DB나 Redis로 이관)

interface Attempt {
  fails: number
  firstAt: number
  lockedUntil: number
}

const store = new Map<string, Attempt>()

const MAX_FAILS = 5 // 이 횟수 이상 실패하면 잠금
const WINDOW_MS = 15 * 60 * 1000 // 실패 카운트 유지 창(15분)
const LOCKOUT_MS = 15 * 60 * 1000 // 잠금 지속(15분)

export interface RateStatus {
  locked: boolean
  retryAfterMs: number
}

/** 현재 이 키(IP)가 잠겨 있는지 확인 */
export function checkLogin(key: string, now = Date.now()): RateStatus {
  const a = store.get(key)
  if (a && a.lockedUntil > now) return { locked: true, retryAfterMs: a.lockedUntil - now }
  return { locked: false, retryAfterMs: 0 }
}

/** 로그인 실패 기록. 창을 넘겼으면 리셋 후 시작. 임계치 도달 시 잠금. */
export function recordFailure(key: string, now = Date.now()): void {
  let a = store.get(key)
  if (!a || now - a.firstAt > WINDOW_MS) {
    a = { fails: 0, firstAt: now, lockedUntil: 0 }
  }
  a.fails += 1
  if (a.fails >= MAX_FAILS) a.lockedUntil = now + LOCKOUT_MS
  store.set(key, a)
}

/** 로그인 성공 시 해당 키의 실패 기록 제거 */
export function recordSuccess(key: string): void {
  store.delete(key)
}
