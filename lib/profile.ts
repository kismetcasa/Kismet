import { redis } from './redis'
import { bestEffort } from './bestEffort'
import { getHiddenUsersSet } from './hidden-users'
import { getHiddenProfilesSet } from './hidden-profiles'
import { randomHex } from './random'

export interface Profile {
  address: string
  username?: string
  avatarUrl?: string
  updatedAt: number
}

/**
 * FID-keyed profile, used for "miniapp-first" Farcaster users — those
 * who created their Kismet profile inside the Mini App and never had
 * an address-keyed record. The user's identity follows their FID, and
 * `currentAddress` (always an FC-verified address) is the address
 * currently representing them: drives the profile URL, the Nav avatar,
 * share cards, etc. WalletsPanel switches it freely without losing
 * data because the username/avatar live alongside the FID, not the
 * address. "Web-first" users (existing address-keyed Profile from
 * before they connected FC) stay on the address-keyed path — they
 * see no chooser and their identity stays anchored.
 */
export interface FidProfile {
  fid: number
  currentAddress: string
  username?: string
  avatarUrl?: string
  updatedAt: number
}

const keyByAddress = (address: string) =>
  `kismetart:profile:${address.toLowerCase()}`
const keyByFid = (fid: number) =>
  `kismetart:profile:fid:${fid}`
const keyNonce = (address: string) =>
  `kismetart:nonce:${address.toLowerCase()}`
export const KEY_PROFILES = 'kismetart:profiles'

/**
 * Hard-delete the address-keyed profile identity: the row, its search-index
 * membership, and the auth nonce. After this getProfile returns the empty
 * stub a never-used wallet gets, so a later signed PUT recreates a fresh
 * profile — the "erase → reconnect makes a new profile" contract. Admin
 * profile-erase only; irreversible. Does NOT touch on-chain content meta or
 * financial ledgers (see the erase route for the full purge boundary).
 */
export async function deleteProfileRow(address: string): Promise<void> {
  const lower = address.toLowerCase()
  await Promise.all([
    redis.del(keyByAddress(lower)),
    redis.srem(KEY_PROFILES, lower),
    redis.del(keyNonce(lower)),
  ])
}

/** Hard-delete a FID-keyed profile row (the miniapp-first identity home).
 *  Paired with deleteProfileRow for every verified wallet by the erase route. */
export async function deleteFidProfile(fid: number): Promise<void> {
  await redis.del(keyByFid(fid))
}

export async function getProfile(address: string): Promise<Profile> {
  const raw = await redis.get<string | Profile>(keyByAddress(address))
  const base: Profile = { address: address.toLowerCase(), updatedAt: 0 }
  if (!raw) return base
  const parsed: Profile = typeof raw === 'string' ? JSON.parse(raw) : raw
  return { ...base, ...parsed }
}

// Batch lookup keyed by lowercase address. Missing entries are omitted
// from the returned map; consumers fall back to their own resolvers.
export async function getProfileBatch(
  addresses: string[],
): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>()
  if (addresses.length === 0) return out
  const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase())))
  try {
    const raws = await redis.mget<(string | Profile | null)[]>(
      ...unique.map(keyByAddress),
    )
    for (let i = 0; i < unique.length; i++) {
      const raw = raws[i]
      if (!raw) continue
      const parsed: Profile = typeof raw === 'string' ? JSON.parse(raw) : raw
      // Force lowercase to match the rest of the codebase's keying.
      out.set(unique[i], { ...parsed, address: unique[i] })
    }
  } catch {}
  return out
}

export async function upsertProfile(
  address: string,
  data: Partial<Pick<Profile, 'username' | 'avatarUrl'>>
): Promise<Profile> {
  const existing = await getProfile(address)
  const updated: Profile = { ...existing, ...data, address: address.toLowerCase(), updatedAt: Date.now() }
  await Promise.all([
    redis.set(keyByAddress(address), JSON.stringify(updated)),
    redis.sadd(KEY_PROFILES, address.toLowerCase()),
  ])
  return updated
}

export async function getFidProfile(fid: number): Promise<FidProfile | null> {
  const raw = await redis.get<string | FidProfile>(keyByFid(fid))
  if (!raw) return null
  const parsed: FidProfile = typeof raw === 'string' ? JSON.parse(raw) : raw
  return parsed
}

export async function upsertFidProfile(
  fid: number,
  currentAddress: string,
  data: Partial<Pick<FidProfile, 'username' | 'avatarUrl'>>,
): Promise<FidProfile> {
  const existing = await getFidProfile(fid)
  const updated: FidProfile = {
    fid,
    currentAddress: currentAddress.toLowerCase(),
    username: data.username ?? existing?.username,
    avatarUrl: data.avatarUrl ?? existing?.avatarUrl,
    updatedAt: Date.now(),
  }
  await Promise.all([
    redis.set(keyByFid(fid), JSON.stringify(updated)),
    // Index the current address in the master profiles SET so address-
    // prefix search still surfaces FID-based users.
    redis.sadd(KEY_PROFILES, updated.currentAddress),
  ])
  return updated
}

