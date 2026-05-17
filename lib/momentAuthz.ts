import { isOperatorAddress } from './config'

/**
 * `momentAdmins[]` from inprocess is unordered and may include the
 * operator smart wallet (no Kismet profile) or a 0xSplits SplitWallet
 * (also no profile, but detecting it needs a chain read).
 *
 * Used as the last fallback in the creator-resolution chain. Filtering
 * operator addresses covers the common case for moments minted outside
 * the Kismet flow where momentAdmins is the only signal available.
 *
 * Shared between MomentDetailView (client) and the server routes
 * (canonical + IR) so the creator check agrees on both sides — without
 * this, the server's hidden-moment gate could disagree with the
 * client's isCreator computation for moments whose first admin is the
 * operator wallet (creator would be falsely blocked from their own
 * hidden moment).
 */
export function pickFirstNonOperatorAdmin(
  admins: readonly string[] | undefined,
): string | undefined {
  return admins?.find((a) => !isOperatorAddress(a))
}
