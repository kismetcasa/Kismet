// Consistency check for the Kismet Base MCP skill (agent-skill/*).
//
// A skill that points an agent at endpoints or tools that don't exist is worse
// than no skill. This asserts every API path the skill mentions resolves to a
// real route file, every verb reference names its prepare endpoint, and the
// skill only uses real Base MCP tool names.
//
// Run: node scripts/verify-agent-skill.mjs

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
// Served statically from public/ so the manifest's ${origin}/agent-skill/SKILL.md
// URL resolves for a self-onboarding agent.
const SKILL_DIR = join(ROOT, 'public', 'agent-skill')
const REF_DIR = join(SKILL_DIR, 'references')

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}

const refFiles = readdirSync(REF_DIR).filter((f) => f.endsWith('.md'))
const files = ['SKILL.md', ...refFiles.map((f) => `references/${f}`)]
const texts = Object.fromEntries(files.map((f) => [f, readFileSync(join(SKILL_DIR, f), 'utf8')]))
const all = Object.values(texts).join('\n')

// 1. Every /api/agent/<seg> mentioned must have a route file.
console.log('agent endpoints referenced by the skill exist')
// Filter out glob/placeholder captures like `prepare-*` (the prose shorthand),
// which the regex truncates to a trailing-hyphen segment. Real route segments
// never end with '-'.
const segs = [...new Set([...all.matchAll(/\/api\/agent\/([a-z-]+)/g)].map((m) => m[1]))].filter((s) => !s.endsWith('-'))
check('skill references at least the core endpoints', segs.length >= 4, segs.join(', '))
for (const seg of segs) {
  check(`/api/agent/${seg} → app/api/agent/${seg}/route.ts`, existsSync(join(ROOT, 'app', 'api', 'agent', seg, 'route.ts')))
}

// 2. Record / existing endpoints the skill points at.
console.log('\nrecord endpoints exist')
check('/api/collect', existsSync(join(ROOT, 'app', 'api', 'collect', 'route.ts')))
check('/api/listings', existsSync(join(ROOT, 'app', 'api', 'listings', 'route.ts')))
check('/api/listings/{id} → app/api/listings/[id]/route.ts', existsSync(join(ROOT, 'app', 'api', 'listings', '[id]', 'route.ts')))

// 3. Each verb reference names its prepare endpoint.
console.log('\nverb references name their prepare endpoint')
for (const verb of ['collect', 'buy', 'list']) {
  const t = texts[`references/${verb}.md`] || ''
  check(`references/${verb}.md exists`, !!texts[`references/${verb}.md`])
  check(`references/${verb}.md names /api/agent/prepare-${verb}`, t.includes(`/api/agent/prepare-${verb}`))
}

// 4. SKILL.md ties in manifest + discover.
console.log('\nSKILL.md entry points')
check('mentions /api/agent/manifest', texts['SKILL.md'].includes('/api/agent/manifest'))
check('mentions /api/agent/discover', texts['SKILL.md'].includes('/api/agent/discover'))

// 5. Only real Base MCP tool names; no hallucinated variants.
console.log('\nBase MCP tool names')
for (const tool of ['get_wallets', 'send_calls', 'sign']) {
  check(`uses ${tool}`, new RegExp(`\\b${tool}\\b`).test(all))
}
for (const bad of ['eth_sendTransaction', 'wallet_sendCalls(', 'sendTransaction(', 'sendCalls(']) {
  check(`no hallucinated tool "${bad}"`, !all.includes(bad))
}

console.log(`\n${failures === 0 ? 'OK — skill is internally consistent' : `FAILED — ${failures} issue(s)`}`)
process.exit(failures === 0 ? 0 : 1)
