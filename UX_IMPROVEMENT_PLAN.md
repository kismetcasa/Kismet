# Kismet — UX Improvement Plan (validated & designed)

Ten candidate improvements from the 2026-07 UX review, each re-validated against
the code (file:line evidence), with a designed solution where warranted. Three
verdicts changed under validation — noted inline. Companion to
`VIDEO_PLAYBACK_RCA.md` / `REMEDIATION_PLAYBOOK.md`; where those documents
already researched an item (CDN), this plan defers to and concretizes them.

**Verdict key:** ✅ address · 🔶 address, rescoped by validation · ⏸ defer (not a defect / needs evidence first)

| # | Item | Verdict | Effort |
|---|------|---------|--------|
| 1 | CDN in front of `/api/img` + second gateway | ✅ | infra config, ~day |
| 2 | Featured-tab first paint | ✅ | ~day |
| 3 | Moment-detail dead-end | ✅ | hours |
| 4 | One-tap web collect | ✅ | ~day |
| 5 | Residencies disclosure at CTA | ✅ | hours |
| 6 | Batch distribute | ✅ (simpler than assumed) | 2–3 days |
| 7 | Follower fan-out priority | ⏸ (not a defect) | n/a |
| 8 | Seller proceeds breakdown | ✅ | hours |
| 9 | First-run onboarding | 🔶 (rescoped: fix intent-tap dead-end + measure first) | hours + product |
| 10 | Contrast + modal focus | ✅ | 1–2 days |

---

## 1. CDN in front of `/api/img` + restore gateway redundancy — ✅

**Validated:** `VIDEO_PLAYBACK_RCA.md` "Open items" #1 marks this URGENT with live
measurements (30–112 MB discarded origin reads per resume-seek on a 186 MB file —
the "moments open slowly on Mini Apps" report). #2 documents the gateway pool
down to arweave.net alone (`lib/arweave/gateways.ts`) — a media SPOF.
`REMEDIATION_PLAYBOOK.md` §B5 independently confirms CDN as the highest-leverage
change and rules out request-count rate limits (Range streaming + CGNAT would 429
real viewers).

**Design:**
- Serve media through a CDN-fronted hostname (e.g. `media.kismet.art` →
  pull zone → origin `/api/img`). Provider must (a) forward `Range` to origin on
  miss, (b) cache the full object and serve arbitrary ranges from edge cache on
  hit, (c) preserve `206`/`Content-Range`. Cloudflare (cache-everything rule),
  Bunny (native range support), and CloudFront (range caching) all qualify;
  choose on ops preference. Validate with the RCA §5 probes
  (`Range: bytes=0-1` → `206` with real total) against the edge hostname.
- Media is content-addressed (`ar://<txid>`), so responses are immutable:
  `Cache-Control: public, max-age=31536000, immutable` from `/api/img` for
  resolved ar:// objects (verify current header; adjust if shorter).
- App change is minimal: point media URL construction at the CDN hostname
  (env-driven, e.g. `NEXT_PUBLIC_MEDIA_ORIGIN`), keep `/api/img` as origin.
- Re-add a second AR.IO gateway to `lib/arweave/gateways.ts` per the file's own
  documented curl-verification steps + `next.config.mjs` allowlist coupling.
- Keep the RCA's monitoring ask: external probe of
  `/api/img?u=ar://<known-txid>` with `Range: bytes=0-1`, alerting on non-206 —
  now pointed at the edge.

**Success:** time-to-first-frame and seek latency on Mini App video; origin
egress bytes (should collapse); zero regressions on the `verify-img-range`
suite.

## 2. Featured-tab first paint — ✅

**Validated:** `app/page.tsx` is already a server component (UA-based mobile
detection). All tab content is gated behind a `hydrated` flag that flips in a
post-mount effect (`DiscoverPage.tsx:465-482`) — for a *documented* reason: the
saved tab order lives in localStorage, and mounting the default tab first would
fire wasted fetches that race the real tab in the Mini App's constrained
connection pool. `FeaturedFeed` then client-fetches two endpoints and renders a
bare `loading…` (`FeaturedFeed.tsx:64-85`). The fix must not reintroduce the
race the gate exists to prevent.

**Design (two stages, both race-safe):**
1. **Skeleton (trivial):** replace both `loading…` texts (`DiscoverPage.tsx:557`,
   `FeaturedFeed.tsx:84`) with the same pulse-skeleton grid `PaginatedGrid`
   already renders (`PaginatedGrid.tsx:254-266`), extracted into a shared
   `FeedSkeleton` component. No behavior change; kills the blank-text first
   impression on every connection.
