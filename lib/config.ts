// Platform collection on Base — all mints go here, Discover filters by it.
// Override with NEXT_PUBLIC_PLATFORM_COLLECTION env var for alternate deployments.
export const PLATFORM_COLLECTION =
  process.env.NEXT_PUBLIC_PLATFORM_COLLECTION ||
  '0x349D3DA472BDD2FBeebf8e0bBAF4220160A62526'

// Referral address — Kismet platform treasury that receives:
// - createReferral cut from Zora when a collection is deployed via the factory
// - mintReferral cut from Zora on every direct collect (see lib/zoraMint.ts
//   KISMET_REFERRAL — kept in lockstep with this address)
// Override per-deployment with NEXT_PUBLIC_CREATE_REFERRAL.
export const CREATE_REFERRAL =
  process.env.NEXT_PUBLIC_CREATE_REFERRAL ||
  '0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75'

// Kismet Casa residencies wallet — receives a creator-chosen cut of primary
// sale revenue when the creator opts in at mint time via the residencies toggle.
export const RESIDENCIES_ADDRESS =
  process.env.NEXT_PUBLIC_RESIDENCIES_ADDRESS ||
  '0x58f19e55058057B04feAe2EEA88F90B84b7714Eb'

// Default residencies cut (whole percent) pre-filled when the toggle is on.
// The creator can edit it to any integer 1–99 (capped lower when custom splits
// leave less room — see MintForm buildFinalSplits).
export const DEFAULT_RESIDENCIES_PERCENT = 5

// Inprocess operator smart wallet — the CDP smart account used for the
// platform's ADMIN-level relayed calls (airdrop / distribute / admin writes)
// made under our INPROCESS_API_KEY.
//
// IMPORTANT — this is NOT the executor of a creator's own mints. A creator's
// /moment/create runs as THAT creator's per-creator inprocess smart wallet
// (provisioned by inprocess on the creator's first mint), not this operator.
// Verified on-chain: a live, actively-minting user collection has
// permissions(0, operator)=0 yet its mints succeed — because the per-creator
// smart wallet holds ADMIN, not this wallet. Do not "fix" the mint preflight
// (lib/smartWalletPreflight.ts) to read this operator instead.
//
// Each user-deployed collection still grants this wallet ADMIN at deploy so the
// admin-mint flows (notably airdrop) route through it cleanly without requiring
// per-artist API keys. The boot healthcheck (lib/healthcheck.ts) asserts this
// wallet has ADMIN on PLATFORM_COLLECTION (the platform's own admin-mint
// collection); this constant extends that identity to user collections.
//
// Server-only OPERATOR_SMART_WALLET stays in place for the healthcheck.
// Public mirror is required because CreateCollectionForm runs in the
// browser and bakes the address into setupActions at deploy time.
// Both env vars must hold the same address; mismatch is a config bug
// surfaced by the lib/healthcheck assertion at boot.
export const OPERATOR_SMART_WALLET =
  process.env.NEXT_PUBLIC_OPERATOR_SMART_WALLET ?? ''

export function isOperatorAddress(address: string | undefined | null): boolean {
  if (!address || !OPERATOR_SMART_WALLET) return false
  return address.toLowerCase() === OPERATOR_SMART_WALLET.toLowerCase()
}

// Max recipients per airdrop. Shared by the client form (blocks the on-chain
// tx before it happens) and the server notify route (rejects the record).
// Single source so the two can't drift — a higher client cap would let an
// airdrop mint on-chain and then fail to record, stranding it off-chain.
export const MAX_AIRDROP_RECIPIENTS = 200

// Admin address — single privileged wallet that passes admin-session
// signatures (see lib/curator.ts)
// and is reported as `isAdmin: true` by /api/admin/me. Always
// lowercased to match verifyMessage's recovered-signer comparison.
// Default seeds the platform admin so a missing env var doesn't lock
// privileged routes out after a deploy; override per-environment with
// ADMIN_ADDRESS.
export const ADMIN_ADDRESS: string = (
  process.env.ADMIN_ADDRESS ?? '0x3D140B892437dD7857701098415deB2daaE03A40'
).toLowerCase()

// Curator allowlist — addresses (besides ADMIN_ADDRESS) that can add or
// remove entries from the featured feed. Each curator gets a "Curate"
// section on their own profile page; on the server, /api/featured accepts
// signatures from any address in this list. Comma-separated, lowercased.
// Default seeds the initial curator without requiring an env change.
export const CURATOR_ADDRESSES: readonly string[] = (
  process.env.CURATOR_ADDRESSES ?? '0x3D140B892437dD7857701098415deB2daaE03A40'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
