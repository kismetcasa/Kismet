// Pure splits-allocation math: builds the on-chain SplitMain recipient array
// from the creator's collaborators + the optional residencies donation.
// Extracted from MintForm so it can be unit-verified (scripts/verify-mint.ts)
// and reused without importing a React component. IMPORT-FREE on purpose — it
// must load under `node --experimental-strip-types` in CI, so it pulls in no
// redis/viem deps.
//
// MODEL — "subtraction", not scaling: collaborators receive EXACTLY the whole
// percent the creator typed; the residencies cut (when on) comes out of the
// CREATOR's share; the creator receives whatever remains. Everything is whole
// percents summing to exactly 100 with no rounding — so what the mint form
// shows in its rows is byte-for-byte what mints (no "scaled to 95%" surprise,
// which is why the form needs no separate preview line). inprocess's splits
// endpoint requires INTEGER `percentAllocation` summing to EXACTLY 100; this
// guarantees it structurally.

export interface Split {
  address: string
  percentAllocation: number
}

// 0xSplits' SplitMain requires `accounts` sorted ascending by address.
// Lowercase-compare on the hex string gives the same ordering as numeric
// ascending for properly-formed addresses.
export function sortSplits(s: Split[]): Split[] {
  return [...s].sort((a, b) => {
    const al = a.address.toLowerCase()
    const bl = b.address.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })
}

// Build the final splits array MintForm sends to inprocess.
//
//   `collaborators` — the creator's custom recipients (creator NOT included),
//                     each a whole percent 1..100 the creator typed verbatim.
//   `p`             — residenciesPercent (whole percent), applied only when
//                     `residenciesEnabled`; it is the creator's donation, taken
//                     from the creator's own share.
//
// Returns integers summing to EXACTLY 100, or `undefined` when there is no
// on-chain split to make (the caller then uses payoutRecipient = creator):
//
//   no collaborators + residencies off      -> undefined (creator keeps 100%)
//   no collaborators + residencies on        -> [creator 100−p, residencies p]
//   collaborators, creator keeps a remainder  -> [...collaborators, creator r, (residencies p)]
//   collaborators, creator remainder hits 0   -> [...collaborators, (residencies p)]
//   a lone collaborator at 100% (no residencies) -> undefined (<2 recipients;
//        the mint form blocks this state, so it never reaches a real mint)
//
// Precondition the caller guarantees (over-allocation guard): collaborators
// sum to ≤ 100 − p, so the creator's remainder is never negative.
export function computeFinalSplits(
  collaborators: Split[],
  residenciesEnabled: boolean,
  residenciesPercent: number,
  creatorAddress: string,
  residenciesAddress: string,
): Split[] | undefined {
  const collabTotal = collaborators.reduce((s, r) => s + r.percentAllocation, 0)
  const residenciesCut = residenciesEnabled ? residenciesPercent : 0
  const creatorShare = 100 - collabTotal - residenciesCut

  const arr: Split[] = [...collaborators]
  if (creatorShare > 0) arr.push({ address: creatorAddress, percentAllocation: creatorShare })
  if (residenciesCut > 0) arr.push({ address: residenciesAddress, percentAllocation: residenciesCut })

  // Fewer than two recipients → no SplitMain deploy. Either the creator keeps
  // 100% (use payoutRecipient), or it's the lone-collaborator-at-100% state
  // the form already blocks. Returning undefined routes to payoutRecipient.
  if (arr.length < 2) return undefined
  return sortSplits(arr)
}
