# Collector Downloads ("download zip after collect") — Design

_Design research for the feature requested by Andrea Boi (andreaboi.eth): a
downloadable file attached to an artwork, uploaded directly on Kismet, gated to
collectors, replaceable after mint ("upgradable"), with a notification to prior
collectors when a new version lands — and, as a second act, "playing live with
online emu". Grounded in a full read of the collect, upload, gating and
notification subsystems; every mechanism claim below carries a `file:line`
anchor into today's code._

---

## 0. What the artist actually asked for

The request, assembled from the conversation:

1. *"Download zip file after collect or playing live with online emu? I can
   create something with new artworks"*
2. *"if I could manage to upload directly from Kismet and then people could
   download after purchase, than would be great. No need to be a NFT, this
   could be not on-chain and also upgradable. I think to add music but is not
   ready yet. The file is just 131 KB at the moment"*
3. *"also for files: notification when the file is updated so if you have
   already purchased and downloaded, but I've updated it with new features,
   people can download again the new file"*

And the test file (Google Drive, `Pixel Art Gallery - Sylvester.zip`, 357 KB):

```
Pixel Art Gallery - Sylvester/
├── Pixel Art Gallery - Sylvester.gb        # 131,072 bytes — a real Game Boy ROM
│                                           #   header title "PIXELARTGALLERY",
│                                           #   DMG, MBC5+RAM+BATTERY (has save memory)
├── Pixel Art Gallery - Sylvester.png       # 293 KB cover art (the framed pixel cat)
└── Custom overlay/
    ├── dmg_kismet_black.{png,cfg}          # RetroArch overlay skins, KISMET-branded,
    └── dmg_kismet_white.{png,cfg}          #   "for Anbernic RG35XX/RG40XX … muOS CFW"
```

So the artwork is a **playable Game Boy cartridge**: an interactive pixel-art
gallery that runs on real handheld hardware (the overlays are for Anbernic
devices) or in any GB emulator. The "131 KB" in the message is literally the
ROM. "Add music" means a future ROM revision. "Online emu" means running the
`.gb` in a browser emulator on the artwork page.

**The experience, precisely:**

- **Artist:** attach a zip to an artwork from inside Kismet (no Google Drive
  hand-offs); later replace it with a new version; collectors get told.
- **Collector:** the artwork page advertises "includes a download for
  collectors"; after collecting (primary mint, gift, airdrop — or a secondary
  buy) a Download button appears; when the artist ships v2, a notification and
  an "update available" badge bring them back to re-download.
- **Everyone (optional, artist-controlled):** press Play and run the ROM in an
  embedded emulator without owning it — the live demo that sells the collect.

The artist explicitly does **not** want this on-chain or in the NFT: *"No need
to be a NFT, this could be not on-chain and also upgradable."* That sentence is
load-bearing for the design below — it licenses keeping the file entirely in
Kismet's own layer (Redis pointer + storage), which also happens to dodge a
known production bug (§4.2).

---

## 1. Constraints from our stack (validated)

