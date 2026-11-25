// lib/raffleShare + lib/patronCollection: a Patron raffle credits the artist
// its TOKEN's stored split pays, linked to that artist's profile, instead of
// one collection-wide artist. The old config named Turro on every Patron
// raffle and linked his name to the platform treasury (0x099b…, kismetart.eth),
// so a Tornado or dwn2erth raffle would have credited Turro and shown the
// treasury's profile.
//
// Fixtures are production data read on 2026-11-25: the stored splits
// (/api/moment/splits) and profiles (/api/profile/<address>) of Patron tokens
// 1 (Turro) and 3 (Tornado Rodriguez), and dwn2erth's profile for the next
// drop. RaffleEntryModal is a React component, so `modal()` below replays its
// effect against the real production functions: first paint, then the split
// read, then the credited artist's profile.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-raffle-share.ts

import type { RaffleShareArtist } from '../lib/raffleShare.ts'

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}
const eq = (name: string, actual: unknown, expected: unknown) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected })

const PATRON = '0x80ce7bd430f34792490a22ee0fd479e7333715c9'
const OTHER_COLLECTION = '0x1111111111111111111111111111111111111111'
const TREASURY = '0x099b9bbe0937428e145a3003ddf58e7e0cf69801'
const TURRO = '0x6c1cbe8cfc32a74188a9d3bf364945ea53b01b04'
const TORNADO = '0x651d699af32cd71b5573571935c99c35f074dd51'
const DWN2ERTH = '0xa0be5a9b02b7b7290f89e4e2a01faf46ef00baf5'

// A deployment may move the secondary-market fee to its own Safe
// (NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT). The default fee recipient IS the
// treasury, which would hide a missing treasury pin, so every check runs with
// it moved. The modules read the environment at load: set it before importing.
const MOVED_FEE_SAFE = '0x5afe00000000000000000000000000000000fee5'
process.env.NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT = MOVED_FEE_SAFE

type Recipient = { address: string; percentAllocation?: number }
const split = (...entries: [string, number][]): Recipient[] =>
  entries.map(([address, percentAllocation]) => ({ address, percentAllocation }))

// What fetchCreatorProfile returns for each address (/api/profile, 2026-11-25).
// An address missing here resolves to its shortAddress placeholder, which the
// modal does not count as a name.
const PROFILE: Record<string, { name: string; fcUsername: string | null }> = {
  [TREASURY]: { name: 'kismetart.eth', fcUsername: null },
  [TURRO]: { name: 'Turro', fcUsername: null },
  [TORNADO]: { name: 'Tornado Rodriguez', fcUsername: 'tornado-' },
  [DWN2ERTH]: { name: 'dwn2erth', fcUsername: 'dwn2erth.eth' },
}

