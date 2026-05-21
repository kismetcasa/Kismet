import { NextRequest, NextResponse } from 'next/server'
import { getSessionAddress } from '@/lib/session'
import {
  getFarcasterProfileByAddress,
  getVerifiedAddressesByFid,
} from '@/lib/farcasterProfile'
import { getPrimaryAddress } from '@/lib/farcasterAuth'
import { getFidProfile, getProfile } from '@/lib/profile'

export interface MyWallet {
  address: string
  isPrimary: boolean
  isIdentity: boolean
}

/**
 * Which storage model is backing the user's profile, surfaced so the
 * client can decide whether the wallet chooser applies:
 *   - 'fid'      → FidProfile exists. WalletsPanel renders; switching
 *                  just moves the currentAddress pointer.
 *   - 'anchored' → No FidProfile, but address-keyed profile data
 *                  exists at one of the user's verifications (web-
 *                  first user). WalletsPanel HIDES — switching would
 *                  promote the user to FID-based and break the
 *                  "continue using your original address" guarantee.
 *   - 'none'     → No profile data anywhere yet. WalletsPanel renders
 *                  freely; the first profile edit + identity choice
 *                  creates the FidProfile.
 * Always 'none' for non-FC users (no FID to key on).
 */
export type IdentityModel = 'fid' | 'anchored' | 'none'

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
  let identityModel: IdentityModel = 'none'
  if (farcaster?.fid) {
    const [verifications, primary, fidProfile] = await Promise.all([
      getVerifiedAddressesByFid(farcaster.fid),
      getPrimaryAddress(farcaster.fid),
      getFidProfile(farcaster.fid),
    ])
    const lowerIdentity = address.toLowerCase()
    const lowerPrimary = primary?.toLowerCase()
    wallets = verifications.map((a) => ({
      address: a,
      isPrimary: a === lowerPrimary,
      isIdentity: a === lowerIdentity,
    }))
    if (fidProfile) {
      identityModel = 'fid'
    } else {
      // No FidProfile — check if any verification holds an address-
      // keyed Profile with data, which marks this user as web-first.
      for (const v of verifications) {
        const candidate = await getProfile(v)
        if (candidate.username || candidate.avatarUrl) {
          identityModel = 'anchored'
          break
        }
      }
    }
  }
  return NextResponse.json(
    { address, farcaster, wallets, identityModel },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
