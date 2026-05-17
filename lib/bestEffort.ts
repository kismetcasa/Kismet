/**
 * Run a fire-and-forget promise whose failure is non-blocking but worth
 * knowing about — replaces `.catch(() => {})` on best-effort write paths
 * so a misconfigured Redis or rate-limited upstream surfaces in operator
 * logs instead of silently dropping the side-effect.
 *
 * Use for writes whose primary work has already succeeded (mint relayed
 * upstream, session set in cookie, listing created) and the secondary
 * write is bookkeeping (KV mirror, notification fanout, set membership).
 * Do NOT use for reads where the falsy/empty fallback IS the correct
 * answer — those should keep their `.catch(() => null)` and not log on
 * every unauth'd request.
 *
 * `scope` tags the log line for grep (e.g. `[mint-proxy.markCreatedMint]`).
 * Optional `context` becomes structured metadata in the trailing JSON.
 *
 * Returns the promise's resolved value on success, `undefined` on failure
 * — same shape callers relied on with `.catch(() => {})`, plus the log.
 *
 * Format:
 *   [scope] best-effort failed: <message> { ...context }
 *
 * If/when a structured logger (pino, winston) is adopted later, the body
 * here is the only place that changes — call sites stay identical.
 */
export async function bestEffort<T>(
  promise: Promise<T>,
  scope: string,
  context?: Record<string, unknown>,
): Promise<T | undefined> {
  try {
    return await promise
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[${scope}] best-effort failed: ${detail}`, context ?? {})
    return undefined
  }
}
