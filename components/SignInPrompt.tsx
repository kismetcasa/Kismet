'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { useUploadSession } from '@/hooks/useUploadSession'
import { humanError } from '@/lib/toast'

interface SignInPromptProps {
  /** Helper text shown above the button. */
  message: string
  /**
   * Fires after SIWE resolves. The caller clears its authRequired
   * state and re-runs the fetch that 401'd — only the surface that
   * detected the 401 knows what to retry.
   */
  onSignedIn: () => void
}

/**
 * Sign-in CTA for wallet-connected users who hit 401 on a session-
 * cookie-required endpoint. Wraps useUploadSession.ensureSession plus
 * in-flight + error-toast boilerplate. In a Mini App ensureSession is
 * a no-op (Quick Auth's JWT IS the session) so clicking resolves
 * without a wallet prompt.
 */
export function SignInPrompt({
  message,
  onSignedIn,
}: SignInPromptProps) {
  const { ensureSession } = useUploadSession()
  const [signingIn, setSigningIn] = useState(false)

  async function handleClick() {
    if (signingIn) return
    setSigningIn(true)
    try {
      await ensureSession()
      onSignedIn()
    } catch (err) {
      toast.error('Sign in failed', { description: humanError(err) })
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <p className="text-xs font-mono text-muted">{message}</p>
      <button
        onClick={handleClick}
        disabled={signingIn}
        className="px-4 py-1.5 text-xs font-mono border border-line text-dim hover:text-ink hover:border-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {signingIn ? 'signing…' : 'sign in'}
      </button>
    </div>
  )
}
