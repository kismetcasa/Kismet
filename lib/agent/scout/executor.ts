import type { Candidate, RunPlan, Scout } from './engine'

/**
 * The custody-agnostic execution seam for Scouts. The engine (./engine.ts)
 * decides WHAT to collect; an executor performs the funded mint. Keeping this
 * an interface is the key "foundation for scale" choice — the same Scout +
 * policy + engine works whichever way we settle custody:
 *
 *   - KismetSpenderExecutor (v1): Kismet's operator is the Spend Permission
 *     `spender`; per collect it calls SpendPermissionManager.spend() to pull
 *     the price from the user's Base Account, then mints with mintTo = the user.
 *     Simplest; the user trusts the operator within the on-chain cap.
 *
 *   - SubAccountExecutor (v2): execution runs under the user's OWN app sub-
 *     account (session key + Auto Spend Permissions), popup-less, minimal
 *     third-party trust.
 *
 *   - (proposeOnly): no executor — the plan is surfaced for one-tap approval.
 *
 * Implementations live behind this interface and are the ONLY place private
 * keys / paymasters / on-chain spend touch the flow. They must mint with
 * mintTo = scout.owner, preserve the builder code + Zora referral (reuse the
 * prepare-collect builders), and record via the existing /api/collect.
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
