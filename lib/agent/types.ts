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

/** One call in an EIP-5792 `send_calls` batch. Per Base MCP's batch-calls
 *  contract, `value` is a **hex-encoded wei quantity** (e.g. `"0x0"`), not a
 *  decimal string — the agent passes these straight into
 *  `send_calls({ chain: "base", calls })`. `to` is required; `data`/`value`
 *  may be `"0x"`/`"0x0"`. */
export interface AgentCall {
  to: `0x${string}`
  data: `0x${string}`
  value: `0x${string}`
}

/** What the assistant should POST/PATCH *after* the user approves, to record
 *  the action in Kismet's off-chain stores. The body mirrors what the web app
 *  posts; any `<...>` placeholder must be filled from the executed result. */
export interface AgentRecordHint {
  method: 'POST' | 'PATCH'
  url: string
  bodyTemplate: Record<string, unknown>
  /**
   * When set, the record call requires a wallet message signature first (via
   * Base MCP's `sign`). Flow: GET `noncePath` → `{ nonce }`; personal_sign the
   * `messageTemplate` with `<nonce>` filled; then send `bodyTemplate` with the
   * `<nonce>` and `<signature>` placeholders filled in. Used by Buy to flip the
   * order-book listing to "filled" (the backend requires a buyer signature so a
   * third party can't mark arbitrary listings sold).
   */
  preSign?: {
    noncePath: string
    messageTemplate: string
    via: 'personal_sign'
  }
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
  /** Batch variant: one record call per item, all against the same txHash
   *  (each /api/collect verifies its own token against the shared receipt). */
  records?: AgentRecordHint[]
  /** Spend ceiling the agent should honor (and surface to the user). */
  caps?: { maxValue: string; currency: 'eth' | 'usdc' }
}
