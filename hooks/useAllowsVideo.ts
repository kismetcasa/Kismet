'use client'

import { useEffect, useState } from 'react'

// Whether the viewer permits autoplaying video. Starts false so we never
// autoplay before confirming (no flash of motion for reduced-motion /
// data-saver users); flips true on mount when allowed and tracks live changes
// to the reduced-motion setting. Per the research: fall back to the static
// still under prefers-reduced-motion or Data Saver — and low-power mode just
// makes autoplay fail, which callers answer with the still too. Shared by a
// themed profile's backdrop and a machine's stage frames.
export function useAllowsVideo(): boolean {
  const [allow, setAllow] = useState(false)
  useEffect(() => {
    // Gate on `no-preference` (not `!reduce`) so this matches the CSS effects,
    // which animate only inside the no-preference query — the two motion paths
    // then agree on every UA, including ones that report neither value (those
    // conservatively get the static still).
    const mq = window.matchMedia('(prefers-reduced-motion: no-preference)')
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } }
    const compute = () => setAllow(mq.matches && !nav.connection?.saveData)
    compute()
    mq.addEventListener('change', compute)
    return () => mq.removeEventListener('change', compute)
  }, [])
  return allow
}
