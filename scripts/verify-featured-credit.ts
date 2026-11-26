// lib/featuredCredit: the Mint Pass Display hero (components/FeaturedMoment)
// credits a Patron token's split artist, linked to that artist's profile, and
// every other featured artwork's creator record. The old hero keyed two maps on
// the creator address: the platform treasury (0x099b…, kismetart.eth) read
// "turro" and linked Turro's wallet. That held for Patron token 1 only because
// the treasury is its creator record: any featured artwork the treasury minted
// credited Turro, so dwn2erth's Patron drop, minted the way token 1 was, would
// have too.
//
// Fixtures are production data read on 2026-11-25, the same as
// verify-raffle-share: the stored splits (/api/moment/splits) and profiles
// (/api/profile/<address>) of Patron tokens 1 (Turro) and 3 (Tornado
// Rodriguez), and dwn2erth's profile for the next drop. FeaturedMoment is a
// React component, so `hero()` below replays its credit against the real
// production functions: first paint (/api/moment landed, the split read still
// in flight), the split read, then the credited wallet's profile lookup.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --import ./scripts/register-ts-alias.mjs scripts/verify-featured-credit.ts

import { readFileSync } from 'node:fs'

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
const UNNAMED = '0x3333333333333333333333333333333333333333'
// Mixed-case spellings, as on-chain reads and the record can return them.
const upper = (a: string) => `0x${a.slice(2).toUpperCase()}`

// A deployment may move the secondary-market fee to its own Safe
// (NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT). The default fee recipient IS the
// treasury, which would hide a missing treasury pin, so every check runs with
// it moved. The modules read the environment at load: set it before importing.
const MOVED_FEE_SAFE = '0x5afe00000000000000000000000000000000fee5'
process.env.NEXT_PUBLIC_PLATFORM_FEE_RECIPIENT = MOVED_FEE_SAFE

type Recipient = { address: string; percentAllocation?: number }
const split = (...entries: [string, number][]): Recipient[] =>
  entries.map(([address, percentAllocation]) => ({ address, percentAllocation }))

// The name fetchCreatorProfile resolves for each address (/api/profile,
// 2026-11-25). An address missing here resolves to its short-address
// placeholder, which the hero does not count as a name.
const PROFILE_NAME: Record<string, string> = {
  [TREASURY]: 'kismetart.eth',
  [TURRO]: 'Turro',
  [TORNADO]: 'Tornado Rodriguez',
  [DWN2ERTH]: 'dwn2erth',
}

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

