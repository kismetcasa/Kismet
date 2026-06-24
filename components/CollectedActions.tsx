'use client'

import { ListButton, type ListButtonProps } from './ListButton'
import { RaffleButton } from './RaffleButton'
import { PATRON_COLLECTION_ADDRESS_LOWER } from '@/lib/patron'

/**
 * The action button shown on an owned edition. For the Patron Collection — the
 * token-gate collection whose editions feed the physical-redemption raffle — the
 * secondary action is "enter raffle" (RaffleButton), not "list". Everywhere else
 * it stays a marketplace listing (ListButton). Single decision point so the
 * owned-edition call sites (MomentCard ×2, MomentDetailView) don't each repeat
 * the branch.
 */
export function CollectedActions(props: ListButtonProps) {
  const isPatronEdition =
    props.collectionAddress.toLowerCase() === PATRON_COLLECTION_ADDRESS_LOWER

  if (isPatronEdition) {
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
