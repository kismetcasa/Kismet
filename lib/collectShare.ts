import { toast } from 'sonner'
import { toastError } from '@/lib/toast'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { shortAddress } from '@/lib/inprocess'
import { SITE_URL } from '@/lib/siteUrl'

// "share to /kismet" cast composer (Mini App only).
//
// Two surfaces share the composer via composeMomentShareCast, with slightly
// different opening copy:
//   - Post-collect: useDirectCollect attaches a Share action to its success
//     toast, prefilling  collected "<artwork>" by @creator on @kismet
//   - Moment page: the detail view's Share button, prefilling
//     "<artwork>" by @creator on @kismet
// Both attach the moment URL as the embed (preview card) and post to /kismet.
//
// composeCast is a host action with no web equivalent, so callers offer it
// only inside a Mini App — the web success toast / copy-link path is unchanged.
//
// Callers must pre-gate on isInMiniApp before invoking the share — same rule
// as lib/farcasterHaptics: outside a host the dynamic SDK import would pull
// the @farcaster/miniapp-sdk chunk for regular web users.

/** Kismet's Farcaster channel — every composeCast surface posts here. */
export const KISMET_CHANNEL_KEY = 'kismet'

export interface CollectShareContext {
  /** Collection (1155) address of the collected moment — for the embed URL. */
  collectionAddress: string
  tokenId: string
  /** Artwork title from moment metadata; null falls back to "an artwork". */
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
 * 0x12…34 fallback.
 *
 * Two formats, one shared tail (" by @creator on @kismet"):
 *   - titleLead — the moment-page Share: leads with the quoted artwork title
 *     and no opening verb, e.g. "Sunset" by @alice on @kismet.
 *   - verb (default 'collected') — the post-collect prompt: a "<verb>
 *     <quoted title>" opener, e.g. collected "Sunset" by @alice on @kismet.
 */
export function buildCollectCastText(opts: {
  momentName: string | null
  creatorHandle: string | null
  verb?: string
  titleLead?: boolean
}): string {
  const title = opts.momentName?.trim()
  const subject = title ? `"${title}"` : 'an artwork'
  const tail = opts.creatorHandle
    ? ` by ${opts.creatorHandle} on @kismet`
    : ' on @kismet'
  // Moment-page Share: lead with the quoted title, no opening verb —
  // e.g. "Sunset" by @alice on @kismet.
  if (opts.titleLead) return `${subject}${tail}`
  // Post-collect Share: "<verb> <quoted title>" opener (unchanged).
  const verb = opts.verb ?? 'collected'
  return `${verb} ${subject}${tail}`
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

/**
 * Prefill and open the host cast composer for a moment: the shared cast text
 * (buildCollectCastText), the moment URL as the embed preview card, posted to
 * /kismet. Mini App only — the dynamic SDK import must not run for web users
 * (see header), so callers pre-gate on isInMiniApp.
 *
 * Resolves with the composeCast result — `{ cast }` on send, `{ cast: null }`
 * when the user dismisses the sheet. Throws if the SDK import or the host
 * action fails, so each caller picks its own fallback: the post-collect prompt
 * surfaces a toast (shareCollectedCast), the moment page copies the link.
 */
export async function composeMomentShareCast(
  ctx: CollectShareContext,
  opts: { verb?: string; titleLead?: boolean } = {},
) {
  const { sdk } = await import('@farcaster/miniapp-sdk')
  const creatorHandle = await resolveCreatorHandle(ctx)
  const text = buildCollectCastText({
    momentName: ctx.momentName,
    creatorHandle,
    verb: opts.verb,
    titleLead: opts.titleLead,
  })
  const momentUrl = `${SITE_URL}/moment/${ctx.collectionAddress}/${ctx.tokenId}`
  return sdk.actions.composeCast({
    text,
    embeds: [momentUrl],
    channelKey: KISMET_CHANNEL_KEY,
  })
}

/**
 * Post-collect Share prompt: prefill the composer with "collected …" and
 * confirm (toast + haptic) on send. Mini App only (see header).
 */
export async function shareCollectedCast(ctx: CollectShareContext): Promise<void> {
  try {
    const composed = await composeMomentShareCast(ctx)
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
