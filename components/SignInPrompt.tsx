'use client'

import { useSignIn } from '@/hooks/useSignIn'

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
 * cookie-required endpoint. Layout wrapper over useSignIn, which owns
 * the ensureSession + in-flight + error-toast flow (shared with the
 * profile earnings card's compact variant). In a Mini App the click
 * resolves without a wallet prompt (Quick Auth's JWT IS the session).
 */
export function SignInPrompt({
  message,
  onSignedIn,
}: SignInPromptProps) {
  const { signIn, signingIn } = useSignIn(onSignedIn)

  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <p className="text-xs font-mono text-muted">{message}</p>
      <button
        onClick={signIn}
        disabled={signingIn}
        className="px-4 py-1.5 text-xs font-mono border border-line text-dim hover:text-ink hover:border-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {signingIn ? 'signing…' : 'sign in'}
      </button>
    </div>
  )
}
