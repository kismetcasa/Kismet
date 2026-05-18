import { toast } from 'sonner'

// Shared follow-up toast for offering "Add Kismet" inside a Farcaster
// host after a meaningful action (first mint, first follow). Kept in
// /lib so MintForm and ProfileView don't drift in copy or behavior.
//
// Surfaces map to the per-surface 30-day cooldown in
// providers/FarcasterProvider.tsx so a user who minted last week can
// still get prompted on their first follow today, and vice-versa.

type Surface = 'mint' | 'follow'

const COPY: Record<Surface, { description: string; label: string }> = {
  mint: {
    description: 'Get notified the moment someone collects your work.',
    label: 'Add Kismet',
  },
  follow: {
    description: 'Get notified when they post something new.',
    label: 'Add Kismet',
  },
}

const TOAST_DURATION_MS = 8000

/**
 * Fire-and-forget. Renders a sonner toast with an action button when
 * the user is eligible — i.e. running in a Mini App, hasn't added yet,
 * doesn't have notifications enabled, isn't inside the per-surface
 * cooldown, and no other modal is open. Otherwise silently no-ops so
 * the call site doesn't need to branch.
 *
 * The trigger sites pass shouldPrompt + doPrompt straight from
 * useFarcaster() so this stays purely declarative and doesn't itself
 * touch React context.
 */
export function maybeOfferAddMiniApp(
  surface: Surface,
  shouldPrompt: (s: Surface) => boolean,
  doPrompt: (opts: { surface: Surface }) => Promise<void>,
): void {
  if (!shouldPrompt(surface)) return
  const copy = COPY[surface]
  toast(copy.description, {
    duration: TOAST_DURATION_MS,
    action: {
      label: copy.label,
      onClick: () => {
        void doPrompt({ surface })
      },
    },
  })
}
