import { headers } from 'next/headers'
import { DiscoverPage } from '@/components/DiscoverPage'

// Server component (no 'use client'). Reads the request's User-Agent on
// the server, picks whether the discovered feed should mount cards
// lazily, and bakes that decision into the SSR HTML. Client hydrates
// with the same tree — no flicker, no hydration mismatch, no client-
// side "switch from desktop tree to mobile tree" frame.
//
// Why server-side: the alternative (a client-side useEffect that flips
// a state value based on pointer / matchMedia) means the first render
// uses initial state and the second render uses the real value. On
// desktop that means a brief frame where the lazy tree exists — which
// the user explicitly does not want for the desktop experience.
//
// Mobile UA regex covers the dominant cases:
//   - iPhone / iPad / iPod              (iOS Safari, iOS Mini App webview)
//   - Android / Mobile                  (Android Chrome, Firefox, Samsung)
//   - "Mobile" appears in nearly every  (catches edge user agents that
//     mobile UA from Chrome/Firefox/etc  don't include the platform name)
//
// Anything not matching falls through as desktop → eager render, exactly
// the same code path as before this branch.
export default async function Page() {
  const h = await headers()
  const ua = h.get('user-agent') ?? ''
  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(ua)
  return <DiscoverPage isMobile={isMobile} />
}
