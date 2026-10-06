/**
 * A machine's URL, made from its name: "Spring Season" is /play/spring-season.
 *
 * Accents fold to their letters and everything else that is not a letter or a
 * digit becomes a dash, so the URL reads as the name does. A name with nothing
 * to read in Latin letters (all emoji, say) becomes "gachapon". The base stays
 * short enough that a suffix for a clash ("-2", "-12") still fits the 64
 * characters an id may have.
 */
export const MACHINE_ID_PATTERN = /^[a-z0-9-]{3,64}$/

/** Kismet's own pages under /play, which a machine can never be. */
export const PAGE_IDS: ReadonlySet<string> = new Set(['create', 'create-capsule', 'create-reveal'])

const BASE_MAX = 56

export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, BASE_MAX)
    .replace(/-+$/g, '')
  return base.length >= 3 ? base : base ? `${base}-gachapon` : 'gachapon'
}

/** The ids a machine of this name may take, in order: the name itself, then
 *  "-2", "-3"… for a clash. */
export function* machineIdCandidates(name: string, max = 50): Generator<string> {
  const base = slugify(name)
  for (let n = 1; n <= max; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (!PAGE_IDS.has(id)) yield id
  }
}
