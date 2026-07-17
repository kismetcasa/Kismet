'use client'

/**
 * Onboarding for Kismet's per-action AI agent (the Base MCP surface). The agent
 * lives in the user's own assistant (Claude / ChatGPT / Cursor / …) via Base MCP;
 * Kismet just exposes the prepare endpoints + the skill it reads. So "setup" is:
 * connect Base MCP → point the assistant at Kismet's skill → ask. Every write is
 * approved in the user's Base Account (Kismet never holds keys). Mirrors Base's
 * own "Get Started with Base MCP" flow.
 */

import { useState, type ReactNode } from 'react'
import { SITE_URL } from '@/lib/siteUrl'

const SKILL_URL = `${SITE_URL}/agent-skill/SKILL.md`
const MANIFEST_URL = `${SITE_URL}/api/agent/manifest`
// One-click "add Base MCP as a custom connector" deeplink (Claude); other
// clients add https://mcp.base.org manually.
const ADD_BASE_MCP_CLAUDE =
  'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Base%20MCP&connectorUrl=https%3A%2F%2Fmcp.base.org'
const KISMET_PROMPT = `Use Kismet (an art marketplace on Base) through Base MCP. Open ${SKILL_URL} as your reference and follow it to discover, collect, buy, and list artworks. Run every action through my Base Account for approval.`

const EXAMPLES = [
  'Find new artworks to collect on Kismet under $5',
  'Collect the artwork at <paste a Kismet artwork link>',
  'List my artwork <link> for 0.01 ETH',
]

function CopyButton({ text, label = 'copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
          .catch(() => {})
      }}
      className="shrink-0 text-[10px] font-mono uppercase tracking-wider px-2 py-1 border border-line text-dim hover:border-accent hover:text-accent transition-colors"
    >
      {copied ? 'copied' : label}
    </button>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 border border-line flex items-center justify-center text-xs font-mono text-accent">
        {n}
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <h2 className="text-xs font-mono uppercase tracking-wider text-ink">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function AgentOnboarding() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="text-lg font-mono uppercase tracking-wider text-ink">Collect with your AI assistant</h1>
        <p className="text-xs font-mono text-dim leading-relaxed">
          Connect Base MCP and your assistant can discover, collect, buy, and list artworks on Kismet — you
          approve each action in your Base Account. Kismet never holds your keys.
        </p>
      </header>

      <div className="space-y-6">
        <Step n={1} title="Connect Base MCP">
          <p className="text-xs font-mono text-dim leading-relaxed">
            One tap in Claude, or add <span className="text-muted">https://mcp.base.org</span> as a custom
            connector in ChatGPT, Cursor, or Claude Code. Approve the connection once in your Base Account.
          </p>
          <a
            href={ADD_BASE_MCP_CLAUDE}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs font-mono uppercase tracking-wider px-3 py-2 btn-accent"
          >
            Add Base MCP to Claude
          </a>
        </Step>

        <Step n={2} title="Point it at Kismet">
          <p className="text-xs font-mono text-dim leading-relaxed">Paste this into your assistant:</p>
          <div className="flex items-start gap-2 bg-surface border border-line p-2">
            <code className="flex-1 min-w-0 text-[11px] font-mono text-ink leading-relaxed break-words whitespace-pre-wrap">
              {KISMET_PROMPT}
            </code>
            <CopyButton text={KISMET_PROMPT} />
          </div>
        </Step>

        <Step n={3} title="Ask it to collect">
          <p className="text-xs font-mono text-dim leading-relaxed">Try:</p>
          <ul className="space-y-1.5">
            {EXAMPLES.map((e) => (
              <li key={e} className="text-[11px] font-mono text-muted bg-raised px-2 py-1.5 leading-relaxed">
                “{e}”
              </li>
            ))}
          </ul>
        </Step>
      </div>

      <div className="border-t border-line pt-4 space-y-2">
        <p className="text-[10px] font-mono text-faint leading-relaxed">
          Every collect, buy, and list is prepared by the agent and executed only when you approve it in
          your Base Account. The agent can’t move funds without your tap.
        </p>
        <p className="text-[10px] font-mono text-faint leading-relaxed">
          Advanced: the machine-readable capability manifest is at{' '}
          <a href={MANIFEST_URL} target="_blank" rel="noopener noreferrer" className="text-dim hover:text-accent underline">
            /api/agent/manifest
          </a>
          .
        </p>
      </div>
    </div>
  )
}