/**
 * Move the FidProfile's `currentAddress` pointer without touching
 * username/avatar. Called by /api/me/identity when the user switches
 * which of their FC-verified wallets represents them. No-op if the
 * FID has no profile yet — caller should `upsertFidProfile` first.
 */
export async function setFidCurrentAddress(
  fid: number,
  currentAddress: string,
): Promise<FidProfile | null> {
  const existing = await getFidProfile(fid)
  if (!existing) return null
  const updated: FidProfile = {
    ...existing,
    currentAddress: currentAddress.toLowerCase(),
    updatedAt: Date.now(),
  }
  await Promise.all([
    redis.set(keyByFid(fid), JSON.stringify(updated)),
    redis.sadd(KEY_PROFILES, updated.currentAddress),
  ])
  return updated
}

export async function trackWallet(address: string): Promise<void> {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return
  await redis.sadd(KEY_PROFILES, address.toLowerCase()).catch(bestEffort('profile.trackWallet', { address }))
}

export async function searchProfiles(query: string): Promise<Profile[]> {
  const q = query.trim().toLowerCase()
  const isAddressQuery = /^0x[0-9a-fA-F]+$/.test(q)

  // Search is a public feed surface — admin-hidden users (content hide)
  // AND admin-hidden profiles (identity hide) are both stripped from
  // results regardless of who's querying. Memoized; cheap to fetch
  // alongside the profiles smembers.
  const [addresses, hiddenUsers, hiddenProfiles] = await Promise.all([
    redis.smembers(KEY_PROFILES) as Promise<string[]>,
    getHiddenUsersSet(),
    getHiddenProfilesSet(),
  ])
  const stripped = (a: string) => hiddenUsers.has(a) || hiddenProfiles.has(a)
  const results: Profile[] = []

  if (isAddressQuery) {
    // Filter indexed wallets by address prefix
    const matching = addresses.filter(a => a.startsWith(q) && !stripped(a))
    if (matching.length > 0) {
      const raws = await redis.mget<(string | Profile | null)[]>(...matching.map(keyByAddress))
      for (const raw of raws) {
        if (!raw) continue
        const p: Profile = typeof raw === 'string' ? JSON.parse(raw) : raw
        results.push(p)
        if (results.length >= 20) break
      }
    }
    // If querying a full address and not already found, do a direct lookup
    // so any wallet is discoverable even if they haven't interacted yet.
    // Still gate on the hide lists — directly typing the address shouldn't
    // bypass the filter (matches the listings GET behavior for hidden
    // seller-scoped lookups).
    if (q.length === 42 && !stripped(q) && !results.some(r => r.address === q)) {
      results.unshift(await getProfile(q))
    }
  } else {
    // Username search across all indexed profiles
    if (!addresses.length) return []
    const raws = await redis.mget<(string | Profile | null)[]>(...addresses.map(keyByAddress))
    for (let i = 0; i < addresses.length; i++) {
      const raw = raws[i]
      if (!raw) continue
      if (stripped(addresses[i])) continue
      const p: Profile = typeof raw === 'string' ? JSON.parse(raw) : raw
      if ((p.username ?? '').toLowerCase().includes(q)) {
        results.push(p)
        if (results.length >= 20) break
      }
    }
  }

  return results
}

// Nonce for wallet signature verification — expires in 5 minutes.
// 16 random bytes = 128 bits, hex-encoded so the value is alphanumeric
// (no dashes). Matches the EIP-4361 SIWE nonce rule (^[a-zA-Z0-9]{8,}$),
// so this single helper covers both SIWE-formatted user login and the
// freeform-message paths (profile update, follow, listing PATCH, …).
export async function createNonce(address: string): Promise<string> {
  const nonce = randomHex(16)
  await redis.setex(keyNonce(address), 300, nonce)
  return nonce
}

// Atomic via GETDEL — single Redis round-trip returns the stored value and
// deletes the key. Without atomicity, two concurrent calls with the same
// nonce can both observe-and-delete (GET, compare, DEL) and both succeed,
// letting a captured signature be replayed in parallel. A mismatched-nonce
// attempt also clears whatever was stored, which is the right trade-off:
// nonces are server-issued and the legitimate caller transparently refetches.
export async function consumeNonce(address: string, nonce: string): Promise<boolean> {
  if (!nonce || typeof nonce !== 'string') return false
  const stored = await redis.getdel<string>(keyNonce(address))
  return stored === nonce
}
