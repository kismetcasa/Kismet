/**
 * Pure helpers for the Pass-gate identity union — the wallet set whose Pass
 * validity may authorize a single caller (see expandToGateWallets in
 * lib/addressUnion.ts and hasGateAccess in lib/gate.ts).
 *
 * Redis-free by design, same pattern as lib/gateFlags: the verify harness
 * (scripts/verify-pass-union.ts, node --experimental-strip-types) can pin
 * these semantics without loading the redis-backed gate modules.
 */

/**
 * Hard ceiling on how many wallets one gate decision may check. Each wallet
 * past the ledger prefilter costs a full hasValidPass (Redis reads + one
 * balanceOfBatch RPC), so an unbounded FC verification list must not be able
 * to fan a single mint request out into dozens of RPC calls. Real users hold
 * 1-3 verified wallets (see lib/addressUnion.ts); 10 is far above that while
 * keeping the worst case bounded. Deterministic truncation: the caller stays
 * first, then FC-API order — a pass held beyond position 10 degrades to
 * "denied", never to an error.
 */
export const MAX_UNION_WALLETS = 10

/**
 * Normalize a candidate wallet union into the list the gate will actually
 * check: lowercased, deduped keeping first-seen order (the caller is expected
 * first and stays first), empty/null entries dropped, capped at
 * MAX_UNION_WALLETS.
 */
export function planUnionCheck(addresses: (string | null | undefined)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of addresses) {
    if (!raw) continue
    const lower = raw.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(lower)
    if (out.length >= MAX_UNION_WALLETS) break
  }
  return out
}

/**
 * Parse a stored valid-balance ledger value. Upstash's REST client SETs
 * numbers as strings but its GET JSON-parses numeric strings back to numbers,
 * so both `'2'` and `2` must read as 2 (the same dual-representation trap
 * lib/gateFlags guards for the gate's enable flag). Unparseable values read
 * as 0, and the result is clamped at 0 — the stored value may briefly be
 * negative from out-of-order webhook events, and callers must never see a
 * negative balance.
 */
export function parseLedgerBalance(v: unknown): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : parseInt(String(v), 10) || 0
  return Math.max(0, n)
}
