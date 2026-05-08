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
  '0x6A0bA3707dF9D13A4445cD7E04274B2725930cD7'

// Kismet Casa residencies wallet — receives 5% of primary sale revenue when the
// creator opts in at mint time via the residencies toggle.
export const RESIDENCIES_ADDRESS =
  process.env.NEXT_PUBLIC_RESIDENCIES_ADDRESS ||
  '0x58f19e55058057B04feAe2EEA88F90B84b7714Eb'

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
