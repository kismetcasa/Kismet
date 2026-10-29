import 'server-only'
import { cookies, headers } from 'next/headers'
import { verifyFarcasterJwt } from './farcasterAuth'
import { SESSION_COOKIE, verifySession } from './session'

/**
 * The signed-in address viewing a server-rendered page, or null: the session
 * cookie, as the artwork page reads it, or — inside a Farcaster Mini App,
 * whose iframe drops that cookie — the Quick Auth token the app's fetch
 * wrapper adds to every same-origin request, the router's own included when
 * it navigates within the app (providers/FarcasterProvider). The same two
 * paths getSessionAddress reads for an API route (lib/session).
 */
export async function getPageViewerAddress(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (token) {
    const fromCookie = await verifySession(token)
    if (fromCookie) return fromCookie
  }
  const auth = (await headers()).get('authorization')
  if (!auth || !auth.startsWith('Bearer ')) return null
  const jwt = auth.slice('Bearer '.length).trim()
  if (!jwt) return null
  const result = await verifyFarcasterJwt(jwt).catch(() => null)
  return result?.address ?? null
}
