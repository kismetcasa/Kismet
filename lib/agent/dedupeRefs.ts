/**
 * Collapse moment refs to one per on-chain identity, preserving first-seen order.
 *
 * A "collect these N" basket is a SET of distinct moments, but the agent supplies a
 * raw list. A repeated moment (an LLM repeating an id, a link pasted twice, a
 * duplicated discovery row) would otherwise build two mint calls for the same token:
 * on the atomic Base Account the agent path requires, the second reverts on the
 * per-wallet cap and EIP-5792 atomicity cascades the WHOLE basket; on an open edition
 * (no cap) it silently double-charges. The autonomous scout already dedupes
 * (discoverCore + engine.planRun) — this is the same rule for the co-pilot route.
 *
 * The identity key is the canonical on-chain pair: lowercased collection address +
 * the tokenId string. Callers MUST pass a canonical base-10 tokenId — parseMomentRef
 * already normalizes it (BigInt(id).toString()) — so semantically-equal refs collapse:
 * checksum vs lowercase address, "1" vs "01", and the url-form vs explicit-form that
 * resolve to the same moment.
 *
 * Pure and dependency-free (no `@/` imports, no I/O) so it is unit-verifiable
 * network-free by scripts/verify-agent-collect-batch.ts. Generic over the ref shape so
 * the route can dedupe its parsed refs upstream of any on-chain read or call building.
 * Returns the SAME element references in first-seen order (never a copy), so it is a
 * faithful subsequence of the input.
 */
export function dedupeMomentRefs<T extends { collection: string; tokenId: string }>(
  refs: readonly T[],
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const ref of refs) {
    const key = `${ref.collection.toLowerCase()}:${ref.tokenId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}
