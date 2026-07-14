import { AgentOnboarding } from '@/components/AgentOnboarding'
import { SITE_URL } from '@/lib/siteUrl'

export const metadata = {
  title: 'AI agent — Kismet',
  description:
    'Use Kismet from your AI assistant. Connect Base MCP and collect, buy, and list moments by chatting — every action approved in your Base Account.',
  alternates: { canonical: `${SITE_URL}/agent` },
}

// Onboarding for the per-action Base MCP agent. The agent runs in the user's own
// assistant; Kismet exposes the prepare endpoints (/api/agent/*) + the served
// skill (/agent-skill/SKILL.md). This page is the human setup path.
export default function AgentPage() {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12">
      <AgentOnboarding />
    </div>
  )
}
