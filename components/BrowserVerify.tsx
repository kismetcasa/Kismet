'use client'

import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { recomputeDraw } from '@/lib/experience/fairnessWeb'
import { seenCommitment } from '@/lib/experience/seenCommitments'
import type { SnapshotEntry } from '@/lib/experience/types'

/**
 * A play checked in the viewer's own browser, trusting nothing the verify
 * route concluded: the draw is recomputed here with Web Crypto
 * (lib/experience/fairnessWeb), the sealing block is read from Base through
 * the browser's own connection, and the commitment is compared with the one
 * this browser was shown before the play (lib/experience/seenCommitments).
 */

type Entropy = { block: number; hash: string | null; after: number } | null

interface Draw {
  serverSeed: string
  commitment: string
  snapshot: SnapshotEntry[]
  snapshotHash: string
  attempt: number
  entropy: Entropy
  picked: { collection: string; tokenId: string }
}

export interface BrowserVerifyInput extends Draw {
  machineId: string
  epoch: string
  txHash: string
  unitIndex: number
  /** Draws this capsule made before, whose piece was set aside. */
  earlier: (Partial<Draw> & { tokenId: string })[]
}

/** true: checked and holds. false: checked and does not. null: could not be checked here. */
type Verdict = boolean | null
interface Row {
  ok: Verdict
  text: string
}

type Client = ReturnType<typeof usePublicClient>

async function blockHashOnChain(client: Client, n: number): Promise<string | null> {
  if (!client) return null
  try {
    return (await client.getBlock({ blockNumber: BigInt(n) })).hash?.toLowerCase() ?? null
  } catch {
    return null
  }
}

async function check(input: BrowserVerifyInput, client: Client): Promise<Row[]> {
  const rows: Row[] = []
  const draw = await recomputeDraw({ ...input, blockHash: input.entropy?.hash ?? null })
  rows.push({ ok: draw.seed, text: draw.seed ? 'the revealed seed hashes to the commitment' : 'the revealed seed does NOT hash to the commitment' })

  const seen = seenCommitment(input.machineId, input.epoch)
  rows.push(
    seen === null
      ? { ok: null, text: `this browser kept no record of the commitment it was shown for ${input.epoch} — compare it with one you saved` }
      : seen === input.commitment.toLowerCase()
        ? { ok: true, text: `it is the commitment this browser was shown for ${input.epoch}, before the play` }
        : { ok: false, text: `this browser was shown a DIFFERENT commitment for ${input.epoch}: ${seen}` },
  )
  rows.push({ ok: draw.table, text: draw.table ? 'the table hashes to the one committed when the draw was frozen' : 'the table does NOT hash to the one committed at the freeze' })

  if (input.entropy?.hash) {
    const { block, hash } = input.entropy
    const [onChain, receipt] = await Promise.all([
      blockHashOnChain(client, block),
      client?.getTransactionReceipt({ hash: input.txHash as `0x${string}` }).catch(() => null) ?? Promise.resolve(null),
    ])
    rows.push(
      onChain === null
        ? { ok: null, text: `could not read block ${block} from Base in this browser` }
        : onChain === hash.toLowerCase()
          ? { ok: true, text: `block ${block}, read from Base by this browser, is the block that sealed the draw` }
          : { ok: false, text: `block ${block} on Base has a DIFFERENT hash from the one the draw was sealed with` },
    )
    const mintBlock = receipt ? Number(receipt.blockNumber) : null
    rows.push(
      mintBlock === null
        ? { ok: null, text: 'could not read your capsule transaction from Base in this browser' }
        : block > mintBlock
          ? { ok: true, text: `and it came after your capsule's block ${mintBlock}, so no one could know its hash when you paid` }
          : { ok: false, text: `but it is NOT after your capsule's block ${mintBlock}` },
    )
  } else {
    rows.push({ ok: null, text: 'drawn before draws were sealed by a block: the seed and the table decide it alone' })
  }

  rows.push(
    draw.matches
      ? { ok: true, text: `recomputed here, the draw lands on #${input.picked.tokenId} — the artwork delivered` }
      : { ok: false, text: `recomputed here, the draw lands on ${draw.pick ? `#${draw.pick.tokenId}` : 'nothing'}, not the #${input.picked.tokenId} delivered` },
  )

  for (const e of input.earlier) {
    if (!e.serverSeed || !e.commitment || !e.snapshot || !e.snapshotHash) {
      rows.push({ ok: null, text: `the draw before it, which picked #${e.tokenId}, is not revealed yet` })
      continue
    }
    const earlier = await recomputeDraw({
      serverSeed: e.serverSeed,
      commitment: e.commitment,
      snapshot: e.snapshot,
      snapshotHash: e.snapshotHash,
      txHash: input.txHash,
      unitIndex: input.unitIndex,
      attempt: e.attempt ?? 0,
      blockHash: e.entropy?.hash ?? null,
      picked: { collection: e.picked?.collection ?? '', tokenId: e.tokenId },
    })
    const sealed = e.entropy?.hash ? (await blockHashOnChain(client, e.entropy.block)) === e.entropy.hash.toLowerCase() : null
    const ok = earlier.seed && earlier.table && earlier.matches && sealed !== false
    rows.push({
      ok,
      text: ok
        ? `the draw before it, which picked #${e.tokenId} before it was set aside, recomputes here too`
        : `the draw before it, said to have picked #${e.tokenId}, does NOT recompute here`,
    })
  }
  return rows
}

export function BrowserVerify({ input }: { input: BrowserVerifyInput }) {
  const client = usePublicClient({ chainId: base.id })
  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    let live = true
    setRows(null)
    check(input, client)
      .then((r) => { if (live) setRows(r) })
      .catch(() => { if (live) setRows([{ ok: null, text: 'this browser could not run the check' }]) })
    return () => { live = false }
  }, [input, client])

  const failed = rows?.some((r) => r.ok === false) ?? false
  return (
    <section className="mt-6 border border-line p-4" aria-live="polite">
      <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted">checked in your browser</h2>
      {rows === null ? (
        <p className="text-[11px] font-mono text-subtle mt-2">recomputing…</p>
      ) : (
        <>
          <p className={`text-sm font-mono mt-2 ${failed ? 'text-[#ff7c80]' : 'text-[#7ee787]'}`}>
            {failed ? 'MISMATCH in your browser' : 'verified in your browser'}
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {rows.map((r, i) => (
              <li key={i} className="flex gap-2 text-[11px] font-mono leading-relaxed">
                <span
                  aria-hidden
                  className={`shrink-0 w-3 ${r.ok === true ? 'text-[#7ee787]' : r.ok === false ? 'text-[#ff7c80]' : 'text-subtle'}`}
                >
                  {r.ok === true ? '✓' : r.ok === false ? '✗' : '–'}
                </span>
                <span className={r.ok === false ? 'text-[#ff7c80]' : 'text-dim'}>{r.text}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] font-mono text-subtle mt-2 max-w-lg leading-relaxed">
            Nothing above is the server&apos;s word: the hashes and the draw were recomputed by this page with your
            browser&apos;s own cryptography, and the blocks were read from Base through your browser&apos;s connection.
          </p>
        </>
      )}
    </section>
  )
}
