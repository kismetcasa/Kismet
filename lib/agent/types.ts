/**
 * Shared types for the Agent Actions API (`/api/agent/*`).
 *
 * These endpoints return *inert* artifacts — unsigned EIP-5792 call batches
 * and/or EIP-712 typed data — that an AI assistant hands to Base MCP
 * (`send_calls` / `sign`) for the user to approve in their Base Account. The
 * artifacts move no funds until the user signs them, so the prepare endpoints
 * are safe to expose without auth. See AGENT_COMMERCE_DESIGN.md.
 */

export type AgentChain = 'base'

export type AgentVerb = 'collect' | 'buy' | 'list' | 'mint'

/** One call in an EIP-5792 `send_calls` batch. `value` is a JSON-safe decimal
 *  string of native wei ('0' when none) since JSON can't carry a bigint. */
export interface AgentCall {
  to: `0x${string}`
  data: `0x${string}`
  value: string
}

/** What the assistant should POST/PATCH *after* the user approves, to record
 *  the action in Kismet's off-chain stores. The body mirrors what the web app
 *  posts; any `<...>` placeholder must be filled from the executed result. */
export interface AgentRecordHint {
  method: 'POST' | 'PATCH'
  url: string
  bodyTemplate: Record<string, unknown>
}

export interface AgentActionEnvelope {
  chain: AgentChain
  action: AgentVerb
  /** EIP-5792 batch for `send_calls` (collect, buy, list-approval). */
  calls?: AgentCall[]
  /** EIP-712 typed data for `sign` (list order, mint intent). */
  typedData?: unknown
  /** Human-readable one-liner to show the user before requesting approval. */
  summary: string
  /** Follow-up record call to make after approval. */
  record?: AgentRecordHint
  /** Spend ceiling the agent should honor (and surface to the user). */
  caps?: { maxValue: string; currency: 'eth' | 'usdc' }
}