async function main() {
  const { raffleShareArtist, raffleCastText, raffleTweetText, artworkShareUrl } = await import('../lib/raffleShare.ts')
  const {
    PATRON_ARTIST_OVERRIDES,
    PATRON_TREASURY,
    deriveArtistsFromRecipients,
    patronPlatformPayees,
    patronTokenArtist,
  } = await import('../lib/patronCollection.ts')
  const { PLATFORM_FEE_RECIPIENT } = await import('../lib/platformFee.ts')
  const { CREATE_REFERRAL, RESIDENCIES_ADDRESS } = await import('../lib/config.ts')

  // Replays RaffleEntryModal's effect. `split` is what the /api/moment/splits
  // read yields (null = unreadable); `creator` is the record's creator.
  function modal(tokenId: string, splitRecipients: Recipient[] | null, creatorAddress: string | null, collectionAddress = PATRON) {
    const first = raffleShareArtist({ collectionAddress, tokenId, creatorAddress })
    const credited = raffleShareArtist({ collectionAddress, tokenId, creatorAddress, splitRecipients })
    const who = credited.profileAddress
    const profile = who ? PROFILE[who] : undefined
    const final = who
      ? raffleShareArtist({
          collectionAddress,
          tokenId,
          creatorAddress,
          splitRecipients,
          resolvedFcUsername: profile?.fcUsername ?? null,
          resolvedName: profile?.name ?? null,
        })
      : credited
    return { first, credited, final }
  }
  // The modal's "Thanks for supporting …" line and the link it renders.
  const thanks = (a: RaffleShareArtist) =>
    a.displayName && a.profileAddress ? `us and ${a.displayName} → /profile/${a.profileAddress}` : 'Kismet.'
  const mentionsTurro = (a: RaffleShareArtist) =>
    JSON.stringify(a).toLowerCase().includes('turro') || JSON.stringify(a).includes('MOTEMT3')

  console.log('\nConfig')
  eq('the fee recipient really moved off the treasury for this run', PLATFORM_FEE_RECIPIENT.toLowerCase(), MOVED_FEE_SAFE)
  eq('the treasury pin is the platform treasury', PATRON_TREASURY, TREASURY)
  eq("Turro's override names his wallet, the split payee", PATRON_ARTIST_OVERRIDES['1']?.address, TURRO)
  check('no override names the treasury', Object.values(PATRON_ARTIST_OVERRIDES).every((o) => o.address.toLowerCase() !== TREASURY))
  const payees = patronPlatformPayees()
  check('platform payees: treasury excluded even with the fee recipient moved', payees.has(TREASURY))
  check('platform payees: the moved fee Safe is excluded too', payees.has(MOVED_FEE_SAFE))
  check('platform payees: referral + residencies excluded', payees.has(CREATE_REFERRAL.toLowerCase()) && payees.has(RESIDENCIES_ADDRESS.toLowerCase()))
  const ROLE = '0xAbCdEf0000000000000000000000000000000001'
  const withRoles = patronPlatformPayees(ROLE, null, undefined, '')
  check('platform payees: collection roles join lowercased, empty roles are dropped', withRoles.has(ROLE.toLowerCase()) && withRoles.size === payees.size + 1)
  check('artists are never platform payees', ![TURRO, TORNADO, DWN2ERTH].some((a) => withRoles.has(a)))

  // ── Token 1: Turro (curated override) ─────────────────────────────────────
  console.log('\nToken 1, Turro: split pays treasury 80 / Turro 20; creator record is the treasury')
  const SPLIT_1 = split([TREASURY, 80], [TURRO, 20])
  const t1 = modal('1', SPLIT_1, TREASURY)
  eq('credits Turro, linked to his profile', thanks(t1.final), `us and Turro → /profile/${TURRO}`)
  eq('cast copy', raffleCastText(t1.final), "i just entered the raffle on @kismet to win @turro's physical artwork!")
  eq('tweet copy', raffleTweetText(t1.final), "i just entered the raffle on @kismetdotart to win Turro's (@MOTEMT3) physical artwork!")
  eq('first paint already names Turro with the right link (no wait on the split)', t1.first, t1.final)
  check('never links the treasury', t1.first.profileAddress !== TREASURY && t1.final.profileAddress !== TREASURY)

  // ── Token 3: Tornado Rodriguez (split-derived; X handle curated) ──────────
  console.log('\nToken 3, Tornado Rodriguez: split pays treasury 80 / Tornado 20')
  const SPLIT_3 = split([TREASURY, 80], [TORNADO, 20])
  for (const creator of [TORNADO, TREASURY]) {
    const t3 = modal('3', SPLIT_3, creator)
    const label = creator === TREASURY ? 'creator record = treasury' : 'creator record = Tornado'
    eq(`credits Tornado, linked to his profile (${label})`, thanks(t3.final), `us and Tornado Rodriguez → /profile/${TORNADO}`)
    check(`never names Turro (${label})`, !mentionsTurro(t3.first) && !mentionsTurro(t3.credited) && !mentionsTurro(t3.final))
  }
  const t3 = modal('3', SPLIT_3, TORNADO)
  eq('cast copy tags his Farcaster handle from the profile', raffleCastText(t3.final), "i just entered the raffle on @kismet to win @tornado-'s physical artwork!")
  eq('tweet copy tags his X handle from the override', raffleTweetText(t3.final), "i just entered the raffle on @kismetdotart to win Tornado Rodriguez's (@tornado_ilus) physical artwork!")
  eq('before his profile resolves: right link target, no name yet', [t3.credited.profileAddress, thanks(t3.credited)], [TORNADO, 'Kismet.'])

  // ── A new drop: no override, the split names another artist ───────────────
  const ids = Object.keys(PATRON_ARTIST_OVERRIDES).map(Number).filter(Number.isInteger)
  const NEW = String(Math.max(0, ...ids) + 1)
  console.log(`\nNew token ${NEW}, dwn2erth: split pays treasury 80 / dwn2erth 20; no override entry`)
  check(`token ${NEW} has no override (the derivation alone credits the artist)`, !Object.prototype.hasOwnProperty.call(PATRON_ARTIST_OVERRIDES, NEW))
  const SPLIT_NEW = split([TREASURY, 80], [DWN2ERTH, 20])
  const tn = modal(NEW, SPLIT_NEW, TREASURY)
  eq('credits dwn2erth, linked to their profile', thanks(tn.final), `us and dwn2erth → /profile/${DWN2ERTH}`)
  eq('cast copy', raffleCastText(tn.final), "i just entered the raffle on @kismet to win @dwn2erth.eth's physical artwork!")
  eq('tweet copy (no curated X handle: plain name)', raffleTweetText(tn.final), "i just entered the raffle on @kismetdotart to win dwn2erth's physical artwork!")
  eq('first paint (split not read yet) names no one rather than the wrong artist', [thanks(tn.first), raffleCastText(tn.first), raffleTweetText(tn.first)], [
    'Kismet.',
    'i just entered the raffle on @kismet to win this physical artwork!',
    'i just entered the raffle on @kismetdotart to win this physical artwork!',
  ])
  check('never names Turro or links the treasury', !mentionsTurro(tn.final) && tn.final.profileAddress !== TREASURY)
  check('share embeds this token', artworkShareUrl(PATRON, NEW).endsWith(`/artwork/${PATRON}/${NEW}`))

  // ── Parity with the Patron page's artist chips ────────────────────────────
  console.log("\nSame artists as the Patron page's credit")
  const pageExclude = patronPlatformPayees(TREASURY /* the Patron's default admin */, undefined /* payout: unset */)
  eq('page chips over all three drops', deriveArtistsFromRecipients([SPLIT_1, SPLIT_3, SPLIT_NEW], pageExclude), [TURRO, TORNADO, DWN2ERTH])
  for (const [tokenId, s, raffle] of [['1', SPLIT_1, t1], ['3', SPLIT_3, t3], [NEW, SPLIT_NEW, tn]] as const) {
    eq(`token ${tokenId}: raffle credit = the page's artist`, raffle.final.profileAddress, deriveArtistsFromRecipients([s], pageExclude)[0])
  }

  // ── Split shapes and fallbacks ────────────────────────────────────────────
  console.log('\nSplit shapes and fallbacks')
  const credit = (tokenId: string, s: Recipient[] | null | undefined) => patronTokenArtist(tokenId, s)?.address ?? null
  eq(
    'checksummed addresses: treasury still excluded, artist lowercased',
    credit(NEW, split(['0x099B9BBe0937428e145a3003dDf58e7E0CF69801', 80], [DWN2ERTH.toUpperCase().replace('0X', '0x'), 20])),
    DWN2ERTH,
  )
  eq('residencies + referral payees are skipped', credit(NEW, split([TREASURY, 70], [RESIDENCIES_ADDRESS, 5], [CREATE_REFERRAL, 5], [DWN2ERTH, 20])), DWN2ERTH)
  eq('the (moved) fee recipient is skipped', credit(NEW, split([MOVED_FEE_SAFE, 80], [DWN2ERTH, 20])), DWN2ERTH)
  eq('platform-only split, no override: no credit', credit(NEW, split([TREASURY, 100])), null)
  eq('platform-only split on token 1: the override credits Turro', credit('1', split([TREASURY, 100])), TURRO)
  eq('unreadable split, no override: names no one, links no one', modal(NEW, null, TREASURY).final, {
    fcLabel: null,
    xLabel: null,
    profileAddress: null,
    displayName: null,
  })
  eq('unreadable split on token 1: Turro from the override', thanks(modal('1', null, TREASURY).final), `us and Turro → /profile/${TURRO}`)
  eq('unreadable split on token 3: Tornado from the override pin', thanks(modal('3', null, TORNADO).final), `us and Tornado Rodriguez → /profile/${TORNADO}`)
  eq('legacy record (split flagged, no recipients) on token 1: Turro', credit('1', []), TURRO)
  const misKeyed = modal('1', SPLIT_NEW, TREASURY)
  eq("mis-keyed override: token 1's split pays dwn2erth, so dwn2erth is credited", thanks(misKeyed.final), `us and dwn2erth → /profile/${DWN2ERTH}`)
  check("mis-keyed override: none of Turro's handles leak onto it", !mentionsTurro(misKeyed.final))
  eq('collab: the largest artist allocation wins', credit(NEW, split([TREASURY, 60], [TORNADO, 15], [DWN2ERTH, 25])), DWN2ERTH)
  eq('collab tie: first-seen wins', credit(NEW, split([TREASURY, 60], [TORNADO, 20], [DWN2ERTH, 20])), TORNADO)
  eq("collab with a curated pick: token 1's override wins while the split pays Turro", credit('1', split([TREASURY, 60], [TURRO, 15], [DWN2ERTH, 25])), TURRO)
  eq('addresses without allocations (the page chips shape): first-seen', credit(NEW, [{ address: TREASURY }, { address: TORNADO }, { address: DWN2ERTH }]), TORNADO)
  eq('non-numeric token ids never read Object.prototype', [credit('constructor', null), credit('__proto__', null), credit('toString', SPLIT_NEW)], [null, null, DWN2ERTH])

  // ── Other collections: unchanged (creator's profile) ──────────────────────
  console.log('\nOther collections keep the creator ladder')
  const other = modal('7', split([TORNADO, 100]), DWN2ERTH, OTHER_COLLECTION)
  eq('credits the creator, ignoring any split', thanks(other.final), `us and dwn2erth → /profile/${DWN2ERTH}`)
  eq('creator copy', [raffleCastText(other.final), raffleTweetText(other.final)], [
    "i just entered the raffle on @kismet to win @dwn2erth.eth's physical artwork!",
    "i just entered the raffle on @kismetdotart to win dwn2erth's physical artwork!",
  ])
  const unnamed = modal('7', null, '0x3333333333333333333333333333333333333333', OTHER_COLLECTION)
  eq('an unresolved creator drops the artist clause', [unnamed.final.fcLabel, unnamed.final.xLabel, thanks(unnamed.final)], [null, null, 'Kismet.'])

  console.log(failures === 0 ? '\nAll raffle-share checks passed.' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
