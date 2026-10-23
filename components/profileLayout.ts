/**
 * The profile's card layouts (ProfileView), shared with the section that lays
 * out cards of its own — the creator's machines (ProfileMachines) — so every
 * section of a profile sits at the same scale. Under components/ so Tailwind's
 * content scan sees these class strings.
 */

/** The dense grid: the owner's dashboard and the full public profile. Compact
 *  cards 2/3/4/6 across breakpoints (the density PaginatedGrid uses for its
 *  grid view), which keeps each section glance-able even when a user has
 *  hundreds of mints/collected/listings. */
export const GRID_CLASSES = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3'

/** Curated showcase layout (visitor view / owner "public view"), mirroring
 *  the featured tab's CollectionRow: a horizontal snap-swipe of fixed-width
 *  cards on phones, and a three-up row on web (lg+) — the same column count
 *  as the discover feed, so showcase cards render at the platform's standard
 *  full-card scale. (Was four-up to match the original 4-pin cap, but
 *  ~270px cards read too small next to every other surface; at the 6-pin
 *  cap the three-up grid fills exactly two rows.) The dense grid
 *  (GRID_CLASSES) still drives the owner's full mint/collected lists. */
export const SHOWCASE_ROW_CLASSES =
  'flex gap-3 overflow-x-auto snap-x snap-mandatory [-webkit-overflow-scrolling:touch] lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible'

/** One showcase cell. grid grid-rows-1 makes the card fill the cell so every
 *  box in a section row is the same height regardless of content (price
 *  loaded, owned, text moment): the row stretches items to the tallest, this
 *  stretches the card to fill that height in turn. */
export const SHOWCASE_ITEM_CLASSES = 'grid grid-rows-1 w-72 flex-shrink-0 snap-start lg:w-auto'
