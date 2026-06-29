// Guards lib/chainHealth.isChainStalled — the liveness probe that decides
// whether a failed deploy/mint shows "Base isn't responding (wait)" vs. an
// eager retry.
//
// THE BUG IT GUARDS: a wrong answer here is costly in both directions. A false
// POSITIVE tells a user the chain is down when it's a one-off blip (and hides
// the retry); a false NEGATIVE sends them to retry into a real stall, queuing
// duplicate mempool txs that all mine on recovery. The contract: forward
// progress = live; no progress (flat or regressing head) = stalled; any read
// error = fail-OPEN (not stalled) so a flaky RPC never masquerades as a halt.
//
// Run: node --experimental-strip-types scripts/verify-chain-health.ts

import type { PublicClient } from 'viem'
import { isChainStalled } from '../lib/chainHealth.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

// Mock client that returns successive block numbers from a list. sampleMs=0 in
// the calls below makes the internal sampling delay instant.
const client = (heads: bigint[]): PublicClient => {
  let i = 0
  return {
    getBlockNumber: async () => heads[Math.min(i++, heads.length - 1)],
  } as unknown as PublicClient
}
const throwing = (): PublicClient =>
  ({
    getBlockNumber: async () => {
      throw new Error('rpc unreachable')
    },
  } as unknown as PublicClient)

check('advancing head -> live (not stalled)', (await isChainStalled(client([100n, 101n]), 0)) === false)
check('flat head -> stalled', (await isChainStalled(client([100n, 100n]), 0)) === true)
check('regressing head -> stalled', (await isChainStalled(client([100n, 99n]), 0)) === true)
check('read error -> fail-open (not stalled)', (await isChainStalled(throwing(), 0)) === false)

if (failures > 0) {
  console.error(`\n${failures} chain-health check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll chain-health checks passed.')
