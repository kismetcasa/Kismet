'use client'

import { useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { toast } from 'sonner'
import { toastError } from '@/lib/toast'

// One-signature "distribute all" for the profile earnings card: fetch a nonce,
// sign the batch message, POST to /api/distribute-all (which selects the
// artist's top-CAP splits by value and fans out to inprocess). Mirrors the
// per-moment distribute flow in useMomentSplits, minus the per-split params —
// the server resolves the caller's own splits. `onDone` refreshes the pending
// roll-up so the "to distribute" line updates.
export function useDistributeAll(onDone?: () => void) {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [distributing, setDistributing] = useState(false)

  async function distributeAll() {
    if (distributing) return
    if (!connectedAddress) {
      toast.error('Wallet not connected')
      return
    }
    setDistributing(true)
    try {
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')

      const message = `Distribute all Kismet splits\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })

      const res = await fetch('/api/distribute-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callerAddress: connectedAddress, signature, nonce }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        moments?: number
        distributed?: number
        failed?: number
        remaining?: number
        error?: string
      }
      if (!res.ok) throw new Error(data.error ?? 'Distribution failed')

      const distributed = data.distributed ?? 0
      const remaining = data.remaining ?? 0
      if (distributed === 0 && (data.moments ?? 0) === 0) {
        toast.success('Nothing to distribute', { id: 'distribute-all' })
      } else {
        const morePart = remaining > 0 ? ` · ${remaining} more — tap again` : ''
        const failedPart = data.failed ? ` (${data.failed} failed)` : ''
        toast.success(
          `Distributed ${distributed} payout${distributed === 1 ? '' : 's'}${failedPart}${morePart}`,
          { id: 'distribute-all' },
        )
      }
      onDone?.()
    } catch (err) {
      toastError('Distribution', err, { id: 'distribute-all' })
    } finally {
      setDistributing(false)
    }
  }

  return { distributeAll, distributing }
}
