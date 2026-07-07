'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { useUploadSession } from './useUploadSession'
import { humanError } from '@/lib/toast'

/**
 * Shared handler for 401-driven sign-in affordances (SignInPrompt, the
 * earnings card): ensureSession + in-flight state + error toast, so the
 * surfaces can't drift on the auth flow while keeping their own layout.
 *
 * Always revalidates: every caller renders BECAUSE the server just said
 * the session is missing/stale, so useUploadSession's per-address "already
 * valid" cache must not short-circuit the probe (a dead cookie after an
 * earlier successful sign-in in the same SPA lifetime would otherwise make
 * the button a silent no-op forever). In a Mini App ensureSession is a
 * no-op (Quick Auth's JWT IS the session) so clicking resolves without a
 * wallet prompt.
 *
 * `onSignedIn` fires after SIWE resolves — the caller clears its
 * authRequired state and re-runs the fetch that failed; only the surface
 * that detected the 401 knows what to retry.
 */
export function useSignIn(onSignedIn: () => void) {
  const { ensureSession } = useUploadSession()
  const [signingIn, setSigningIn] = useState(false)

  const signIn = async () => {
    if (signingIn) return
    setSigningIn(true)
    try {
      await ensureSession({ revalidate: true })
      onSignedIn()
    } catch (err) {
      toast.error('Sign in failed', { description: humanError(err) })
    } finally {
      setSigningIn(false)
    }
  }

  return { signIn, signingIn }
}
