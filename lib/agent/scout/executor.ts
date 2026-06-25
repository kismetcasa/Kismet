import type { Candidate, Scout } from './engine'

/**
 * The custody-agnostic execution seam for Scouts. The engine (./engine.ts)
 * decides WHAT to collect; an executor performs the funded mint. Keeping this an
 * interface is the "foundation for scale" choice — the engine is unchanged
 * whichever executor we use.
 *
 * Chosen path: the SpendPermissionExecutor (serverExecutor.ts →
 * `createSpendPermissionExecutor`), per the Base "Use Spend Permissions" doc.
 * The user grants a bounded Spend Permission to
 * KISMET's server-controlled spender; per collect the spender pulls EXACTLY the
 * cost via SpendPermissionManager.spend() and mints to the user — within the
 * on-chain allowance, no per-collect approval. Two spender impls sit behind it
 * (spender.ts): the lean own-key EOA and the canonical gasless CDP smart account.
 * Bounded + revocable, so max loss = the remaining period allowance.
 *
 *   - (proposeOnly): no executor — the plan is surfaced for one-tap approval.
 *
 * (Superseded: the earlier Base Sub Account executor — that path needed unproven
 * headless sub-account signing; the documented agentic primitive is the spender
 * above. No connector sub-account is used anywhere now.)
 *
 * Implementations live behind this interface and are the ONLY place signing
 * keys / paymasters / on-chain execution touch the flow. They must mint with
 * mintTo = scout.owner (the user's main account), preserve the builder code +
 * Zora referral (reuse the prepare-collect builders), and record via /api/collect.
 */
export interface ScoutExecutor {
  /** Execute one approved collect under the scout's budget. Returns the tx hash
   *  of the on-chain mint (which /api/collect then verifies) and the number of
   *  editions actually minted (1 unless a multi-edition top-up on an atomic
   *  spender). */
  collect(scout: Scout, candidate: Candidate): Promise<{ txHash: `0x${string}`; quantity: bigint }>
}
