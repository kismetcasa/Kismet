'use client'

import Link from 'next/link'
import { useSmartWalletAgentEligibility } from '@/hooks/useSmartWalletAgentEligibility'

/**
 * Owner-profile entry to the Base MCP skill — the per-action "use Kismet from your
 * own AI assistant" agent (the human setup page lives at /agent). Gated to Base
 * Account (smart-wallet) owners, the SAME audience that can actually use it, and
 * mounted beside AgentCollectPanel so both agent surfaces live in one place. This
 * replaces the former global "Agent" nav tab, which rendered for everyone — EOAs
 * and visitors included — even though only Base Account holders can use the agent.
 *
 * Owner-only mounting is done by the caller (ProfileView); this self-gates on
 * eligibility and returns null otherwise, so a non–Base-Account owner sees nothing.
 */
export function AgentSkillCard() {
  const { eligible, loading } = useSmartWalletAgentEligibility()
  if (loading || !eligible) return null
  return (
    <Link
      href="/agent"
      className="block border border-line bg-surface/40 px-4 py-3 hover:border-dim transition-colors"
    >
      <p className="text-[10px] font-mono uppercase tracking-wider text-dim mb-1">
        Use from your AI assistant
      </p>
      <p className="text-xs font-mono text-ink leading-relaxed">
        Connect Base MCP and collect, buy, and list moments by chatting — every action
        approved in your Base Account.
      </p>
    </Link>
  )
}