2. **SSR the featured payload:** in `app/page.tsx`, fetch
   `/api/timeline?featured=1` and `/api/featured/collections-hydrated`
   server-side (direct function calls or self-fetch with
   `next: { revalidate: 60 }`) and pass `initialFeatured` through `DiscoverPage`
   → `FeaturedFeed`. FeaturedFeed skips its client fetches when initial data is
   provided — so rendering the featured tab *during* the hydration gate fires
   **no** network and cannot race a saved non-default tab. Common case (no
   custom tab order): full content in the SSR HTML. Rare reorderers pay one
   discarded DOM paint, zero fetches — strictly better than today.

**Success:** featured tab paints content (not skeleton) on first HTML for
default-order users; no new fetches during the gate (verify in devtools);
`verify-surfaces` stays green.

## 3. Moment-detail dead-end after poll exhaustion — ✅

**Validated:** `MomentDetailView.tsx:430-460` — 12 × 5s attempts, then the
effect simply stops; media pane stays `loading…`, collect stays disabled via
`!detail`. No terminal state exists. This hits exactly the fresh-mint URLs
people share.

**Design:**
- Add `detailFetchState: 'polling' | 'exhausted'`. On attempt 12 failing, set
  `'exhausted'`.
- Render, in place of the frozen pane: "this moment hasn't loaded — it may
  still be indexing · retry" with a button that resets `attempt = 0` and
  restarts `tryFetch` (reuse the existing closure via a `retryNonce` state
  dependency).
- Pause the poll while `document.visibilityState === 'hidden'` and resume on
  `visibilitychange` (don't burn the 12 attempts in a background tab — the
  common share-open-and-switch-away pattern).
- Keep the existing local-metadata fallback rendering; the retry state only
  replaces the *indefinite* `loading…`.

**Success:** no permanently-frozen detail pages; retry path exercised in a
manual test with a bogus tokenId.

## 4. One-tap web collect (resume intent after connect) — ✅

**Validated:** web path: `useEnsureConnected.ts:43-45` opens the RainbowKit
modal and returns `null`; both collect handlers bail on null
(`MomentCard.tsx:280-281`, `MomentDetailView.tsx:543-544`). Mini-app path
already connects-and-continues in one tap. RainbowKit's `openConnectModal` has
no promise/callback — resumption must watch wagmi state.

**Design:** a small `usePendingAction` hook (shared by card + detail):
- On `ensureConnected() === null` **on web**, store
  `pendingRef = { fn: handleCollect, expiresAt: now + 90s }` and show toast
  "connect to continue your collect".
