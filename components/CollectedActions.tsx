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
 * Single decision point so the owned-edition call sites (MomentCard ×2,
 * MomentDetailView) don't each repeat the branch. The decision is synchronous:
 * the whole raffle-enabled set is loaded once on mount, so there's no per-card
 * request — at worst a brief List→Raffle swap on the rare enabled moment before
 * the set finishes loading.
 */
export function CollectedActions(props: ListButtonProps) {
  const { raffleEnabledKeys } = useAdmin()
  const key = `${props.collectionAddress.toLowerCase()}:${props.tokenId}`

  if (raffleEnabledKeys.has(key)) {
    return (
      <RaffleButton
        collectionAddress={props.collectionAddress}
        tokenId={props.tokenId}
        buttonClassName={props.buttonClassName}
        stacked={props.stacked}
      />
    )
  }

  return <ListButton {...props} />
}
