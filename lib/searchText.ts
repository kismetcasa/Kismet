// Search text normalization + relevance ranking — the single source of truth
// for how Kismet matches a typed query against usernames, social handles,
// collection names, and moment titles. Two production-confirmed problems it
// solves, applied identically to the query AND every indexed field so the two
// sides meet in the same normalized space:
//
//  1. Unicode folding. Names on an art platform are full of non-ASCII letters
//     (a real user "gønz", a collection "æternal"). Raw `.toLowerCase().includes()`
//     never matched them against an ASCII query ("gonz", "aeternal"): `ø`/`æ`
//     neither lowercase nor NFKD-decompose to `o`/`ae` — they are ATOMIC letters,
//     not base+combining-mark. NFKD strips the decomposable diacritics
//     (é→e, ñ→n, ü→u); the explicit ATOMIC_FOLD map below handles the atomic
//     letters NFKD leaves untouched. Folding only via NFKD — the common advice —
//     silently fails on exactly the `gønz`/`æternal` case, which is why the map
//     is not optional.
//
//  2. Relevance. The old searchers kept the FIRST 20 rows in arbitrary scan
//     order and dropped the rest, so a perfect prefix match could lose to 20
//     worse substring hits scanned earlier. rankScore lets callers score every
//     candidate and keep the best — the whole point of a typeahead.
//
// Pure, dependency-free, and CI-locked by scripts/verify-search.ts.

// Atomic Latin letters with no NFD/NFKD decomposition — the ones NFKD can't
// reach. Keys are lowercase; foldSearch lowercases before applying, so one
// entry covers both cases (Ø and ø both fold to o).
const ATOMIC_FOLD: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ł: 'l',
  ð: 'd',
  þ: 'th',
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ĸ: 'k',
  ŋ: 'n',
  ə: 'e',
  ß: 'ss',
}
const ATOMIC_RE = new RegExp(`[${Object.keys(ATOMIC_FOLD).join('')}]`, 'g')

// Combining diacritical marks (U+0300–U+036F) that NFKD leaves behind after it
// splits, say, é into e + acute. Stripping them yields the ASCII base letter.
const COMBINING_MARKS_RE = /[̀-ͯ]/g

/**
 * Normalize text into the space where search comparisons happen: diacritics
 * removed, atomic special letters folded to ASCII, lowercased, whitespace
 * collapsed and trimmed. Idempotent — folding an already-folded string is a
 * no-op — so it is safe to apply to both the query and a field even if one was
 * already folded upstream.
 */
export function foldSearch(input: string): string {
  return input
    .normalize('NFKD') // é → e + combining-acute, ﬁ → fi, İ → I + combining-dot …
    .replace(COMBINING_MARKS_RE, '') // strip the combining marks NFKD produced
    .toLowerCase() // fold case before the atomic map (whose keys are lowercase)
    .replace(ATOMIC_RE, (c) => ATOMIC_FOLD[c] ?? c) // ø → o, æ → ae, ß → ss …
    .replace(/\s+/g, ' ') // collapse internal whitespace runs
    .trim()
}

// Relevance tiers, higher wins. A typeahead should surface an exact/prefix hit
// above a mid-string substring hit, and a clean match above a typo-corrected
// one — which the old first-20-scanned logic could not express. FUZZY sits
// below every clean match so a typo hit only shows when nothing better exists.
export const RANK = {
  NONE: 0,
  FUZZY: 1,
  SUBSTRING: 2,
  WORD_PREFIX: 3,
  PREFIX: 4,
  EXACT: 5,
} as const

/**
 * True when `a` and `b` are within one edit — a single insertion, deletion, or
 * substitution (Levenshtein ≤ 1; transpositions count as 2, deliberately not
 * corrected). O(n) with early exit, no DP matrix. Used only as the typo-tolerance
 * fallback in rankScore, and only against a comparable-length token, so it stays
 * cheap and conservative.
 */
function withinEditDistanceOne(a: string, b: string): boolean {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  if (la === lb) {
    let diff = 0
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i] && ++diff > 1) return false
    }
    return true
  }
  // Lengths differ by exactly one: the shorter must embed in the longer with a
  // single skipped character.
  const short = la < lb ? a : b
  const long = la < lb ? b : a
  let i = 0
  let j = 0
  let skipped = false
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
    } else {
      if (skipped) return false
      skipped = true
      j++ // consume one extra char from the longer string
    }
  }
  return true
}

/**
 * Score how well `field` matches an ALREADY-FOLDED `foldedQuery`. Folds `field`
 * internally, so callers pass raw field values and a pre-folded query (fold the
 * query once per search, not once per candidate). Returns a RANK tier; 0 = no
 * match. Callers take the max across a record's fields (optionally weighted),
 * sort descending, and only then truncate to the page size.
 */
export function rankScore(field: string | null | undefined, foldedQuery: string): number {
  if (!field || !foldedQuery) return RANK.NONE
  const f = foldSearch(field)
  if (!f) return RANK.NONE
  if (f === foldedQuery) return RANK.EXACT
  if (f.startsWith(foldedQuery)) return RANK.PREFIX
  if (f.includes(' ' + foldedQuery)) return RANK.WORD_PREFIX // query begins a later word
  if (f.includes(foldedQuery)) return RANK.SUBSTRING
  // Typo tolerance, last resort. Gated to queries of 4+ chars (a single edit on
  // a 1–3 char query matches far too much) and checked only against a
  // comparable-length token of the field, so "kismt" finds "kismet" without
  // "cat" finding "bat" on a 3-letter query. Ranked below every clean match.
  if (foldedQuery.length >= 4) {
    for (const token of f.split(' ')) {
      if (Math.abs(token.length - foldedQuery.length) <= 1 && withinEditDistanceOne(token, foldedQuery)) {
        return RANK.FUZZY
      }
    }
  }
  return RANK.NONE
}
