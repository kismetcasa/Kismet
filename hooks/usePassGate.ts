'use client'

import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { useAdmin } from '@/contexts/AdminContext'

interface PassGate {
  enabled: boolean
  passCollection: string | null
  passCollectionName: string | null
  validBalance: number
}

/**
 * Creator-pass gate pre-check shared by the mint and create-collection forms.
 * When the token gate is enabled and the connected identity holds no valid
 * Pass, `gatedOut` is true so the form can swap its primary action for a
 * "collect from <name>" CTA pointing at `passCollectionHref`.
 *
 * Probes with scope=identity: validity is aggregated over the connected
 * wallet's FC-verified sibling union, matching the server gate
 * (hasGateAccess over expandToGateWallets). This is what keeps the CTA away
 * from Mini App users whose connected signer is the host's embedded wallet
 * while their Pass lives on the wallet they collected with on web — the
 * "already collected but still prompted to collect" failure
 * (PATRON_GATE_MINIAPP_RCA.md). For a wallet with no FC linkage the union is
 * just itself, so web behavior is unchanged.
 *
 * UX hint only — the authoritative checks run server-side (lib/mint-proxy for
 * mints, POST /api/collections for create), on the same union. Fails OPEN: a
 * failed /api/pass-validity read leaves `gatedOut` false so a flaky probe
 * never blocks the user; the server still enforces. Admin is exempt,
 * mirroring the server's hasGateAccess. While the probe is in flight (or no
 * wallet is connected) `gatedOut` is false, so a same-tick submit can slip
 * past the client hint — by design, the server is the real boundary.
 */
export function usePassGate(): {
  gatedOut: boolean
  passCollectionHref: string
  passCollectionName: string | null
} {
  const { address } = useAccount()
  const { isAdmin } = useAdmin()
  const [passGate, setPassGate] = useState<PassGate | null>(null)
  useEffect(() => {
    if (!address) { setPassGate(null); return }
    let cancelled = false
    fetch(`/api/pass-validity?address=${address}&scope=identity`)
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
  return { gatedOut, passCollectionHref, passCollectionName: passGate?.passCollectionName ?? null }
}
