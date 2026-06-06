import type { Candidate, RunPlan, Scout } from './engine'

/**
 * The custody-agnostic execution seam for Scouts. The engine (./engine.ts)
 * decides WHAT to collect; an executor performs the funded mint. Keeping this an
 * interface is the "foundation for scale" choice — the engine is unchanged
 * whichever executor we use.
 *
 * Chosen path: SubAccountExecutor (see AGENT_SUBACCOUNT_DESIGN.md). Execution
 * runs under a Base Sub Account the USER owns (universal account is an owner),
 * auto-funded from the parent within a Spend Permission cap. Two modes share it:
 *   - Mode A (browser CryptoKey): in-session, popup-less; no Kismet-held key.
 *   - Mode B (Kismet server key as a sub-account owner): unattended Scouts.
 * Funds never reach a Kismet address; max loss = the remaining cap from a
 * near-empty, user-owned, revocable account.
 *
 *   - (proposeOnly): no executor — the plan is surfaced for one-tap approval.
 *
 * REJECTED: a "KismetSpender" model (Kismet operator as the Spend Permission
 * spender, pulling funds to our own EOA). Same on-chain cap, but it makes Kismet
 * a custodian-in-motion — Sub Accounts achieve the same budget without us ever
 * touching user funds.
 *
 * Implementations live behind this interface and are the ONLY place signing
 * keys / paymasters / on-chain execution touch the flow. They must mint with
 * mintTo = scout.owner (the user's main account), preserve the builder code +
 * Zora referral (reuse the prepare-collect builders), and record via /api/collect.
 */
export interface ScoutExecutor {
  /** Execute one approved collect under the scout's budget. Returns the tx hash
   *  of the on-chain mint (which /api/collect then verifies). */
  collect(scout: Scout, candidate: Candidate): Promise<{ txHash: `0x${string}` }>
}

/** Result of executing a planned run (Auto mode). Pairs each attempted collect
 *  with its outcome so the ledger + budget usage can be updated transactionally. */
export interface ScoutRunResult {
  plan: RunPlan
  executed: Array<{ candidate: Candidate; txHash: `0x${string}` }>
  failed: Array<{ candidate: Candidate; error: string }>
}
