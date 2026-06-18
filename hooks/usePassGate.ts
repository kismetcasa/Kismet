'use client'

import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { useAdmin } from '@/contexts/AdminContext'

interface PassGate {
  enabled: boolean
  passCollection: string | null
  validBalance: number
}

/**
 * Creator-pass gate pre-check shared by the mint and create-collection forms.
 * When the token gate is enabled and the connected wallet holds no valid Pass,
 * `gatedOut` is true so the form can swap its primary action for a "collect
 * Patron Collection artwork" CTA pointing at `passCollectionHref`.
 *
 * UX hint only — the authoritative checks run server-side (lib/mint-proxy for
 * mints, POST /api/collections for create). Fails OPEN: a failed
 * /api/pass-validity read leaves `gatedOut` false so a flaky probe never blocks
 * the user; the server still enforces. Admin is exempt, mirroring the server's
 * hasGateAccess. While the probe is in flight (or no wallet is connected)
 * `gatedOut` is false, so a same-tick submit can slip past the client hint —
 * by design, the server is the real boundary.
 */
export function usePassGate(): { gatedOut: boolean; passCollectionHref: string } {
  const { address } = useAccount()
  const { isAdmin } = useAdmin()
  const [passGate, setPassGate] = useState<PassGate | null>(null)
  useEffect(() => {
    if (!address) { setPassGate(null); return }
    let cancelled = false
    fetch(`/api/pass-validity?address=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setPassGate(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address])
  const gatedOut =
    !!passGate?.enabled &&
    !!passGate.passCollection &&
    passGate.validBalance < 1 &&
    !isAdmin
  const passCollectionHref = passGate?.passCollection
    ? `/collection/${passGate.passCollection}`
    : '/'
  return { gatedOut, passCollectionHref }
}
