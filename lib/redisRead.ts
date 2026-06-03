// Standardized Redis-failure handling for SSR + API paths.
//
// Two helpers, two contracts:
//   safeRead   → returns `fallback` on failure (use when an empty/null/false
//                degrades gracefully and a thrown error would 500 the page)
//   strictRead → re-throws on failure (use when silently substituting is
//                wrong — e.g. privacy gates — and the error boundary should
//                catch it instead)
//
// Both log the failure with a uniform `[redis]` prefix so Upstash failure
// rate is grep-able from one place. Never wrap non-idempotent commands
// (INCR, ZINCRBY) in any retry above @upstash/redis's own 5x exp backoff —
// the SDK retries blindly and would silently double-count. Counters
// belong behind explicit idempotency keys, not behind these helpers.

function isTransient(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; name?: string }
  const code = e?.code ?? e?.cause?.code
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    // Upstash REST throws TypeError on fetch failure (e.g. DNS, abort).
    e?.name === 'TypeError'
  )
}

function logFailure(label: string, err: unknown, fallbackTaken: boolean): void {
  const e = err as { code?: string; cause?: { code?: string }; name?: string; message?: string }
  console.error('[redis] failed', {
    label,
    error_code: e?.code ?? e?.cause?.code ?? 'unknown',
    error_class: e?.name ?? 'Error',
    transient: isTransient(err),
    fallback_taken: fallbackTaken,
    message: e?.message,
  })
}

export async function safeRead<T>(
  label: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    logFailure(label, err, true)
    return fallback
  }
}

export async function strictRead<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    logFailure(label, err, false)
    throw err
  }
}
