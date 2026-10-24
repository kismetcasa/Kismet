// lib/airdropLanded: an airdrop is confirmed from its on-chain mint when the
// wallet's reply never reaches the page (the 2026-10 Zen + Rainbow incident:
// the airdrop landed, the form waited on "Confirm airdrop in wallet…").
//
// Run: node --experimental-strip-types scripts/verify-airdrop-landed.ts

import { matchAirdropTx, watchAirdropLanded, type TransferSingleLike } from '../lib/airdropLanded.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const ZERO = '0x0000000000000000000000000000000000000000' as const
const SENDER = '0x7Ea9000000000000000000000000000000d431Aa' as const
const A = '0xAaaa00000000000000000000000000000000aAaA' as const
const B = '0xbBbb00000000000000000000000000000000BbBb' as const
const TX1 = '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const TX2 = '0x2222222222222222222222222222222222222222222222222222222222222222' as const

const mint = (tx: `0x${string}`, to: `0x${string}`, id: bigint, over: Partial<TransferSingleLike['args']> = {}): TransferSingleLike => ({
  transactionHash: tx,
  args: { operator: SENDER, from: ZERO, to, id, ...over },
})

const want = (recipients: string[]) => ({ tokenId: 2n, recipients, operator: SENDER })

// ── matching ──
check('single recipient, its mint present → that tx', matchAirdropTx([mint(TX1, A, 2n)], want([A])) === TX1)
check('addresses compare case-insensitively', matchAirdropTx([mint(TX1, A.toLowerCase() as `0x${string}`, 2n)], want([A.toUpperCase().replace('0X', '0x')])) === TX1)
check('two recipients in one multicall tx → that tx', matchAirdropTx([mint(TX1, A, 2n), mint(TX1, B, 2n)], want([A, B])) === TX1)
check('recipients split across two txs is not this airdrop', matchAirdropTx([mint(TX1, A, 2n), mint(TX2, B, 2n)], want([A, B])) === null)
check('only part of the list minted → keep waiting', matchAirdropTx([mint(TX1, A, 2n)], want([A, B])) === null)
check('another token id is not a match', matchAirdropTx([mint(TX1, A, 3n)], want([A])) === null)
check('a transfer (from ≠ 0x0) is not a mint', matchAirdropTx([mint(TX1, A, 2n, { from: B })], want([A])) === null)
check('someone else minting to the recipient is not this airdrop', matchAirdropTx([mint(TX1, A, 2n, { operator: B })], want([A])) === null)
check('a pending log without a tx hash is skipped', matchAirdropTx([{ ...mint(TX1, A, 2n), transactionHash: null }], want([A])) === null)
check('extra recipients in the tx still match the requested list', matchAirdropTx([mint(TX1, A, 2n), mint(TX1, B, 2n)], want([A])) === TX1)
check('no logs → null', matchAirdropTx([], want([A])) === null)

// ── watching ──
function client(script: (call: number) => TransferSingleLike[] | Error) {
  let calls = 0
  const seen: unknown[] = []
  return {
    get calls() { return calls },
    seen,
    getLogs: (async (args: unknown) => {
      seen.push(args)
      const r = script(++calls)
      if (r instanceof Error) throw r
      return r
    }) as never,
  }
}

{
  const c = client((n) => (n === 1 ? new Error('rpc 503') : n === 2 ? [] : [mint(TX1, A, 2n)]))
  const stop = new AbortController()
  const hash = await watchAirdropLanded({
    client: c, collection: B, operator: SENDER, tokenId: 2n, recipients: [A], fromBlock: 100n, signal: stop.signal, intervalMs: 1,
  })
  check('watch: an RPC error and an empty poll are waited out; resolves with the mint tx', hash === TX1 && c.calls === 3)
  const q = c.seen[0] as { address: string; fromBlock: bigint; args: { operator: string; from: string } }
  check('watch: queries this collection, from the head read before the prompt, filtered by sender and 0x0', q.address === B && q.fromBlock === 100n && q.args.operator === SENDER && q.args.from === ZERO)
}
{
  const c = client(() => [])
  const stop = new AbortController()
  const p = watchAirdropLanded({
    client: c, collection: B, operator: SENDER, tokenId: 2n, recipients: [A], fromBlock: 1n, signal: stop.signal, intervalMs: 1,
  })
  await new Promise((r) => setTimeout(r, 20))
  stop.abort(new Error('wallet answered'))
  const outcome = await p.then(() => 'resolved', (e: Error) => e.message)
  const callsAtAbort = c.calls
  await new Promise((r) => setTimeout(r, 20))
  check('watch: abort rejects with the reason', outcome === 'wallet answered')
  check('watch: abort stops polling', c.calls === callsAtAbort)
}

console.log(failures === 0 ? '\nAll airdrop-landed checks passed.' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
