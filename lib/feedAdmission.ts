// Off-platform admission rule for the strict Mints scope (scope=standalone).
//
// The created-mints registry only records mints made through Kismet's own
// relay (lib/mint-proxy) and Create-Collection covers, so a moment minted
// into a Kismet-tracked collection from ANOTHER In Process client (e.g.
// inprocess.world directly) passed every other feed gate yet was silently
// dropped from the home + trending tabs — while the artist's profile (scope
// 'all') still showed it. Confirmed in production 2026-08-11
// (0x4dd71c80…8f66:2, off-platform GIF with Kismet collects, invisible in
// both tabs).
//
// Policy: a NON-member moment is admitted when its created_at is on/after a
// fixed platform epoch. Everything before the epoch keeps the original
// strict behavior (membership required), so the pre-Kismet "legacy moments"
// the scope was built to exclude stay excluded; everything after it follows
// the product rule "a Kismet artist's new work surfaces regardless of which
// In Process client minted it". A fixed epoch — rather than a per-collection
// registration stamp — needs zero extra reads on the hot path and cannot
// fail closed for collections whose meta record predates the deploy-time
// createdAt stamp (or was registered bare, without meta).
//
// Only on-chain-authorized artists can mint into a tracked collection, so
// admission cannot be triggered by anything an unauthenticated caller
// controls; the residual is that off-platform minting follows In Process's
// rate limits rather than Kismet's quotas (the hide-user/collection/moment
// levers remain the moderation backstop). An In Process reindex-on-edit can
// bump a meta-less legacy row's created_at past the epoch and admit it —
// rare, permanent, and defensible (the artist actively touched the piece);
// Kismet-minted rows are immune via their moment-meta createdAt pin.
//
// Epoch choice: 2026-08-01 — covers the incident window (the August
// cross-posts that surfaced the gap) without re-litigating deeper history.
// Moving it earlier deliberately admits more history; the timeline route
// materializes every admission into created-mints, so moves are one-way.
export const OFFPLATFORM_ADMISSION_EPOCH_MS = Date.parse('2026-08-01T00:00:00Z')

/**
 * Should a moment ABSENT from created-mints surface in the Mints scope
 * anyway? True iff created_at parses to an instant at/after the epoch.
 * Absent/unparseable created_at fails closed (excluded — the original
 * behavior), mirroring the fail-closed contract of the other browse filters.
 */
export function admitsOffPlatformMint(createdAt: string | undefined | null): boolean {
  if (!createdAt) return false
  const t = Date.parse(createdAt)
  return Number.isFinite(t) && t >= OFFPLATFORM_ADMISSION_EPOCH_MS
}
