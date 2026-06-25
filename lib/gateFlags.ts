/**
 * Normalize a Redis-stored boolean flag (`kismetart:gate:enabled`,
 * `:platform:paused`) to a boolean.
 *
 * WHY THIS EXISTS: Upstash's REST client sends SET args as strings unchanged
 * but JSON-PARSES GET results, so a flag written as `'1'` reads back as the
 * NUMBER `1`. A naive `raw === '1'` is then always false for a set flag — the
 * toggle silently never persists. That shipped to production once ("Fix
 * platform-paused/gate flags not persisting", 2026-05-24); this normalization
 * is the fix, and scripts/verify-gate-flags.ts pins both representations so it
 * can't regress.
 *
 * Kept import-clean so it's unit-testable under --experimental-strip-types
 * (gate.ts itself pulls in redis/kv and can't be loaded by the verify harness).
 */
export function isFlagSet(raw: string | number | null | undefined): boolean {
  return String(raw) === '1'
}