| Fact | Evidence | Consequence |
|---|---|---|
| Arweave bytes are unconditionally public; anyone with the txid can `curl arweave.net/<txid>` | `lib/arweave/gateways.ts:39-49`, `lib/inprocess.ts:229` | A plaintext "hidden" upload is not gated — and all platform uploads are signed by ONE wallet (`NEXT_PUBLIC_ARWEAVE_N` / `ARWEAVE_JWK`), so txids are enumerable via Arweave GraphQL by owner. Gated bytes must be **encrypted at rest**. |
| No encryption exists anywhere in the codebase | repo-wide grep: only RSA-PSS signing (`app/api/sign/route.ts:67`), webhook HMAC, SHA-256 cache keys | Envelope encryption is greenfield — keep it minimal. |
| `/api/upload` accepts JSON only (415 otherwise), 50 MB cap | `app/api/upload/route.ts:16,41-43` | The zip needs its own server route; `lib/arweave/uploadServer.ts:26` `uploadBytesToArweave(data, contentType)` already exists for exactly this "server ingests bytes" shape (built for the MCP mint path). |
| Redis is the only datastore, total footprint ~336 KB, with an explicit direction to keep list-shaped/blob data OFF it | `REDIS_IMPLEMENTATION_REVIEW.md:588`, `SCALING.md:377` (10 MB max request / 100 MB max value), §B3 | Redis holds the **pointer and version history**, never the bytes. A "few MB with music" zip base64'd through the 10 MB request cap into a 336 KB database is the wrong shape. |
| Post-mint metadata updates are shipped and artist-authorized on-chain | `app/api/moment/update-uri/route.ts:24 canUpdateUri()` — ADMIN(2)\|METADATA(16) via `lib/permissions.ts` | We reuse the same permission predicate for "who may attach/replace the file". |
| **But** a tokenURI update makes inprocess rewrite `created_at`, which re-ranked edited moments as fake new mints (production incident 2026-07-20) | `lib/notifications.ts:157-165` (the `MomentMeta.createdAt` pin exists because of it) | File updates must NOT ride tokenURI updates. An artist adding music would catapult the artwork to the top of the feed every time. Redis-side state sidesteps this entirely — and matches "not on-chain, upgradable". |
| Server-side ownership truth is a live `balanceOf`; the Redis collected ZSET is event-sourced and misses secondary buyers / keeps sellers forever | `lib/raffle.ts:151 holdsEdition()` (fails closed) vs `lib/collected.ts:13-15` docstring | The download gate must be `holdsEdition`, not `isCollected` — otherwise every Seaport buyer is denied and every seller keeps access. |
| A Mini App signer can differ from the identity wallet; the Patron gate shipped that bug once already | `PATRON_GATE_MINIAPP_RCA.md`; fix = address union `lib/addressUnion.ts:33 expandToFidSiblings` | The gate must check the whole verified-wallet union, or a real collector on Farcaster gets "collect to download" on art they own. |
| Auth is already unified: SIWE cookie + Farcaster Quick-Auth JWT resolve through one call | `lib/session.ts:72 getSessionAddress(req)` | Downloads need no new signature ceremony. |
| There is no per-artwork collector index; the only "notify an audience" precedents are the raffle entrant set and follower fanout | `app/api/raffle/manage/route.ts:168 announceOutcome`, `lib/notifications.ts:303 fanoutToFollowers` (FANOUT_BATCH=50, warn at 1000) | Update notifications need a new reverse index, mirror-written at the collect sites (§6.1). |
| One notification pipeline feeds both the bell and Farcaster push | `lib/notifications.ts:199 writeNotification` → lazy `dispatchFarcasterPush` (`lib/farcasterNotifications.ts:626`); push: ≤32-char title, ≤128-char body, 100 tokens/request, targetUrl host must equal SITE_URL | One new notification type serves both channels. |
| No email channel exists at all | repo-wide grep | "Notify collectors" = bell + FC push + on-page badge. The badge matters: push tokens exist only for Mini App users who opted in. |
| Memory-heavy bounded routes are an accepted pattern | `/api/transcode-gif` buffers ≤300 MB at `MAX_CONCURRENT=1` (`OPS_RUNBOOK.md`) | Buffering a ≤32 MB zip for encrypt/decrypt with a small concurrency cap is inside established practice. |
| No iframe/interactive/zip media kind exists; CSP is Report-Only and already allows `frame-src 'self'`, `worker-src blob:` | `lib/media/resolveMomentMedia.ts`, `next.config.mjs:19-31` | The zip is an **attachment**, not the display media (the cover PNG stays the artwork). The emulator (§7) embeds cleanly later. |

---

## 2. Design in one picture

