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
// above a mid-string substring hit — which the old first-20-scanned logic
// could not express.
export const RANK = {
  NONE: 0,
  SUBSTRING: 1,
  WORD_PREFIX: 2,
  PREFIX: 3,
  EXACT: 4,
} as const

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
  return RANK.NONE
}
