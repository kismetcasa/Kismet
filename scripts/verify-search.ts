// Locks search normalization + ranking so the "gonz" ↛ "gønz" miss — and its
// whole class (æternal, José, Łódź, straße) — can't silently reopen, and so the
// relevance ranking that lets the best match survive the 20-result cap stays
// correct. foldSearch/rankScore are the single source of truth shared by
// searchProfiles (lib/profile), searchCollections (lib/kv), and searchMoments
// (lib/search); this pins their contract with no Redis / network.
//
// Run: node --experimental-strip-types scripts/verify-search.ts

import { foldSearch, rankScore, RANK } from '../lib/searchText.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) {
    console.log(`  PASS  ${name}`)
  } else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

// ── folding: atomic letters NFKD CANNOT decompose (the production bug class) ──
check('gønz → gonz', foldSearch('gønz') === 'gonz')
check('GØNZ → gonz (case-folded)', foldSearch('GØNZ') === 'gonz')
check('æternal → aeternal', foldSearch('æternal') === 'aeternal')
check('œuvre → oeuvre', foldSearch('œuvre') === 'oeuvre')
check('Łódź → lodz', foldSearch('Łódź') === 'lodz')
check('straße → strasse', foldSearch('straße') === 'strasse')

// ── folding: decomposable diacritics (the NFKD + strip-marks path) ──
check('José → jose', foldSearch('José') === 'jose')
check('piñata → pinata', foldSearch('piñata') === 'pinata')
check('über → uber', foldSearch('über') === 'uber')

// ── folding: hygiene ──
check('whitespace collapsed + trimmed', foldSearch('  A   B ') === 'a b')
check('idempotent', foldSearch(foldSearch('gØnz')) === foldSearch('gØnz'))

// ── the exact production miss now matches ──
const q = foldSearch('gonz')
check('query "gonz" matches field "gønz"', rankScore('gønz', q) > 0)
// "gønz" folds to exactly "gonz", so it is an EXACT match, not merely a prefix.
check('"gønz" is an EXACT fold-match of "gonz"', rankScore('gønz', q) === RANK.EXACT)

// ── ranking tiers order correctly (exact > prefix > word-prefix > substring) ──
check('exact > prefix', rankScore('gonz', q) > rankScore('gonzo', q))
check('prefix > substring', rankScore('gonzo', q) > rankScore('agonz', q))
check('word-prefix > mid-substring', rankScore('the gonz show', q) > rankScore('dragonzord', q))
check('substring > none', rankScore('agonz', q) > rankScore('unrelated', q))
check('no match → NONE', rankScore('unrelated', q) === RANK.NONE)
check('empty query → NONE', rankScore('anything', '') === RANK.NONE)
check('missing field → NONE', rankScore(undefined, q) === RANK.NONE)

// ── typo tolerance: conservative (≥4 chars, edit-distance ≤1, ranked last) ──
check('fuzzy: "kismt" (deletion) → "kismet"', rankScore('kismet', foldSearch('kismt')) === RANK.FUZZY)
check('fuzzy: "gonzo" (substitution) matches "gonza"', rankScore('gonza', foldSearch('gonzo')) === RANK.FUZZY)
check('fuzzy ranks below every clean match', RANK.FUZZY < RANK.SUBSTRING)
check('a clean substring still beats a typo', rankScore('agonz', q) > rankScore('gonza', foldSearch('gonzo')))
check('short queries (<4) do NOT fuzzy-match', rankScore('cat', foldSearch('bat')) === RANK.NONE)
check('transpositions are NOT corrected (dist 2)', rankScore('gonz', foldSearch('ognz')) === RANK.NONE)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nAll search checks passed')
process.exit(failures ? 1 : 0)