```
ARTIST (creator or on-chain METADATA admin)
  │  PUT /api/bundle  (zip ≤32MB + optional release note)
  ▼
[server] session → canEditMomentMetadata → pause/blacklist → quota
  → sniff zip magic (PK\x03\x04) → sha256
  → AES-256-GCM encrypt  (key = HKDF(BUNDLE_MASTER_KEY, coll:id:version))
  → uploadBytesToArweave(ciphertext, 'application/octet-stream')  ← platform pays
  → verifyArweaveAvailable → Redis: bump version, append history
  → after(): fanout file_update to collectors index (≤1/artwork/24h)

COLLECTOR
  │  GET /api/bundle/download?collection=&tokenId=
  ▼
[server] getSessionAddress → expandToFidSiblings (≤10 wallets)
  → holdsEdition() live balanceOf, fails closed
  → fetch ciphertext from arweave.net → decrypt → stream
    Content-Disposition: attachment; Cache-Control: private, no-store
  → record wallet's downloaded version (powers "update available" badge)

EVERYONE (artwork page)
  "⬇ Includes a collector download · Sylvester.zip · 357 KB · v2 · updated Aug 25"
   └─ not holder → "Collect to download"   └─ holder → Download (+Update badge)
   └─ creator  → Manage panel: replace / history / notify / download count

PHASE 2 — PLAY:  [▶ Play] → /artwork/…/play → sandboxed iframe → binjgb (wasm)
   ROM streamed from /api/bundle/rom under the same gate (or public, per artist)
```

**What this is NOT:** DRM. A collector can share the zip after downloading —
exactly as with Bandcamp downloads. The gate is an ownership perk and an
anti-scraping measure, not copy protection; the ROM is also inherently
copyable from any emulator's memory. We say this plainly in the doc so nobody
later "hardens" the feature into hostile territory.

---

## 3. Storage: encrypted at rest on Arweave, pointer in Redis

**Decision: ciphertext on Arweave via the existing server Turbo path; AES-256-GCM;
per-version keys derived from one env master key; version history in one Redis
key per artwork.**

Why this beats the alternatives (§9 has the full table): it adds **zero new
infrastructure** to a stack whose five load-bearing dependencies are counted
individually (`STACK_OVERVIEW.md §0`), it reuses `uploadBytesToArweave`
(`lib/arweave/uploadServer.ts:26`) whose own header comment says "callers MUST
bound abuse before calling — this helper only moves bytes", it inherits
permanence (every version of the art object survives us), and ciphertext makes
Arweave's radical publicness harmless.

Mechanics:

- **Key derivation** — one new secret, `BUNDLE_MASTER_KEY` (32 random bytes,
  base64, same operational class as `ARWEAVE_JWK`). Per-version key =
  `HKDF-SHA256(master, salt = "kismet-bundle-v1", info = "<collection>:<tokenId>:<version>")`.
  No keys in Redis, nothing to rotate per artwork, nothing that can be
  partially lost. Node's built-in `crypto.hkdfSync` + `createCipheriv` — no new
  dependency.
- **Encrypt** — AES-256-GCM, random 12-byte IV stored in the version record,
  auth tag appended to ciphertext. Files are capped at 32 MB (§10), so
  buffer-encrypt/buffer-decrypt is fine under the transcode-gif precedent;
  no streaming-cipher complexity.
- **Upload** — `uploadBytesToArweave(ciphertext, 'application/octet-stream')`.
  Tagged type is octet-stream on purpose: the Arweave-visible object discloses
  nothing (no File-Name tag). Then `verifyArweaveAvailable(uri, budgetMs)`
  (`lib/arweave/verifyAvailable.ts`) before the version is activated — the same
  propagation soft-gate the mint flow uses, so a collector never clicks
  Download into a 404.
- **Threat model, stated honestly:** compromise of `BUNDLE_MASTER_KEY` exposes
  every version ever uploaded, forever (ciphertext is permanent). That is the
  same blast-radius class as `ARWEAVE_JWK` (hot funding wallet) and
  `SESSION_*` secrets, and it protects a perk, not funds. Accepted. If Kismet
  ever sunsets, publishing the master key is a graceful degradation: every
  collector download becomes a public permanent file — arguably the right
  end-state for an art platform (worth confirming with artists; §11).

**Who pays:** the platform, as with all media (`lib/arweave/paidBy.ts`).
A 357 KB version costs well under a cent at Turbo rates; the 32 MB cap bounds a
version at roughly a quarter. The per-identity quota (§10) bounds the sum.

---

## 4. Data model (Redis)

