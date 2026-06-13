/**
 * Pure composition of an autonomous collect (Phase 2). No SDK, no network — so
 * it's unit-verifiable (scripts/verify-agent-scout-server.ts).
 *
 * The one novel ordering rule: the Spend Permission `spend()` calls (which pull
 * the exact cost from the user's Base Account into the spender) run FIRST, then
 * the (approve +) mint runs — minting to the user. The mint calls come from the
 * shared `buildCollectBatchPlan` builder, so KISMET_REFERRAL + the builder suffix
 * are preserved and the agent path stays byte-identical to the web path.
 */

import type { AgentCall } from '@/lib/agent/types'
import type { SpenderCall } from './spender'

/** EIP-5792 AgentCall (hex value) → on-chain SpenderCall (wei bigint). */
function agentCallToSpenderCall(c: AgentCall): SpenderCall {
  return { to: c.to, data: c.data, value: BigInt(c.value) }
}

/**
 * Order: [spend() (+ one-time approveWithSignature)] then [(approve +) mint].
 * `spendCalls` are already-converted SpenderCalls (from prepareSpendCallData);
 * `mintCalls` are the AgentCalls from buildCollectBatchPlan.
 */
export function composeScoutCollect(
  spendCalls: readonly SpenderCall[],
  mintCalls: readonly AgentCall[],
): SpenderCall[] {
  return [...spendCalls, ...mintCalls.map(agentCallToSpenderCall)]
}
