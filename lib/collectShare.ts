import { toast } from 'sonner'
import { toastError } from '@/lib/toast'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { shortAddress } from '@/lib/inprocess'
import { SITE_URL } from '@/lib/siteUrl'

// Post-collect "share to /kismet" prompt (Mini App only).
//
// useDirectCollect attaches a Share action to its success toast; tapping it
// opens the host's cast composer prefilled with
//
//   Collected "<artwork>" by @creator on @kismet
//
// plus the moment URL as the embed (preview card) and /kismet as the channel.
// composeCast is a host action with no web equivalent, so the hook offers the
// action only inside a Mini App — the web success toast is unchanged.
//
// Callers must pre-gate on isInMiniApp before invoking the share (the hook
// does) — same rule as lib/farcasterHaptics: outside a host the dynamic SDK
// import would pull the @farcaster/miniapp-sdk chunk for regular web users.

/** Kismet's Farcaster channel — every composeCast surface posts here. */
export const KISMET_CHANNEL_KEY = 'kismet'

export interface CollectShareContext {
  /** Collection (1155) address of the collected moment — for the embed URL. */
  collectionAddress: string
  tokenId: string
  /** Artwork title from moment metadata; null falls back to "a moment". */
  momentName: string | null
  /** Creator EOA — resolved to an FC @username at share time; null skips lookup. */
  creatorAddress: string | null
  /** Display name the caller already resolved for its own UI — the fallback
   *  when the creator has no Farcaster account. */
  creatorName?: string | null
}

/**
 * Cast copy, per the product spec: prefer the creator's real FC @username
 * (the host renders it as a clickable mention), fall back to their display
 * name, and drop the "by" clause entirely rather than casting a raw
 * 0x12…34 fallback. Quotes around the title match the post-mint share copy.
 */
export function buildCollectCastText(opts: {
  momentName: string | null
  creatorHandle: string | null
}): string {
  const title = opts.momentName?.trim()
  const subject = title ? `"${title}"` : 'a moment'
  return opts.creatorHandle
    ? `Collected ${subject} by ${opts.creatorHandle} on @kismet`
    : `Collected ${subject} on @kismet`
}

/**
 * Creator handle for the cast text:
 *   @fcUsername  — the address is FC-verified (profile cache carries the raw
 *                  username; see lib/profileCache)
 *   display name — no FC account; the profile-cache name or the caller's
 *                  already-resolved name, whichever actually resolved
 *   null         — nothing better than a shortAddress placeholder
 */
async function resolveCreatorHandle(ctx: CollectShareContext): Promise<string | null> {
  let name = ctx.creatorName?.trim() || null
  if (ctx.creatorAddress) {
    const placeholder = shortAddress(ctx.creatorAddress)
    const profile = await fetchCreatorProfile(ctx.creatorAddress)
    if (profile.fcUsername) return `@${profile.fcUsername}`
    if (!name && profile.name && profile.name !== placeholder) name = profile.name
    if (name === placeholder) name = null
  }
  return name
}

/** Open the cast composer prefilled for /kismet. Mini App only (see header). */
export async function shareCollectedCast(ctx: CollectShareContext): Promise<void> {
  try {
    const { sdk } = await import('@farcaster/miniapp-sdk')
    const creatorHandle = await resolveCreatorHandle(ctx)
    const text = buildCollectCastText({ momentName: ctx.momentName, creatorHandle })
    const momentUrl = `${SITE_URL}/moment/${ctx.collectionAddress}/${ctx.tokenId}`
    const composed = await sdk.actions.composeCast({
      text,
      embeds: [momentUrl],
      channelKey: KISMET_CHANNEL_KEY,
    })
    // composeCast resolves with { cast: null } when the user dismisses the
    // compose sheet — an explicit "no", so no success toast (matches the
    // post-mint share in MintForm).
    if (composed?.cast) {
      toast.success('Cast shared to /kismet!', { id: 'share' })
      hapticNotifySuccess()
    }
  } catch (err) {
    toastError('Share', err, { id: 'share' })
  }
}

/**
 * The Share action useDirectCollect attaches to its success toast. Kicks off
 * a profile-cache warm for the creator so the tap → composer hop doesn't wait
 * on the /api/profile round-trip (MomentCard skips fetchCreatorProfile when
 * the feed stitched a username, so the cache can be cold here).
 */
export function collectShareToastAction(ctx: CollectShareContext): {
  label: string
  onClick: () => void
} {
  if (ctx.creatorAddress) void fetchCreatorProfile(ctx.creatorAddress)
  return {
    label: 'Share',
    onClick: () => {
      void shareCollectedCast(ctx)
    },
  }
}
