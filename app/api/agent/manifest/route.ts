import { NextRequest, NextResponse } from 'next/server'
import { getAgentManifest } from '@/lib/agent/manifest'

export const runtime = 'nodejs'

/**
 * Machine-readable capability manifest for the Kismet Agent Actions API. A
 * generic Base MCP agent can GET this to self-configure (chain, contracts,
 * verbs, record endpoints, safety) without the full skill.
 */
export async function GET(req: NextRequest) {
  const origin = new URL(req.url).origin
  return NextResponse.json(getAgentManifest(origin), {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
