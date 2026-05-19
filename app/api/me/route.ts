import { NextRequest, NextResponse } from 'next/server'
import { getSessionAddress } from '@/lib/session'
import {
  getFarcasterProfileByAddress,
  getVerifiedAddressesByFid,
} from '@/lib/farcasterProfile'
import { getPrimaryAddress } from '@/lib/farcasterAuth'

export interface MyWallet {
  address: string
  isPrimary: boolean
  isIdentity: boolean
}

// Returns the currently-authenticated user's address plus, when
// available, the Farcaster profile and the full set of FC-verified
// wallets bound to the user's FID. The frontend calls this once on
// mount inside a Mini App (after acquiring the Quick Auth JWT) to
// learn the resolved identity for the session, and again whenever the
// user changes their chosen Kismet identity address.
//
// `address` is the CHOSEN Kismet identity (see verifyFarcasterJwt /
// getKismetIdentityAddress). `wallets` flags the FC primary and the
// chosen identity so the UI can render the picker without fetching
// the verifications list separately.
//
// On regular web (cookie-authed sessions): `address` is the wagmi-
// connected wallet, `farcaster` is whatever FC profile is bound to it
// (if any), and `wallets` is empty (we don't manage multi-wallet
// linkage for non-FC users).
export async function GET(req: NextRequest) {
  const address = await getSessionAddress(req)
  if (!address) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  const farcaster = await getFarcasterProfileByAddress(address)
  let wallets: MyWallet[] = []
  if (farcaster?.fid) {
    const [verifications, primary] = await Promise.all([
      getVerifiedAddressesByFid(farcaster.fid),
      getPrimaryAddress(farcaster.fid),
    ])
    const lowerIdentity = address.toLowerCase()
    const lowerPrimary = primary?.toLowerCase()
    wallets = verifications.map((a) => ({
      address: a,
      isPrimary: a === lowerPrimary,
      isIdentity: a === lowerIdentity,
    }))
  }
  return NextResponse.json(
    { address, farcaster, wallets },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
