// Builds the `fc:miniapp` (and legacy `fc:frame`) meta tag values for a
// Farcaster Mini App embed. Drop the return value into a Next.js
// Metadata.other object on any page to make that URL render as a rich,
// launchable card when shared in a cast.
//
// Both `fc:miniapp` (current) and `fc:frame` (legacy parsers) are emitted
// so older Farcaster clients still resolve the embed correctly. The only
// difference between the two payloads is the `action.type` discriminator
// — `launch_miniapp` vs `launch_frame`.
//
// Spec: https://miniapps.farcaster.xyz/docs/specification

export type FarcasterEmbedAction = {
  /** Page URL the host should open. Defaults to the current page URL when omitted. */
  url?: string
  /**
   * App / page name. REQUIRED by the canonical actionLaunchMiniAppSchema
   * (miniAppNameSchema = z.string().max(32)). User-influenced values
   * (moment titles, collection names, usernames) are truncated by the
   * builder so callers can't accidentally emit an invalid embed.
   */
  name: string
  /** Splash image override. Defaults to manifest.splashImageUrl. Must be 200x200 PNG. */
  splashImageUrl?: string
  /** Splash bg override. Defaults to manifest.splashBackgroundColor. */
  splashBackgroundColor?: string
}

export type FarcasterEmbedInput = {
  /** 3:2 PNG; 600x400 min, 3000x2000 max, ≤10MB, URL ≤1024 chars. */
  imageUrl: string
  /** Button text. Spec caps at 32 chars; longer strings are truncated. */
  buttonTitle: string
  action: FarcasterEmbedAction
}

const NAME_AND_TITLE_MAX = 32

export function buildFarcasterEmbed(
  input: FarcasterEmbedInput,
): Record<string, string> {
  // Both buttonTitle and action.name are capped at 32 chars by the
  // canonical schemas (buttonTitleSchema, miniAppNameSchema). Truncate
  // here so call sites can pass user-controlled strings directly without
  // worrying about length — a longer string would otherwise make the
  // host's embed validation reject the whole card.
  const button = { title: input.buttonTitle.slice(0, NAME_AND_TITLE_MAX) }
  const action = {
    ...input.action,
    name: input.action.name.slice(0, NAME_AND_TITLE_MAX),
  }

  const miniappPayload = {
    version: '1' as const,
    imageUrl: input.imageUrl,
    button: { ...button, action: { type: 'launch_miniapp' as const, ...action } },
  }

  const framePayload = {
    version: '1' as const,
    imageUrl: input.imageUrl,
    button: { ...button, action: { type: 'launch_frame' as const, ...action } },
  }

  return {
    'fc:miniapp': JSON.stringify(miniappPayload),
    'fc:frame': JSON.stringify(framePayload),
  }
}