- Effect on `[isConnected, connectModalOpen]` (wagmi `useAccount` +
  RainbowKit `useConnectModal`):
  - connected && pending && !expired → clear pending, fire `fn()` once
    (a status toast "continuing your collect…" precedes the wallet prompt so
    the popup isn't a surprise).
  - modal closed && !connected → clear pending silently (user changed their
    mind; no nagging).
- Guard rails: single-shot latch (reuse the collect re-entrance latch),
  clear on unmount, never persist across navigation, TTL guards a stale
  intent. The prepare path re-reads sale state on-chain anyway, so a
  different-than-expected account is safe by construction.

**Success:** on web, one tap → connect → wallet confirm, no second hunt for
the button. The mini-app path is unchanged.

## 5. Residencies disclosure at the CTA — ✅

**Validated firsthand:** default ON at 5% (`MintForm.tsx:330,334`,
`lib/config.ts:25`); the toggle renders immediately *after* the submit button
(`MintForm.tsx:1991` vs `:2004`), visually snug (`-mt-2`) — visible, but below
the action in reading order. A top-to-bottom filler can mint before registering
a revenue-affecting opt-out.

**Design (transparency without burying the program):**
- Keep default ON (supporting residencies is a legitimate product stance) —
  this is a *disclosure* fix, not a default change. Flag explicitly: moving the
  default is a separate product/revenue decision, not part of this item.
- Move the toggle block into the pricing/splits group (it *is* economically a
  split — the code already treats it as one, `MintForm.tsx:487-507`), so it's
  encountered while the creator is thinking about money, before the CTA.
- Add a one-line pre-mint summary directly above the button whenever the cut
  is active: `mint · 5% supports residencies · change` (anchor-scrolls to the
  toggle). One glance = informed consent; zero extra taps for creators who are
  fine with it.
- Belt-and-braces: the existing over-cap toast copy already handles conflicts;
  no server change needed (server trusts the signed intent's splits hash).

**Success:** the cut is visible above the CTA in reading order; residencies
opt-out rate is the honest number (measure once #9's counters exist).

## 6. Batch distribute ("get paid" in one action) — ✅, simpler than assumed

**Validated:** distribute is **not** a wallet transaction. It's a signed
message + nonce POSTed to `/api/distribute`, which inprocess relays
(`useMomentSplits.ts:132-168` — `signMessageAsync` over a structured text,
server returns the tx hash). The profile already aggregates pending balances
across up to 100 split moments (`lib/pending.ts:85,155-229`) but the tooltip
says "open a moment to distribute" (`ProfileStats.tsx:334-340`). So batch
distribute needs **no** EIP-5792, no gas UX — one signature over a list + a
server loop.

**Design:**
- **API:** `POST /api/distribute/batch` accepting
  `{ items: [{ splitAddress, collectionAddress, tokenId, currency }...] (≤20),
  callerAddress, signature, nonce }`. Signed message = the existing format
  generalized: header + canonical digest of the sorted item list (mirror the
  `hashSplits` pattern in `lib/intent.ts` — hash the list, put the hash in the
  message so the signature binds the exact set).
- **Server:** verify nonce + signature once; per item re-verify authorization
  exactly as the single-item route does (creator / admin / recipient /
  platform-admin) and re-check a non-zero balance (skip zero — don't relay
  no-ops); call the same inprocess distribute per item **sequentially with a
  small delay** (respect the upstream; it's a relay, not a race); return
  per-item `{ ok, hash | error }`.
- **UI:** the ProfileStats pending line gains `distribute all (N)` when the
  viewer `canDistribute` more than one moment. One signature → progress line
  "distributing 3/7…" → per-item results, partial failures listed with a
  retry-failed affordance. Single-moment flow in MomentDetailView is unchanged.
- **Bounds/abuse:** N ≤ 20 per call; same rate limit family as `/api/distribute`;
  idempotent because a distributed split has zero balance on re-check.

**Success:** a 10-moment artist gets paid with one signature instead of ten
open-sign-wait loops.

## 7. Follower fan-out priority — ⏸ deferred (validation overturned the finding)

**Validated:** the review claimed `_forcePriority: true` in `fanoutToFollowers`
(`lib/notifications.ts:263`) contradicts the "listing_created stays
non-priority" design note. It does not. `isPriority`'s final branch returns
`following || isKnown` — every fan-out recipient is by definition a follower,
so `isPriority` would return `true` for them anyway. `_forcePriority` is a
documented **performance shortcut** (skips 2 Redis reads per recipient), not a
semantics override. The "stays non-priority" comment refers to there being no
*unconditional* priority for listings — consistent with the code.

**Why defer:** the remaining concern ("everything from followed accounts badges
the bell" → badge fatigue) is a product hypothesis about intended behavior,
with zero measurement available (no analytics exist — `lib/clientError.ts:1-12`).
Changing it blind risks the opposite failure (followers missing drops from
artists they chose to follow — the core retention loop).

**If evidence arrives** (via #9's counters: bell-open rate vs badge rate):
demote specific fan-out types by passing computed priority instead of
`_forcePriority` for `listing_created` (keep mint/drop events priority), a
~10-line change confined to `fanoutToFollowers` + `isPriority`.

## 8. Seller proceeds breakdown — ✅

**Validated:** royalty (EIP-2981 read) and the 1% platform fee are computed
only *inside* the listing submission, after approval (`ListButton.tsx:145-161`);
the seller signs an order netting `price − royalty − fee` having never seen the
number. The floor error names no floor (`ListButton.tsx:114`); the constant
exists (`MIN_LISTING_PRICE_BASE_UNITS`, `lib/platformFee.ts`).

**Design:**
- On price input (debounced ~400ms, and on blur), read `royaltyInfo` for the
  entered price (cheap view call; cache per collection+price) and render under
  the input:
  `you'll receive ≈ 0.0475 ETH · (0.05 − 0.0020 royalty − 0.0005 platform 1%)`
  using the existing `formatPrice`. If the royalty read fails, show
  `price − 1% fee` and label royalty "if applicable".
- Floor error becomes: `Minimum listing price is ${formatPrice(MIN_LISTING_PRICE_BASE_UNITS, currency)}`.
- Market header (`MarketView.tsx:48-49`) gains "· 1% platform fee" so the fee
  is public policy, not fine print.

**Success:** no seller signs an order without having seen their net; support
questions about "where did X go" have an on-screen answer.

## 9. Onboarding — 🔶 rescoped by validation

**Validated, and sharper than reported:** the real dead-end is at intent time:
in a Base-App-style host where the `eth_accounts` handoff didn't fire,
`useEnsureConnected` tries the host connector, **catches the failure and
returns `null`** (`useEnsureConnected.ts:34-40`) — so tapping *collect does
nothing at all*. The nav name-tap fallback exists (`WalletButton.tsx` onClick →
`openConnectModal`) but its only signpost is a hover `title` tooltip, invisible
on touch. Meanwhile, the app has **no analytics of any kind**
(`lib/clientError.ts:1-12`) — a first-run interstitial would be built blind and
un-measurable.

**Design (three parts, in order):**
1. **Fix the intent-tap dead-end (hours, do now):** in `useEnsureConnected`,
   when the host connector fails, fall through to `openConnectModal?.()`
   instead of returning null — the same recovery the nav button already offers,
   now at the moment of intent. Keep returning null (caller stays put), but the
   picker is open. ~3 lines.
2. **Measure before educating (small):** first-party, privacy-light funnel
   counters — no third-party SDK (bundle §8 concern), just `after()`-style
   Redis increments on: landing view, first card interaction, connect-modal
   open, connect success, collect attempt/success, mint attempt/success. The
   `/api/client-error` pattern is the template. This also unblocks #7's
   deferred decision and makes #5's opt-out rate visible.
3. **Context, not a tour (product-gated):** hold the interstitial until (2)
   shows where the funnel actually leaks. Cheap in the meantime: one
   dismissible line above the feed for never-connected visitors ("browse
   freely — connecting a wallet lets you collect; you approve every action"),
   and empty-state copy that explains rather than just says "no items".

**Success:** zero-response collect taps eliminated; a funnel dashboard exists;
any future interstitial is justified by its numbers.

## 10. Contrast + modal focus — ✅

**Validated:** on `surface #111`: `muted #555` ≈ 2.5:1, `faint #333` ≈ 1.5:1 —
both far below WCAG AA 4.5:1 for body text (`tailwind.config.ts` colors);
`faint`-class text and hardcoded `#333/#444` helper copy appear ~121× / 30
files. The 4.5:1 threshold on `#111` requires ≥ `#7d7d7d`. `ModalOverlay` has
dialog semantics + Escape but no focus trap or focus-restore; the notification
drawer lacks `role="dialog"` entirely (`NotificationModal.tsx:243-246`).

**Design:**
- **Tokens, not call sites:** retune `muted` → `#949494` (≈5:1 on `#111`) as
  the standard secondary-text color; add `subtle: #6e6e6e` (≈3.2:1) permitted
  only for large text (≥18.7px bold / 24px) and decorative glyphs; **reclassify
  `faint` as a border/ornament token — never text**. Sweep the 121 uses:
  informational text → `muted`; decorative → `subtle`/`faint` as appropriate;
  replace hardcoded `text-[#333]/text-[#444]` helper copy (notification
  settings) with `muted`.
- **Enforce like the repo enforces everything else:** a
  `scripts/verify-a11y-text.mjs` in `npm run check` that greps for
  `text-faint`, `text-[#3`, `text-[#4` in components and fails with the
  offending lines — the same oracle culture as `verify-agent-*`.
- **Focus:** one `useFocusTrap(ref, active)` hook (~40 lines, no dependency):
  on activate — save `document.activeElement`, focus first tabbable; on Tab —
  cycle within; on deactivate — restore focus. Apply to `ModalOverlay`, the
  notification drawer (+ `role="dialog" aria-modal="true"`), and the search
  modal. Keep the existing Escape/scroll-lock handling.
- Aesthetic check: `#949494` vs `#555` is a visible lightening — review with
  the design eye on the themed profile surfaces (`prefers-reduced-motion` and
  theming already handled well; contrast is the outlier).

**Success:** AA pass on secondary text; keyboard/screen-reader users can't
tab into the background feed behind a modal; CI blocks regressions.

---

## Sequencing

- **Now (hours each):** 3 (retry state) · 9.1 (ensureConnected fallback) ·
  8 (proceeds line) · 5 (residencies disclosure) · 2.1 (skeleton)
- **This sprint:** 4 (resume intent) · 2.2 (featured SSR) · 10 (tokens + trap +
  CI oracle) · 9.2 (funnel counters)
- **Infra track:** 1 (CDN + gateway — already urgent in the RCA)
- **Needs a day of API design:** 6 (batch distribute)
- **Deferred pending data:** 7 (fan-out priority) · 9.3 (interstitial)