All keys follow the existing `kismetart:` prefix and the canonical per-artwork
identity — lowercased collection + `BigInt(tokenId).toString()`
(`app/api/collect/route.ts:202` is the canonicalization precedent).

```
kismetart:bundle:<collection>:<tokenId>            STRING (JSON), no TTL
  {
    v: 3,                              // current version, monotonically increasing
    name: "Pixel Art Gallery - Sylvester.zip",
    size: 365396,                      // plaintext bytes
    sha256: "79919fea…",               // plaintext hash — shown to collectors, used for dedup
    mime: "application/zip",
    uri: "ar://<txid-of-ciphertext>",  // NEVER surfaced to clients
    iv: "<base64 12B>",
    note: "added music!",              // optional artist release note, ≤140 chars
    updatedAt: 1787…, updatedBy: "0x…",
    notifiedAt: 1787…,                 // last fanout, for the 24h cooldown
    playable: null | {                 // Phase 2 (§7)
      romPath: "Pixel Art Gallery - Sylvester/….gb",
      access: "collectors" | "public"
    },
    history: [ {v, uri, iv, size, sha256, note, updatedAt, updatedBy}, … ]  // last 20
  }

kismetart:bundle-dl:<collection>:<tokenId>         HASH  addr → version last downloaded
                                                   // powers "update available"; also the
                                                   // artist's download count (HLEN)

kismetart:collectors:<collection>:<tokenId>        ZSET  member=addr, score=first-collect ms
                                                   // the NEW reverse index, §6.1
```

Reads of `kismetart:bundle:*` on the gated path go through `strictRead`
(`lib/redisRead.ts`) — the same fail-closed posture `hiddenMoments` uses, so a
Redis outage can't leak or corrupt gated state. The public descriptor
(existence, name, size, version, updatedAt — **not** `uri`/`iv`) is assembled
into the artwork page payload next to the other Kismet augmentations in
`app/artwork/[address]/[tokenId]/page.tsx:262-268`'s `Promise.all`.

### 4.1 Why not in the token metadata JSON?

`kismet_thumbhash` proves a custom `kismet_*` key round-trips through inprocess
untouched (`lib/inprocess.ts:115-129`), so a `kismet_bundle` field *would*
work. Rejected for v1 because every file replacement would then be a tokenURI
update, which (a) requires the artist's wallet signature + the inprocess PATCH
each time (`app/api/moment/update-uri/route.ts:98,154`), (b) trips the
`created_at` re-rank bug the codebase already carries a scar from
(`lib/notifications.ts:157-165`), (c) publishes the ciphertext txid in public
metadata for no benefit, and (d) contradicts the artist's own "not on-chain,
upgradable" framing. **Phase 3 option:** mirror a URI-free descriptor
(`kismet_bundle: {name, size, sha256, version}`) into metadata on the artist's
*next* organic metadata edit, for portability/provenance — never as its own
update.

### 4.2 Version semantics

- Replace = new version record, `v+1`; history keeps the last 20 (pointer
  records are ~300 bytes; the JSON stays well under a kilobyte per artwork
  beyond the ciphertexts, which live on Arweave).
- Old versions stay downloadable by the artist from the manage panel (mistake
  recovery: "roll back" = re-activate an old record as `v+1`). Collectors only
  ever see current.
- Same-bytes replace (identical sha256) is a no-op with a toast, so a nervous
  double-click can't burn the notification cooldown.

---

## 5. API surface

