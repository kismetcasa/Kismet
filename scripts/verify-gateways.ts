// Verifies the Arweave/IPFS gateway pool stays consistent with next.config's
// image `remotePatterns` allowlist, and that gatewayUrls emits the expected URLs.
//
// THE BUG IT GUARDS: a gateway in lib/arweave/gateways.ts but MISSING from
// next.config remotePatterns means next/image silently refuses to optimize it
// (broken covers); leaving a dead host in the pool (e.g. arweave.dev going
// NXDOMAIN) wastes every fallback probe. This locks pool hosts to the allowlist.
//
// Run: node --experimental-strip-types scripts/verify-gateways.ts

import { readFileSync } from 'node:fs'
import { gatewayUrls } from '../lib/arweave/gateways.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

check('gatewayUrls ar:// -> arweave.net', eq(gatewayUrls('ar://X'), ['https://arweave.net/X']), JSON.stringify(gatewayUrls('ar://X')))
check('gatewayUrls ipfs:// -> ipfs.io + dweb.link', eq(gatewayUrls('ipfs://Y'), ['https://ipfs.io/ipfs/Y', 'https://dweb.link/ipfs/Y']))
check('gatewayUrls https:// passthrough', eq(gatewayUrls('https://x.com/a.png'), ['https://x.com/a.png']))
check('gatewayUrls empty -> []', eq(gatewayUrls(''), []))

// Pool hosts must all be allowlisted in next.config remotePatterns.
const poolHosts = [...new Set([...gatewayUrls('ar://X'), ...gatewayUrls('ipfs://Y')].map((u) => new URL(u).host))]
const cfg = readFileSync(new URL('../next.config.mjs', import.meta.url), 'utf8')
const allowed = new Set([...cfg.matchAll(/hostname:\s*'([^']+)'/g)].map((m) => m[1]))
for (const host of poolHosts) {
  check(`remotePatterns allowlists gateway host '${host}'`, allowed.has(host), `allowlist: ${[...allowed].join(', ')}`)
}

if (failures > 0) {
  console.error(`\n${failures} gateway check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll gateway checks passed.')
