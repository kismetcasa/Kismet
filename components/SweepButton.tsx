'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { useQuery } from '@tanstack/react-query'
import type { SweepApiResponse } from '@/lib/sweepIndexCore'

// The one sweep entry point (SWEEP_IMPLEMENTATION.md §1.1): a button in the
// advanced discover page's sticky header. Renders nothing until /api/sweep
// answers with an enabled, non-empty pool, so a disabled flag or an empty
// index leaves the header exactly as it was. The sheet is loaded on demand.

const SweepSheet = dynamic(() => import('./SweepSheet').then((m) => m.SweepSheet), { ssr: false })

async function fetchSweepAvailability(): Promise<SweepApiResponse> {
  const res = await fetch('/api/sweep?n=10')
  if (!res.ok) return { enabled: false }
  return (await res.json()) as SweepApiResponse
}

export function SweepButton() {
  const [open, setOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['sweep-availability'],
    queryFn: fetchSweepAvailability,
    // Matches the endpoint's own 30 s edge cache plus the flag memo; a tab
    // that stays open re-checks once a minute at most.
    staleTime: 60_000,
  })
  const available = data !== undefined && data.enabled && data.items.length > 0
  if (!available) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="shrink-0 rounded-full border border-accent/40 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-accent transition-colors hover:border-accent hover:bg-accent/10"
      >
        sweep
      </button>
      {open && <SweepSheet onClose={() => setOpen(false)} />}
    </>
  )
}