New route family `app/api/bundle/` (no existing route can be reused: `/api/img`
is deliberately unauthenticated + CDN-cacheable, `app/api/img/route.ts:386-395`,
and must stay that way).

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/bundle?collection=&tokenId=` | PUT | session + `canEditMomentMetadata` | Attach or replace. Raw zip body (`Content-Type: application/zip`, `x-file-name` header), optional `?note=`. Sniffs `PK\x03\x04` magic, hashes, encrypts, uploads, verifies, commits. Returns the new public descriptor. |
| same | GET | session + creator/admin | Full manage view: descriptor + history + download count (`HLEN bundle-dl`). |
| same | DELETE | session + `canEditMomentMetadata` | Detach (clears current pointer, keeps history). |
| `/api/bundle/download?collection=&tokenId=` | GET | session → sibling union → `holdsEdition` | Decrypt-and-stream, `Content-Disposition: attachment; filename="<name>"`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. Writes `bundle-dl` hash. 401 no session / 403 not a holder / 404 no bundle. |
| `/api/bundle/notify` | POST | session + `canEditMomentMetadata` | Explicit "tell collectors" (also offered as a checkbox inside PUT). Enforces the 24 h per-artwork cooldown; returns reach estimate. |
| `/api/bundle/rom?collection=&tokenId=` | GET | per `playable.access` | **Phase 2.** Streams the single ROM file extracted from the zip for the web player. |

Guardrails on every route, all existing helpers:

- `checkRateLimit` (`lib/ratelimit.ts:31`): `bundle-put:<ip>` 5/60s,
  `bundle-dl:<ip>` 20/60s.
- `consumeUserQuota` (`lib/userQuota.ts:126`), new kinds:
  `'bundle-upload': {day: 20, week: 60}` plus a debit against the existing
  `'upload-bytes'` meter (it is the Arweave spend meter — `app/api/upload/route.ts:66`);
  `'bundle-download': {day: 100, week: 400}` so a holder's session can't be
  farmed as a free CDN.
- Platform pause + blacklist checks on PUT, exactly as `update-uri` does
  (`app/api/moment/update-uri/route.ts:116`).
- Artist authorization = the shared on-chain predicate `canEditMomentMetadata`
  (`lib/permissions.ts:29-37`) — authoritative, covers co-admins, and mirrors
  the client's `useMomentEditPermission` gate so the manage panel and the
  server agree. (KV `getMomentMeta().creator` equality is the documented
  fallback for pre-KV moments, as in `app/api/moment/hide/route.ts:51-88`.)
- Decrypt concurrency cap (`MAX_CONCURRENT = 4`) on the download route, the
  `transcode-gif` pattern; at 32 MB ceiling that bounds worst-case buffering at
  128 MB against the 4 GB heap.

### 5.1 The ownership gate, precisely

```ts
const address = await getSessionAddress(req)              // lib/session.ts:72 — cookie OR FC JWT
if (!address) return 401
const wallets = await expandToFidSiblings(address)        // lib/addressUnion.ts:33 — ≤ verified union
const holds = await holdsAny(collection, tokenId, wallets) // balanceOfBatch, fails closed
if (!holds) return 403
```

- `expandToFidSiblings`, **not** `expandToGateWallets` — the latter is
  Pass-specific (blacklist coupling, smart-wallet exclusion) and the RCA
  lesson is that skipping the union re-creates the "real holder told to buy"
  bug in Mini Apps.
- `holdsEditionBatch` is currently module-private in `lib/raffle.ts:181` —
  export it (or lift both helpers into `lib/ownership.ts`) rather than
  re-implementing.
- Live `balanceOf` means **secondary buyers get access the moment the Seaport
  fill lands, and a seller who parts with their last edition loses it** — the
  token is the license. This is a feature, and it is also the only correct
  option (`lib/collected.ts` misses both cases by design).
- Cache the positive verdict 60 s in Redis keyed `(address, artwork)` to absorb
  the double-click, nothing longer — RPC reads are cheap and staleness on a
  gate is worse.

---

## 6. Versioning notifications ("people can download again the new file")

### 6.1 The audience index (new, required)

Nothing today can enumerate collectors of one artwork — `lib/collected.ts` is
forward-only (collector → artworks), inprocess has no `/owners` endpoint, and
ERC-1155 has no on-chain enumeration. The raffle solved the same problem with a
per-artwork entrant set; we do the collector version:

`kismetart:collectors:<collection>:<tokenId>` (ZSET, §4), mirror-written at the
four places a collector becomes known:

1. `app/api/collect/route.ts:418` — next to the existing `recordCollected`
   (primary mints + gifts; the recipient, not the payer).
2. `app/api/airdrop/notify/route.ts:414` — each on-chain-verified recipient.
3. `app/api/webhooks/pass-transfer/route.ts:168` — the webhook's mint branch.
4. `app/api/listings/[id]/route.ts` fill path (~`:265`, where the `sale`
   notification already knows the receipt-verified buyer) — **the one site the
   forward index never covered**, so secondary buyers get update
   notifications too.

Event-sourced from ship date, like the forward index (`lib/collected.ts:14-15`
states the same caveat). Backfill for already-minted artworks (Sylvester will
predate the feature): a one-shot script walking `alchemy_getAssetTransfers`,
cloned from `scripts/reconcile-pass-validity.mjs:142` — run it on demand for
artworks that attach a bundle, not globally.

### 6.2 The notification

New type `file_update` in `ALL_NOTIFICATION_TYPES` (`lib/notifications.ts:6`).
A new type deliberately touches seven sites — all exhaustive switches, so the
compiler walks you through them: `compose()` (`lib/farcasterNotifications.ts:346`),
`notificationHref()` + `NotificationContent` (`components/NotificationRow.tsx:21,45`),
`TYPE_LABELS` + `PUSH_TYPE_LABELS` (`components/NotificationModal.tsx:18,33`),
`DRAGGABLE_FILTERS` (`components/NotificationFeed.tsx:20`), and an
`isPriority` branch (`lib/notifications.ts:168`) — priority: yes, the
recipient paid for this file.

Copy (within the 32/128 hard caps, `lib/farcasterNotifications.ts:311-312`):

> **Download updated** · "Pixel Art Gallery – Sylvester" has a new file from
> @andreaboi — tap to download v2. _(+ artist note when present)_

Semantics:

- **Muteable per-type** (respect the user's list) but added to
  `BURST_DEDUP_TYPES` (`lib/notifications.ts:99`) keyed
  `(recipient, artwork)` so three saves in a row collapse — plus the
  server-side ≥24 h per-artwork fanout cooldown (§5), which is the real
  anti-spam. The dedup+cooldown pair is what makes giving artists a "notify"
  button safe.
- **Push opt-in:** today only `collect` is seeded on (`DEFAULT_ENABLED_PUSH_TYPES`,
  `lib/farcasterNotifications.ts:106`). Recommendation: seed `file_update` on
  for new registrations — it is the closest thing Kismet has to "a thing you
  own changed", the category push exists for. Existing users get the bell
  regardless. (Team call; flagged in §11.)
- **Fanout:** in `after()`, the raffle `announceOutcome` shape
  (`app/api/raffle/manage/route.ts:168`) with `fanoutToFollowers`'s chunking
  discipline (`lib/notifications.ts:296-330`: batches of 50, `_forcePriority`,
  warn at 1000). Before writing, filter the ZSET through the exported
  `holdsEditionBatch` (chunks of 200, `lib/raffle.ts:181`) so ex-holders who
  sold aren't pinged about a file they can no longer download; above ~2,000
  members skip the filter and log, per the no-silent-caps convention.

### 6.3 The passive path (reaches everyone)

Push reaches only Mini App users with tokens; the bell reaches signed-in users.
The floor is the page itself: the collector card shows **"Update available —
v3"** whenever `bundle.v > HGET bundle-dl <addr>`, on the artwork page and on
the collected tab. Cheap (one HGET alongside reads the page already does) and
it is the mechanism that actually guarantees "people can download again the
new file" for every collector eventually.

---

## 7. Phase 2 — "playing live with online emu"

The artwork stays a normal Kismet moment (cover PNG as `image` — for Sylvester
that's the framed cat). Play is a page affordance, not a new media kind, so
nothing in `resolveMomentMedia` changes.

- **Emulator: binjgb** — MIT-licensed, C-compiled-to-wasm, cycle-accurate DMG
  (+ passable CGB), battery saves + save states + rewind, a five-file embed.
  Self-hosted under `public/gb-player/` exactly like `public/ffmpeg-core/`
  (existing precedent for vendored wasm; CSP already allows
  `script-src blob:`/`worker-src blob:`, `next.config.mjs:22`). EmulatorJS
  (GPLv3, multi-system RetroArch build) is the later path if artists start
  shipping NES/GBA works — heavier and license-noisier, not needed for GB.
- **Surface:** `[▶ Play]` on the artwork page opens `/artwork/[address]/[tokenId]/play`
  in a sandboxed same-origin iframe (`frame-src 'self'` already permitted):
  canvas + touch D-pad/A/B (Mini App users are on phones), keyboard on
  desktop. Battery saves persist to `localStorage` per artwork — the
  Sylvester cart has battery RAM, so a collector's gallery progress survives
  revisits.
- **ROM delivery:** at attach time the server walks the zip's central
  directory; if exactly one `.gb`/`.gbc` entry exists it records `romPath`
  (Sylvester's zip qualifies — junk `__MACOSX`/`.DS_Store` entries are
  ignored). The player fetches `/api/bundle/rom`, which decrypts and serves
  that single entry.
- **Access is the artist's dial**, because it is a real trade-off they should
  own: `playable.access = 'public'` turns the page into a live demo anyone can
  try (the collect pitch — but the ROM bytes are then necessarily public to a
  motivated scraper), while `'collectors'` keeps play as part of the purchased
  perk. Default `'collectors'`; surface the implication in the manage panel in
  one sentence.
- **Later polish:** render the artist's own overlay art (the zip ships
  Kismet-branded bezels!) as the player chrome — reading
  `Custom overlay/*.cfg` is trivial and it would make the web player *theirs*.

Phase 2 is genuinely severable: Phase 1 ships value alone, and Sylvester is
playable on real hardware from day one via the zip.

---

## 8. UX summary

- **Artwork page, everyone:** under the collect box —
  `⬇ Includes a collector download · Sylvester.zip · 357 KB · v2 · updated Aug 25`.
  Advertising the perk to non-holders is the point (Bandcamp's "includes
  high-quality download" line); it links to a "collect to unlock" state.
- **After collect:** the existing success state (`MomentDetailView.tsx:672-683`
  optimistic `collected` + `refetchOwnedBalance`) gains a "Your download is
  ready" row — the moment of maximum delight, don't make them hunt.
- **Holder:** Download button (+ sha256 shown small, for the checksum-minded),
  "Update available" badge when stale (§6.3).
- **Creator:** manage panel in the existing edit surface
  (`useMomentEditPermission` gates it client-side): attach/replace (drag-drop,
  `.zip` accept, 32 MB), release note field, "Notify collectors" checkbox with
  live reach estimate, version history with rollback, download count.
- **Mint form:** Phase 1 attaches from the artwork page after mint (works for
  already-minted artworks — including Sylvester's, and the tokenId doesn't
  exist before mint). A staged "attach on create" upload inside `MintForm` is
  a Phase 3 nicety.

---

## 9. Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Plaintext zip on Arweave, txid kept "secret" in Redis | **Rejected** | All uploads are signed by one platform wallet — txids are enumerable by owner via Arweave GraphQL; a leak is permanent and unrotatable. Security by obscurity on a permanent public ledger. |
| Zip in `animation_url` / token metadata | **Rejected** | Public by definition; every update = tokenURI PATCH = artist signature + the `created_at` re-rank bug (`lib/notifications.ts:157`); contradicts "not on-chain". |
| Bytes in Redis (base64) | **Rejected** | 336 KB database today; 10 MB request cap sits exactly where "add music" lands; SCALING.md §B3 explicitly directs list/blob data off Redis; per-download bandwidth billing. Workable only as a demo hack. |
| Private bucket (Cloudflare R2/S3) + signed URLs | **Viable, not chosen** | Operationally clean (no crypto, cheap egress, mutable) — but it adds a sixth load-bearing external dependency with credentials to a stack that counts them, loses permanence, and still needs the same gate route. Revisit if bundles outgrow 32 MB (video packs, albums) — the gate/versioning/notification layers all survive that swap unchanged. |
| Lit Protocol / token-gated decryption in the client | **Rejected** | New protocol dependency + wallet-side decryption ceremony for a perk download; the server already holds a simpler trust position (it verifies ownership anyway). |
| NFT-native (encode in a new token / onchain blob) | **Rejected** | The artist explicitly asked for the opposite; costs and immutability fight "upgradable". |

Storage decision matrix, compressed: encrypted-Arweave wins on *no new deps,
reuses shipped upload path, permanence, per-version immutability*; its costs
(greenfield envelope crypto ~60 lines of Node builtins, decrypt buffering
bounded at 32 MB × 4) are small and precedented.

---

## 10. Limits, costs, failure modes

- **Size cap 32 MB** per version (server-enforced; client hint in the picker).
  Covers "zip with music" (GB ROMs max out at 8 MB; the whole overlay bundle
  is 0.36 MB) with 100× headroom, bounds decrypt buffering (≤128 MB at
  `MAX_CONCURRENT=4` against the 4 GB heap), bounds Turbo spend (~$0.25/version
  worst case, ~$0.002 for Sylvester today).
- **Quota** (§5) bounds an abusive artist at 20 versions/day and the platform's
  aggregate Arweave spend via the existing `upload-bytes` meter; the global
  `PLATFORM_SIGN_DAILY_CAP` backstop doesn't apply to the server-JWK path, so
  the quota IS the backstop — flagging that explicitly.
- **Fail-closed everywhere on the gated path:** Redis unreachable → `strictRead`
  throws → 503 (never a leak); RPC unreachable → `holdsEdition` returns false →
  403 with a "temporary — try again" body distinguishable from "not a
  collector" (check RPC health in the error path before wording it).
- **Gateway risk:** the Arweave pool is down to `arweave.net` alone
  (`lib/arweave/gateways.ts:19-21`) — a gateway outage takes downloads with it.
  Same exposure all media already has; the optimistic Turbo cache covers the
  fresh-upload window.
- **The zip is served as authored** — no re-zipping (the `__MACOSX` junk in the
  test file ships as-is; a lint-style warning in the manage panel — "your zip
  contains Finder junk" — is Phase 3 polish, not a blocker).

---

## 11. Open questions

1. **Play access default** (§7): is public-preview-play something we want to
   encourage editorially (live demos as collect marketing), or should play stay
   a collector perk by default? Ask Andrea what they want for Sylvester —
   their "or" in message 1 reads like either would delight.
2. **Seed `file_update` push on by default?** (§6.2) — recommendation yes;
   needs a product sign-off since only `collect` is seeded today.
3. **Key escrow / sunset stance** (§3): are we comfortable stating "if Kismet
   winds down we publish the bundle keys and the files become public forever"?
   It's a strong collector-protection story; it should be a deliberate promise,
   not an accident.
4. **Secondary-market framing:** live-balance gating means "sell it, lose the
   download". Correct mechanically; worth one line in the collector UI so
   nobody is surprised.
5. **Does Andrea's piece already exist as a minted moment**, or is it minted
   after the feature lands? Decides whether the collectors-index backfill
   script (§6.1) is in the launch checklist or the drawer.

---

## 12. Build plan

**Phase 1 — download after collect (the ask):**
`lib/bundle.ts` (Redis model + HKDF/GCM helpers, pure logic split for a
`scripts/verify-bundle.ts` oracle wired into `verify:flows`, per the
`lib/gift.ts`/`lib/passTaint.ts` convention) → export `holdsEditionBatch` from
`lib/raffle.ts` (or lift to `lib/ownership.ts`) → `app/api/bundle/` routes →
collectors-index mirror writes (4 sites) + backfill script → `file_update`
type across the seven notification touchpoints → `BundlePanel` component into
`MomentDetailView` + post-collect CTA → quotas/rate limits → test with the
actual Sylvester zip end-to-end (attach → collect on a test edition → download
→ byte-identical sha256 → replace → notification lands → badge shows).

**Phase 2 — play online:** vendor binjgb under `public/gb-player/` → `/play`
page + sandboxed iframe player with touch controls → ROM extraction at attach
time + `/api/bundle/rom` → `playable.access` dial in the manage panel.

**Phase 3 — polish:** overlay-skinned player chrome, zip-hygiene lint,
`kismet_bundle` metadata mirror for portability, attach-at-mint in `MintForm`,
artist download-stats view.

Phase 1 has no migrations, no new external services, one new env secret, and
every novel decision above is anchored to a pattern that already survived
production here.
