/** Reject `p` if it has not settled within `ms`. The timer is cleared either way. */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** Unique marker a budget race answers when `p` is still pending, so it can
 *  never be confused with a real result. */
export const TIMED_OUT: unique symbol = Symbol('timed-out')

/** `p`'s value if it settles within `ms`, else TIMED_OUT — `p` keeps running
 *  (hand it to `after()` when the cache write it makes must survive the response). */
export function withinBudget<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
