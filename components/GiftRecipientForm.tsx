'use client'

import { useState } from 'react'
import { usePublicClient } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { toast } from 'sonner'
import { resolveAddressOrEns } from '@/lib/address'
import { giftRejectionMessage, planMint } from '@/lib/gift'

/**
 * Recipient field for a collect-and-gift. Takes a 0x address or a .eth name,
 * resolves it on submit (not per keystroke — one mainnet call per real
 * attempt instead of one per character), and hands the caller a resolved
 * lowercase address to mint to.
 *
 * Resolution happens HERE rather than in useDirectCollect so the hook keeps a
 * single trust boundary: it accepts an address and nothing else. An
 * unresolved name never reaches a mint call, which is the failure that would
 * otherwise send someone's payment to an unintended wallet.
 *
 * The warning copy is not decoration. A gift is a mint straight to the
 * recipient — the payer never holds the edition, so for a Pass piece they
 * earn no mint access from it (lib/gift.ts). Someone gifting a Patron pass
 * expecting to keep one would otherwise discover that at the gate.
 */
export function GiftRecipientForm({
  signer,
  pending,
  onGift,
  onCancel,
}: {
  /** Connected wallet — used only to detect a self-gift before spending gas. */
  signer: string | null
  pending: boolean
  onGift: (recipient: `0x${string}`) => void | Promise<void>
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const [resolving, setResolving] = useState(false)
  // A NAME that resolved, held for confirmation. A gift is paid and
  // irreversible, and nothing else in the flow ever shows the user where their
  // money is going: the wallet prompt can't decode `mintTo` out of Zora's
  // minterArguments, so an ENS typo would be discovered only after the mint.
  // Held only for names — a typed 0x address is already visible in the field,
  // so confirming it twice would be friction with nothing to reveal.
  const [confirming, setConfirming] = useState<{ input: string; address: `0x${string}` } | null>(
    null,
  )
  // Mainnet client for ENS. lib/wagmi already configures a mainnet transport
  // purely for ENS, so this reuses it rather than standing up a duplicate.
  const mainnetClient = usePublicClient({ chainId: mainnet.id })
  const busy = pending || resolving

  async function submit() {
    if (busy) return
    const raw = value.trim()
    if (!raw) {
      toast.error('Enter a wallet address or .eth name')
      return
    }
    setResolving(true)
    try {
      const resolved = await resolveAddressOrEns(mainnetClient, raw)
      if (!resolved) {
        toast.error(
          raw.toLowerCase().endsWith('.eth')
            ? 'That name does not resolve'
            : giftRejectionMessage('invalid-recipient'),
        )
        return
      }
      // Same planner the hook runs, so the form can reject a bad recipient
      // before the user pays gas instead of after. Planned against the
      // recipient itself when no wallet is connected yet — this surface lets
      // you type a recipient and connect at submit time (ensureConnected runs
      // inside the collect), and using the recipient as a stand-in signer
      // would make EVERY input look like a self-gift and block the form. The
      // self-gift nudge is therefore skipped until a signer is known; if it
      // does turn out to be a self-gift, planMint collapses it to an ordinary
      // collect rather than erroring.
      const plan = planMint(signer ?? resolved, resolved)
      if (plan.mode === 'invalid') {
        toast.error(giftRejectionMessage(plan.reason))
        return
      }
      if (signer && plan.mode === 'collect') {
        toast.error('That is your own wallet — use collect instead')
        return
      }
      // Name input: show what it resolved to and require a second press. The
      // guard is keyed on the exact input, so editing the field after a
      // resolution drops back to un-confirmed rather than sending to the
      // previously resolved address.
      const typedAnAddress = /^0x[0-9a-fA-F]{40}$/.test(raw)
      if (!typedAnAddress && confirming?.input !== raw) {
        setConfirming({ input: raw, address: resolved })
        return
      }
      await onGift(resolved)
    } finally {
      setResolving(false)
    }
  }

  return (
    <div className="w-full flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="gift-recipient"
          name="gift-recipient"
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (confirming) setConfirming(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="0x… or name.eth"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-label="gift recipient"
          className="min-w-0 flex-1 border border-line bg-transparent px-3 py-1.5 text-xs font-mono text-ink placeholder:text-muted focus:outline-none focus:border-dim disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className={`shrink-0 border border-line px-3 py-1.5 text-xs font-mono uppercase tracking-widest transition-colors ${
            busy ? 'opacity-70 cursor-wait' : 'accent-grad-hover'
          }`}
        >
          <span className={busy ? undefined : 'accent-grad'}>
            {pending
              ? 'gifting…'
              : resolving
                ? 'resolving…'
                : confirming?.input === value.trim()
                  ? 'confirm gift'
                  : 'send gift'}
          </span>
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="shrink-0 border border-line px-3 py-1.5 text-xs font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors disabled:opacity-60"
        >
          cancel
        </button>
      </div>
      {confirming?.input === value.trim() && (
        <p className="text-[10px] font-mono text-dim leading-relaxed break-all">
          {confirming.input} → <span className="text-ink">{confirming.address}</span>
          {' · press again to confirm'}
        </p>
      )}
      <p className="text-[10px] font-mono text-muted leading-relaxed">
        you pay · the artwork is minted straight to them · you do not receive a
        copy, and gifting a pass does not grant you mint access
      </p>
    </div>
  )
}