async function main() {
  const { featuredByline, featuredCredit } = await import('../lib/featuredCredit.ts')
  const { raffleShareArtist } = await import('../lib/raffleShare.ts')
  const { PATRON_ARTIST_OVERRIDES, deriveArtistsFromRecipients, isPatronCollection, patronPlatformPayees } =
    await import('../lib/patronCollection.ts')
  const { PLATFORM_FEE_RECIPIENT } = await import('../lib/platformFee.ts')
  const { shortAddress } = await import('../lib/inprocess.ts')

  type Credit = NonNullable<ReturnType<typeof featuredCredit>>
  type Profile = { address: string; name: string }
  // What fetchCreatorProfile(address) yields, tagged as FeaturedMoment tags it.
  const lookup = (address: string): Profile => ({
    address,
    name: PROFILE_NAME[address.toLowerCase()] ?? shortAddress(address),
  })
  // The hero's "by …" line as rendered: "Turro → /profile/0x6c1c…", or null
  // when the line drops.
  const shown = (b: { href: string; label: string } | null) => (b ? `${b.label} → ${b.href}` : null)

  // Replays FeaturedMoment's credit. `splitRead` is what fetchSplitRecipients
  // yields (null = unreadable); `creator` and `creatorUsername` are the
  // /api/moment record.
  function hero(
    tokenId: string,
    splitRead: Recipient[] | null,
    creator: string | null,
    opts: { creatorUsername?: string | null; collectionAddress?: string } = {},
  ) {
    const { creatorUsername = null, collectionAddress = PATRON } = opts
    const creditAt = (splitRecipients: Recipient[] | null | undefined) =>
      featuredCredit({ collectionAddress, tokenId, creatorAddress: creator, splitRecipients })
    const line = (credit: Credit | null, profile: Profile | null) =>
      shown(credit ? featuredByline(credit, { creatorAddress: creator, creatorUsername, profile }) : null)
    // First paint: no split yet, no lookup yet.
    const firstCredit = creditAt(undefined)
    // The split read lands. Only a Patron hero reads one.
    const credit = isPatronCollection(collectionAddress) ? creditAt(splitRead) : firstCredit
    // The credited wallet's profile lookup, skipped when a curated name labels it.
    const looked = credit && !credit.name ? lookup(credit.address) : null
    return {
      first: line(firstCredit, null),
      credited: line(credit, null),
      final: line(credit, looked),
      lookedUp: looked?.address ?? null,
      address: credit?.address ?? null,
    }
  }
  const mentionsTurro = (h: ReturnType<typeof hero>) =>
    [h.first, h.credited, h.final].some((s) => !!s && (s.toLowerCase().includes('turro') || s.includes(TURRO)))

  console.log('\nConfig and wiring')
  eq('the fee recipient really moved off the treasury for this run', PLATFORM_FEE_RECIPIENT.toLowerCase(), MOVED_FEE_SAFE)
  const featuredSrc = source('../components/FeaturedMoment.tsx')
  check(
    'FeaturedMoment renders the byline from lib/featuredCredit',
    /from '@\/lib\/featuredCredit'/.test(featuredSrc) && featuredSrc.includes('featuredCredit(') && featuredSrc.includes('featuredByline('),
  )
  check(
    'FeaturedMoment and RaffleEntryModal read the split through the same helper',
    featuredSrc.includes('fetchSplitRecipients(') && source('../components/RaffleEntryModal.tsx').includes('fetchSplitRecipients('),
  )
  check(
    'FeaturedMoment keys no credit on an address: no treasury or Turro wallet literal, no "turro" string',
    !featuredSrc.toLowerCase().includes(TREASURY) && !featuredSrc.toLowerCase().includes(TURRO) && !/['"`]turro['"`]/i.test(featuredSrc),
  )

  // ── Token 1: Turro (curated override) ─────────────────────────────────────
  console.log('\nToken 1, Turro: split pays treasury 80 / Turro 20; creator record is the treasury')
  const SPLIT_1 = split([TREASURY, 80], [TURRO, 20])
  const t1 = hero('1', SPLIT_1, TREASURY)
  eq('credits Turro, linked to his profile', t1.final, `Turro → /profile/${TURRO}`)
  eq('first paint already credits Turro (no wait on the split)', t1.first, t1.final)
  eq('the curated name needs no profile lookup', t1.lookedUp, null)
  check('never links the treasury', ![t1.first, t1.final].some((s) => s?.includes(TREASURY)))

  // ── Token 3: Tornado Rodriguez (split-derived; the profile names him) ─────
  console.log('\nToken 3, Tornado Rodriguez: split pays treasury 80 / Tornado 20')
  const SPLIT_3 = split([TREASURY, 80], [TORNADO, 20])
  for (const creator of [TORNADO, TREASURY]) {
    const t3 = hero('3', SPLIT_3, creator)
    const label = creator === TREASURY ? 'creator record = treasury' : 'creator record = Tornado'
    eq(`credits Tornado Rodriguez, linked to his profile (${label})`, t3.final, `@Tornado Rodriguez → /profile/${TORNADO}`)
    check(`never names Turro or links his wallet (${label})`, !mentionsTurro(t3))
  }
  const t3 = hero('3', SPLIT_3, TORNADO)
  eq('before his profile resolves: the short address, already linked to him', t3.credited, `${shortAddress(TORNADO)} → /profile/${TORNADO}`)
  eq(
    'a record username seeds the label while the record is Tornado',
    hero('3', SPLIT_3, TORNADO, { creatorUsername: 'tornado-' }).credited,
    `@tornado- → /profile/${TORNADO}`,
  )
  eq(
    "the treasury record's username never labels Tornado",
    hero('3', SPLIT_3, TREASURY, { creatorUsername: 'kismetart' }).credited,
    `${shortAddress(TORNADO)} → /profile/${TORNADO}`,
  )

  // ── A new drop: no override, the split names another artist ───────────────
  const ids = Object.keys(PATRON_ARTIST_OVERRIDES).map(Number).filter(Number.isInteger)
  const NEW = String(Math.max(0, ...ids) + 1)
  console.log(`\nNew token ${NEW}, dwn2erth: split pays treasury 80 / dwn2erth 20; no override; creator record is the treasury`)
  check(`token ${NEW} has no override (the split alone credits the artist)`, !Object.prototype.hasOwnProperty.call(PATRON_ARTIST_OVERRIDES, NEW))
  const SPLIT_NEW = split([TREASURY, 80], [DWN2ERTH, 20])
  const tn = hero(NEW, SPLIT_NEW, TREASURY)
  eq('credits dwn2erth, linked to their profile', tn.final, `@dwn2erth → /profile/${DWN2ERTH}`)
  eq('first paint (split not read yet) credits no one rather than Turro or the treasury', tn.first, null)
  check('never names Turro or links the treasury', !mentionsTurro(tn) && !tn.final?.includes(TREASURY))

  // ── The old map's key: a featured artwork the treasury minted ─────────────
  console.log('\nTreasury-minted featured artworks credit their own artist, never Turro')
  const overrideless = ['2', ...Array.from({ length: 9 }, (_, i) => String(Number(NEW) + i))]
  const drops = overrideless.map((id, i) => {
    const artist = i % 2 === 0 ? DWN2ERTH : TORNADO
    return { id, artist, h: hero(id, split([TREASURY, 80], [artist, 20]), TREASURY) }
  })
  check(
    `Patron tokens ${overrideless.join(', ')}: each credits its split's artist, never Turro`,
    drops.every(({ artist, h }) => h.address === artist && h.final?.endsWith(`/profile/${artist}`) && !mentionsTurro(h)),
    drops.filter(({ artist, h }) => h.address !== artist || mentionsTurro(h)).map(({ id, h }) => [id, h.final]),
  )
  const elsewhere = hero('7', null, TREASURY, { collectionAddress: OTHER_COLLECTION })
  eq("another collection's treasury mint credits the treasury's own profile", elsewhere.final, `@kismetart.eth → /profile/${TREASURY}`)
  check('…in any casing, never "turro"', !mentionsTurro(hero('7', null, upper(TREASURY), { collectionAddress: OTHER_COLLECTION })))

  // ── Split shapes and fallbacks ────────────────────────────────────────────
  console.log('\nSplit shapes and fallbacks')
  eq('unreadable split on token 1: Turro from the override', hero('1', null, TREASURY).final, `Turro → /profile/${TURRO}`)
  eq('unreadable split on token 3: Tornado from the override pin', hero('3', null, TORNADO).final, `@Tornado Rodriguez → /profile/${TORNADO}`)
  eq('unreadable split, no override: no byline', hero(NEW, null, TREASURY).final, null)
  eq('legacy record (split flagged, no recipients) on token 1: Turro', hero('1', [], TREASURY).final, `Turro → /profile/${TURRO}`)
  eq('legacy record, no override: no byline', hero(NEW, [], TREASURY).final, null)
  eq('platform-only split, no override: no byline', hero(NEW, split([TREASURY, 95], [MOVED_FEE_SAFE, 5]), TREASURY).final, null)
  const misKeyed = hero('1', SPLIT_NEW, TREASURY)
  eq("mis-keyed override: token 1's split pays dwn2erth, so dwn2erth is credited", misKeyed.final, `@dwn2erth → /profile/${DWN2ERTH}`)
  check('mis-keyed override: Turro shows only until the split corrects it', misKeyed.first === `Turro → /profile/${TURRO}` && !misKeyed.credited?.includes(TURRO) && !misKeyed.final?.toLowerCase().includes('turro'))
  const dwnCredit = featuredCredit({ collectionAddress: PATRON, tokenId: '3', creatorAddress: TORNADO, splitRecipients: SPLIT_NEW })
  eq(
    "a lookup for an earlier credit never labels the current one (token 3's pin looked up Tornado, the split pays dwn2erth)",
    dwnCredit && shown(featuredByline(dwnCredit, { creatorAddress: TORNADO, profile: lookup(TORNADO) })),
    `${shortAddress(DWN2ERTH)} → /profile/${DWN2ERTH}`,
  )
  const tornadoCredit = featuredCredit({ collectionAddress: PATRON, tokenId: '3', splitRecipients: SPLIT_3 })
  eq(
    'a checksummed lookup is matched to its wallet',
    tornadoCredit && shown(featuredByline(tornadoCredit, { profile: { address: upper(TORNADO), name: 'Tornado Rodriguez' } })),
    `@Tornado Rodriguez → /profile/${TORNADO}`,
  )
  eq(
    "a placeholder from the profile cache is not a name, in any casing",
    tornadoCredit && shown(featuredByline(tornadoCredit, { profile: { address: TORNADO, name: shortAddress(upper(TORNADO)) } })),
    `${shortAddress(TORNADO)} → /profile/${TORNADO}`,
  )

  // ── Parity with the raffle share and the Patron page ──────────────────────
  console.log('\nSame artist as the raffle share and the Patron page')
  const pageExclude = patronPlatformPayees(TREASURY /* the Patron's default admin */, undefined /* payout: unset */)
  for (const [tokenId, s, creator] of [['1', SPLIT_1, TREASURY], ['3', SPLIT_3, TORNADO], [NEW, SPLIT_NEW, TREASURY]] as const) {
    const raffle = raffleShareArtist({ collectionAddress: PATRON, tokenId, creatorAddress: creator, splitRecipients: s })
    const page = deriveArtistsFromRecipients([s], pageExclude)[0]
    eq(`token ${tokenId}: hero = raffle share = page`, [hero(tokenId, s, creator).address, raffle.profileAddress], [page, page])
    const unreadable = raffleShareArtist({ collectionAddress: PATRON, tokenId, creatorAddress: creator, splitRecipients: null })
    eq(`token ${tokenId}, unreadable split: hero = raffle share`, hero(tokenId, null, creator).address, unreadable.profileAddress)
  }

  // ── Other collections: the creator record, as before ──────────────────────
  console.log('\nOther collections keep the creator ladder')
  eq(
    'credits the creator, ignoring any split',
    hero('7', split([TORNADO, 100]), DWN2ERTH, { collectionAddress: OTHER_COLLECTION }).final,
    `@dwn2erth → /profile/${DWN2ERTH}`,
  )
  const unnamed = hero('7', null, UNNAMED, { collectionAddress: OTHER_COLLECTION, creatorUsername: 'someone' })
  eq('a record username survives a lookup that found no name (no downgrade)', [unnamed.first, unnamed.final], [
    `@someone → /profile/${UNNAMED}`,
    `@someone → /profile/${UNNAMED}`,
  ])
  eq('no username, no name: the short address', hero('7', null, UNNAMED, { collectionAddress: OTHER_COLLECTION }).final, `${shortAddress(UNNAMED)} → /profile/${UNNAMED}`)
  eq('no creator record: no byline', hero('7', null, null, { collectionAddress: OTHER_COLLECTION }).final, null)

  console.log(failures === 0 ? '\nAll featured-credit checks passed.' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
