'use client'

import { useAdmin } from '@/contexts/AdminContext'
import { ListButton, type ListButtonProps } from './ListButton'
import { RaffleButton } from './RaffleButton'

/**
 * The action button shown on an owned edition. For a moment with an active
 * raffle (an admin enabled it per-moment — see AdminContext.raffleEnabledKeys
 * / RaffleAdminPanel), the secondary action is "enter raffle" (RaffleButton),
 * not "list". Everywhere else it stays a marketplace listing (ListButton).
 *
 * `keepList` overrides the swap and forces the listing action even when the
 * raffle is enabled — passed on the owner's own profile card, so a holder can
 * still list their edition from their profile while the raffle runs (entering
 * is non-custodial, so the two aren't mutually exclusive). Every other card
 * surface (feed, discover, collection) shows "enter raffle".
 *
 * MomentDetailView is deliberately NOT a call site: the detail page carries no
 * listing action at all (listing lives on the holder's profile — a fourth
 * action-row column didn't fit the phone/mini-app row) and renders
 * RaffleButton directly, with the list fall-through suppressed, for the rare
 * raffle-enabled moment.
 *
 * Single decision point so the owned-edition call sites (MomentCard ×2)
 * don't each repeat the branch. The decision is synchronous:
 * the whole raffle-enabled set is loaded once on mount, so there's no per-card
 * request — at worst a brief List→Raffle swap on the rare enabled moment before
 * the set finishes loading.
 */
export function CollectedActions({
  keepList = false,
  ...props
}: ListButtonProps & { keepList?: boolean }) {
  const { raffleEnabledKeys } = useAdmin()
  const key = `${props.collectionAddress.toLowerCase()}:${props.tokenId}`

  if (!keepList && raffleEnabledKeys.has(key)) {
    return (
      <RaffleButton
        collectionAddress={props.collectionAddress}
        tokenId={props.tokenId}
        buttonClassName={props.buttonClassName}
        // So a released non-winner (raffle ended) or a holder who never entered
        // once entries close falls through to the normal listing action.
        listProps={props}
      />
    )
  }

  return <ListButton {...props} />
}
