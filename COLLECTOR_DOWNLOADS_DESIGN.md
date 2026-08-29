# Collector Downloads ("download zip after collect") — Design

_Design for the feature requested by Andrea Boi (andreaboi.eth): a downloadable
file attached to an artwork, uploaded directly on Kismet, gated to collectors,
replaceable after mint ("upgradable"), with a notification to prior collectors
when a new version lands — and "playing live with online emu"._

> **Revision 2 — post-validation.** The first draft of this document was put
> through a three-track adversarial validation (full claim-by-claim fact-check
> against the code, an attack pass on the storage/crypto/ops decisions, and a
> steel-man of every rejected alternative with independently re-derived cost
> numbers), plus a first-hand re-verification of the auth/identity chain. The
> architecture survived; six claims were wrong, the cost numbers were ~4–5×
> low, three genuine blockers were found in the details, and one sequencing
> decision was demoted from "decided" to "Andrea's call". §13 is the full
> validation record. Every correction is folded into the body below.

> **STORAGE PIVOT (2026-08-27) — bytes now live in Redis, not Arweave.**
> Decided by the team after a validated Redis-vs-Arweave head-to-head, on
> the premise of low expected artist adoption. What that buys: the store is
> **private**, so the entire encryption layer is deleted (no
> `COLLECTOR_FILE_MASTER_KEY`, no HKDF/keyId machinery, no key-loss risk —
> the feature now needs ZERO configuration); uploads are **instantly
> servable** (no propagation `pending` state); artist detach and DMCA
> takedowns are **real deletions**. What it costs, accepted knowingly:
> download bytes flow through the budget-capped Upstash account (mitigated
> by the per-identity download quota, per-IP rate limits, and the premise —
> re-examine at real adoption, where R2 remains the flagged next home), and
> version history keeps **bytes for only the last 3 versions**
> (`CFILE_BYTES_RETENTION`; older rows stay as metadata). New mechanics:
> 4 MiB chunk keys under Upstash's 10 MB request cap (dedicated
> non-pipelining client — see §4), a fail-closed **global storage ceiling** (`CFILE_STORAGE_CEILING_BYTES`,
> default 512 MiB, ledger hash `cfile-bytes`), and crash-safe commits
> (chunks land with a 1 h TTL, PERSISTed atomically with the record write).
> §3's encryption rationale and §10.1's Arweave cost numbers are HISTORICAL
> from here — kept as the record of why the previous design looked the way
> it did. §4 (data model), §4.2 (versioning) and the implementation delta
> reflect the shipped Redis design; the gate (§5), notifications (§6), and
> the UX (§8) are storage-agnostic and unchanged.

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
    # (plus macOS __MACOSX/ AppleDouble junk — including a ._*.gb resource fork,
    #  which matters for ROM auto-detection, §7)
```

So the artwork is a **playable Game Boy cartridge**: an interactive pixel-art
gallery that runs on real handheld hardware (the overlays are for Anbernic
devices) or in any GB emulator. The "131 KB" in the message is literally the
ROM. "Add music" means a future ROM revision (GB music lives inside the ROM;
MBC5 caps a ROM at 8 MiB). "Online emu" means running the `.gb` in a browser
emulator on the artwork page.

**The experience, precisely:**

- **Artist:** attach a zip to an artwork from inside Kismet (no Google Drive
  hand-offs); later replace it with a new version; collectors get told.
- **Collector:** the artwork page advertises "includes a download for
  collectors"; after collecting (primary mint, gift, airdrop — or a secondary
  buy) a Download button appears; when the artist ships v2, a notification and
  an "update available" badge bring them back to re-download.
- **Everyone (artist-controlled):** press Play and run the ROM in a browser
  emulator — as a public live demo that sells the collect, or as a
  collectors-only perk. Which of those it is belongs to the artist (§7, §11 Q1)
  and decides the build order (§12).

The artist explicitly does **not** want this on-chain or in the NFT: *"No need
to be a NFT, this could be not on-chain and also upgradable."* That sentence is
load-bearing for the design below — it licenses keeping the file entirely in
Kismet's own layer (Redis pointer + storage), which also happens to dodge a
known production bug (§4.1).

---

## 1. Constraints from our stack (validated)

| Fact | Evidence | Consequence |
|---|---|---|
| Arweave bytes are unconditionally public; anyone with the txid can `curl arweave.net/<txid>` | `lib/arweave/gateways.ts:39-49`, `lib/inprocess.ts:229` | Gated bytes on Arweave must be encrypted at rest — but see §3 for the *honest* reason (it is subtler than "txids leak"). |
| No encryption exists anywhere in the codebase | repo-wide grep: only RSA-PSS signing (`app/api/sign/route.ts:70`), webhook HMAC, SHA-256 cache keys | Envelope encryption is greenfield — keep it minimal, and pin its one unrecoverable invariant with a known-answer test (§3). |
| `/api/upload` accepts JSON only (415 otherwise), 50 MB cap, session-gated | `app/api/upload/route.ts:16,41-43` | The zip needs its own server route; `lib/arweave/uploadServer.ts:26` `uploadBytesToArweave(data, contentType)` already exists for exactly this "server ingests bytes" shape (built for the MCP mint path). Its header demands callers bound abuse — "**Pass gate + upload-bytes quota**, exactly like app/api/upload" — so the PUT route carries both (§5). |
| Redis is the only datastore (~336 KB total, `REDIS_IMPLEMENTATION_REVIEW.md:35,577`), with a **$20 budget cap that hard-stops the whole database** when hit (`:580-582`), and SCALING §B3 directs unbounded list-shaped data toward Postgres eventually | `REDIS_IMPLEMENTATION_REVIEW.md`, `SCALING.md:377-386` | Redis holds pointers, version history, and small indexes — never bytes. The new per-artwork sets this design adds (§4) are the same shape as the existing follower/raffle/collected sets: consistent with current practice, and listed with them as B3 migration candidates. The hard-stop also budgets the notification fanout (§6.2). |
| Post-mint metadata updates are shipped and artist-authorized on-chain | `app/api/moment/update-uri/route.ts:24 canUpdateUri()` — ADMIN(2)\|METADATA(16) via `lib/permissions.ts:24-34` | We reuse the same permission predicate for "who may attach/replace the file". Note `readPermissions` retries 4× then **throws** (`lib/permissions.ts:91-124`) — the route must map that to 503, not 403. |
| **But** a tokenURI update makes inprocess rewrite `created_at`, which re-ranked edited moments as fake new mints (production incident 2026-07-20) | `lib/notifications.ts:158-165` (the `MomentMeta.createdAt` pin exists because of it) | File updates must NOT ride tokenURI updates. Redis-side state sidesteps this entirely — and matches "not on-chain, upgradable". |
| Server-side ownership truth is a live `balanceOf`; the Redis collected ZSET is event-sourced (written only by collect/airdrop/pass-webhook — `lib/collected.ts:3-5`), so it misses secondary buyers, and nothing ever removes a seller | `lib/raffle.ts:151 holdsEdition()` (fails closed) | The download gate must be `holdsEdition`, not `isCollected` — otherwise every Seaport buyer is denied and every seller keeps access. |
| A Mini App signer can differ from the identity wallet; the Patron gate shipped that bug and fixed it with a read-time address union | `PATRON_GATE_MINIAPP_RCA.md` §3/§9; `lib/addressUnion.ts:33 expandToFidSiblings` (uncapped — the ≤10 cap lives in `lib/passUnion.ts:21 planUnionCheck`) | The gate must check the verified-wallet union, **bounded through `planUnionCheck`**, and still needs a wallet-proof fallback for holders outside the union (§5.1) — the union only covers FC-verified wallets. |
| Auth is already unified: SIWE cookie + Farcaster Quick-Auth JWT resolve through one call; a sign-in affordance exists | `lib/session.ts:72 getSessionAddress(req)`; `hooks/useSignIn.ts` | Mini App users are always authenticated; web users need one SIWE sign-in *or* one signed message (§5.1) — one wallet interaction either way. |
| There is no per-artwork collector index; the raffle keeps a per-artwork entrant set and notifies it (unchunked, unfiltered — a deliberate small-N choice), and follower fanout chunks at 50 with a warn at 1000 | `app/api/raffle/manage/route.ts:160-181`, `lib/notifications.ts:296-330` | Update notifications need a new reverse index (§6.1) and a fanout that **composes** those two precedents with a real cost model (§6.2) — neither precedent alone survives a 10k-collector edition. |
| One notification pipeline feeds both the bell and Farcaster push — but the push dispatch inside it is **fire-and-forget** (`void import(…)`, not awaited) | `lib/notifications.ts:199,275-280` → `lib/farcasterNotifications.ts:626`; caps `TITLE_MAX 32`/`BODY_MAX 128` (`:312-313`), 100 tokens/request (`:86`) | One new type serves both channels, but a large fanout must pace itself — the unawaited push chains are the same unbounded-fanout shape as the 2 GB OOM incident (`OPS_RUNBOOK.md:27-46`). §6.2 bounds it. |
| No email channel exists at all | repo-wide grep | "Notify collectors" = bell + FC push + on-page badge. The badge is the floor: push tokens exist only for Mini App users who opted in. |
| Memory-heavy bounded routes are an accepted pattern — with the check-then-increment discipline and the knowledge that route `maxDuration` is a **no-op** on self-hosted `node server.js` | `/api/transcode-gif` 300 MB at `MAX_CONCURRENT=1` (`app/api/transcode-gif/route.ts:30,37`); `/api/img` `MAX_CONCURRENT_RESIZES=4` (`:67-68`); `OPS_RUNBOOK.md:56` | Buffering zips for encrypt/decrypt is inside established practice **if** each route carries its own cap and its own timeouts (§5) — the budget is the **6 GB container limit**, not the 4 GB V8 heap (Buffers are off-heap; the runbook's exit-134 vs exit-137 split at `OPS_RUNBOOK.md:128-129` makes the distinction load-bearing). |
| No iframe/interactive/zip media kind exists; Kismet renders zero iframes today (it *runs inside* one); CSP is Report-Only and already allows `frame-src 'self' https:`, `script-src … 'unsafe-eval' blob:`, `worker-src 'self' blob:` — but **no COOP/COEP anywhere**, deliberately (the ffmpeg wasm is the single-threaded core) | `lib/media/resolveMomentMedia.ts:3`, `next.config.mjs:23,29,30,34-39`, `lib/media/transcodeGif.ts:9` | The zip is an **attachment**, not the display media. The emulator ships as a **full-page route, not an iframe** (§7) — cross-origin isolation for SharedArrayBuffer is unobtainable here without breaking Arweave media, WalletConnect, and the Mini App embed, so the emulator build must need neither threads nor SAB. |

---

## 2. Design in one picture

```
ARTIST (creator or on-chain METADATA admin)
  │  PUT /api/collector-file  (zip ≤16 MiB + optional release note)
  ▼
[server] session → canEditMomentMetadata (RPC throw ⇒ 503) → pass gate
  → platform pause → blacklist → per-identity quota → FAIL-CLOSED platform day-ceiling
  → acquire SET NX lock (before any spend; concurrent PUT ⇒ 409)
  → bounded body read (16 MiB actual bytes) → zip sanity + filename normalize → sha256
  → AES-256-GCM encrypt  (key = HKDF(master, keyId); AAD = coll:id:keyId; tag 16B)
  → uploadBytesToArweave(ciphertext) with AbortSignal timeout   ← platform pays
  → poll gateway until readable (else activate-later) → Redis: v+1, append history
  → optional notify: SET NX 24h cooldown-lock → paced fanout (§6.2)

COLLECTOR
  │  GET /api/collector-file/download?collection=&tokenId=
  ▼
[server] path 1: session → planUnionCheck(expandToFidSiblings) ≤10 wallets → holdsAny
         path 2 (fallback): raffle-style signed message (ERC-1271) → holdsEdition(signer)
         plus: 15-min grace marker minted by /api/collect's receipt-verified path
  → kill-switch check → fetch ciphertext (budgeted, size-capped, failure-memoized)
  → decrypt (verify tag) → send with Content-Length
    Content-Disposition: attachment; filename="<normalized>.zip"
    Cache-Control: private, no-store; X-Content-Type-Options: nosniff
  → record wallet's downloaded version (powers "update available" badge)

EVERYONE (artwork page)
  "⬇ Includes a collector download · Sylvester.zip · 357 KB · v2 · updated Aug 25"
   └─ not holder → "Collect to download"   └─ holder → Download (+Update badge)
   └─ creator  → Manage panel: replace / history / notify / unique-downloader count

PLAY (order per §12):  [▶ Play] → /artwork/…/play  (full page, no iframe)
   → binjgb (single-threaded wasm, no SharedArrayBuffer)
   → public mode: plaintext ROM, CDN-cacheable path — a storage decision at attach
   → collectors mode: gated decrypt route, private/no-store
```

**What this is NOT:** DRM. A collector can share the zip after downloading —
exactly as with Bandcamp downloads. The gate is an ownership perk and an
anti-scraping measure, not copy protection. **What it IS, and the doc must say
so:** Kismet becomes a file host serving artist-authored bytes to third
parties under its own domain — which brings file-host obligations (filename
hygiene, a download kill-switch, a takedown path, and a sunset promise scoped
to non-moderated content; §10.2).

---

## 3. Storage: encrypted at rest on Arweave, pointer in Redis _(HISTORICAL — superseded by the Storage pivot; bytes now live chunked in Redis with no encryption layer, see the pivot note and §4)_

**Decision: ciphertext on Arweave via the existing server Turbo path; AES-256-GCM;
per-ciphertext keys derived from one env master key; version history in one
Redis key per artwork. Cap 16 MiB/version. Re-vote against Cloudflare R2 at the
CDN cutover (§9).**

### 3.1 Why encryption — the honest rationale

Validation dismantled the first draft's stated reason ("txids are enumerable
via Arweave GraphQL by the single platform owner wallet"). That is true today
(`lib/arweave/client.ts:10` publishes the modulus; every server path signs
with `ARWEAVE_JWK`) — but it is a **one-line fix**, not an architectural fact:
a dedicated `BUNDLE_ARWEAVE_JWK` upload wallet would remove the enumeration
handle, and the server upload path already omits the `File-Name` tag
(`uploadServer.ts:37`), leaving a 256-bit txid that is functionally a
capability URL.

The real reason to encrypt is **leak-class conversion**. The pointer and the
public descriptor live in the same JSON blob (§4); the descriptor is
serialized into a public page payload on every artwork view; and this repo has
twice shipped subtle serialization/identity leaks (`VIDEO_PLAYBACK_RCA.md`,
`PATRON_GATE_MINIAPP_RCA.md`). With plaintext storage, one careless spread of
the bundle record into page props publishes a **permanent, unrevocable public
URL** to the paid content. With encryption, that same bug leaks a useless
ciphertext address. We accept a worse *worst case* (master-key compromise
exposes every version ever, forever — same operational class as `ARWEAVE_JWK`,
and it protects a perk, not funds) for a much better *common case* (a
serialization bug costs nothing). Encryption also lets public-play mode be a
deliberate, separate plaintext upload (§7) rather than a header decision that
can be cached wrongly.

### 3.2 Mechanics — with the three validation-mandated fixes

- **Key derivation** — one new secret, `COLLECTOR_FILE_MASTER_KEY` (32 random
  bytes, base64). Per-ciphertext key =
  `HKDF-SHA256(master, salt="kismet-cfile-v1", info=keyId)` where **`keyId` is
  its own immutable field** (`<collection>:<tokenId>:<n>` with `n` assigned
  once at ciphertext creation and never reused), **decoupled from the display
  version `v`**. The first draft derived from `v` — which made §4.2's rollback
  (re-activating an old ciphertext as `v+1`) *undecryptable*: the pointer
  would say v4 while the bytes were sealed under v2's key. `keyId` travels
  with the ciphertext record through rollbacks and history, so any record is
  always decryptable. Node built-ins only (`crypto.hkdfSync`,
  `createCipheriv`; Node 22.22 per the Dockerfile) — no new dependency.
- **AEAD discipline** — random 12-byte IV per ciphertext, stored in the
  record; **AAD = `collection:tokenId:keyId`** so a Redis-level pointer swap
  between artworks cannot decrypt; **`authTagLength: 16` pinned on both cipher
  and decipher** (Node accepts short GCM tags by default, which would turn a
  forged tag into a 2³² problem). The HKDF info format and AAD format are
  frozen in one exported constant, and `scripts/verify-collector-file.ts`'s
  **first assertion is a known-answer test** over them — key-derivation drift
  is the one mistake in this design that can never be repaired after the
  fact, because the ciphertexts are permanent.
- **Upload** — `uploadBytesToArweave(ciphertext, 'application/octet-stream')`,
  **with an `AbortSignal` timeout threaded in as a new parameter** (today the
  helper retries 3× with no wall-clock bound — a stalled Turbo would pin
  ~64 MB and a handler forever; `maxDuration` won't save it, it's a no-op
  self-hosted per `OPS_RUNBOOK.md:56`). Then poll the gateway until the txid
  is readable before activating the version — note this is a **stricter
  contract than `verifyArweaveAvailable`'s existing best-effort use**
  (`lib/arweave/verifyAvailable.ts:22-26` explicitly no longer hard-blocks);
  here, activation genuinely waits, and on budget exhaustion the version is
  stored as `pending` and activated by a later re-check rather than served
  into 404s.
- **Costs, corrected** (validation re-derived these; the first draft was
  4–5× low): at Turbo's retail ~$32.56/GiB — Sylvester's 357 KB ≈ **$0.011**
  per version; a 16 MiB worst case ≈ **$0.51**, permanent and non-refundable.
  The per-identity quota (§5) at 15 versions/day therefore bounds one
  identity's abuse at ≈ **$7.6/day of permanent spend, Sybil-multiplied** —
  which is why the fail-closed platform ceiling in §5 exists (the
  `PLATFORM_SIGN_DAILY_CAP` backstop does **not** cover the server-JWK path,
  and `consumeUserQuota` fails open on Redis error, `lib/userQuota.ts:144-146`).
  Sub-100 KiB uploads are free on Turbo (why metadata JSON costs nothing
  today); every real bundle is over that line.
- **Who pays:** the platform, as with all media (`lib/arweave/paidBy.ts`).

**Why 16 MiB (down from the draft's 32):** the MBC5 format ceiling is an
8 MiB ROM; the whole Sylvester bundle is 0.36 MiB. 16 MiB is 2× the largest
possible GB ROM plus assets, 45× today's file — and halves both the permanent
worst-case spend and the per-request memory. The cap is a dial; cost scales
linearly with it. **The revisit trigger for this whole storage decision is
version churn, not file size** (§9): every superseded version is paid-for-
forever, so a culture of frequent large updates is what would flip the answer
to R2.

---

## 4. Data model (Redis)

All keys follow the existing `kismetart:` prefix and the canonical per-artwork
identity — lowercased collection + `BigInt(tokenId).toString()` — **applied on
every route** (`app/api/collect/route.ts:200-202` is the precedent, and the
reason: un-canonicalized `"01"` would fork a second bundle and bypass locks).

Code/route naming is `collector-file` / `collectorFile`, not "bundle" —
"bundle" is already load-bearing for the JS-size gate (`check:bundle`,
`bundle-baseline.json`, `scripts/check-bundle-size.mjs`) and EIP-5792 collect
bundles, and `scripts/verify-bundle.ts` would read as a size check.

```
kismetart:cfile:<collection>:<tokenId>             STRING (JSON), no TTL
  {
    current: {                         // null when detached
      v: 3,                            // display version, monotonically increasing
      blobSeq: <n>,                    // immutable storage id → chunk keys (pivot)
      chunks: <count>,                 // chunk-key count for blobSeq
      name: "Pixel Art Gallery - Sylvester.zip",   // normalized (§10.2)
      size: 365396,                    // plaintext bytes
      sha256: "79919fea…",             // plaintext hash — shown to collectors
      kind: "zip",                     // magic-detected format (zip|pdf|glb);
                                       // absent = pre-extension record = zip
      note: "added music!",            // optional artist release note, ≤140 chars
      updatedAt, updatedBy,
      stored: true                     // bytes exist (retention window)
    },
    history: [ {v, blobSeq, chunks, size, sha256, name, note?, updatedAt,
                updatedBy, stored?}, … ],           // ≤20 metadata rows
    nextBlobSeq, createdAt
  }

kismetart:cfile-blob:<collection>:<tokenId>:<seq>:<i>  STR 'b'+base64 chunk (4 MiB
                                                   // plaintext each). Written EX 3600,
                                                   // PERSISTed by the commit MULTI —
                                                   // a crashed PUT leaves only
                                                   // self-expiring orphans.

kismetart:cfile-bytes                              HASH ref → resident stored bytes
                                                   // the storage-ceiling ledger,
                                                   // rewritten absolutely per mutation

kismetart:cfile-dl:<collection>:<tokenId>          HASH  addr → version last downloaded
                                                   // "update available" badge; HLEN =
                                                   // UNIQUE DOWNLOADERS (not downloads)

kismetart:collectors:<collection>:<tokenId>        ZSET  member=addr, score=first-collect ms
                                                   // the new reverse index, §6.1

kismetart:cfile-refs:<addr>                        SET   "<collection>:<tokenId>" refs
                                                   // erasure reverse index, §4.3

kismetart:cfile-lock:<collection>:<tokenId>        SET NX EX ~180 — PUT mutual exclusion
kismetart:cfile-notify-lock:<collection>:<tokenId> SET NX EX 86400 — the 24h cooldown IS this lock
kismetart:cfile-blocked                            SET — admin kill-switch, checked on DOWNLOAD
```

History bounds: metadata rows are ~250 bytes; keep the last 20 (~5 KB JSON
worst case). BYTES are kept only for the last **3 distinct versions**
(`CFILE_BYTES_RETENTION` — current + 2 rollbackable): resident Redis storage
is a recurring cost, so older rows stay as record while their chunk keys are
deleted in the same commit that supersedes them. Chunk I/O runs on a
DEDICATED non-auto-pipelining client (`lib/collectorFile.ts`) — the shared
client's auto-pipeline is client-global with a microtask flush window, so
two CONCURRENT requests' chunk commands landing in the same tick would be
batched into one REST call, and two ~5.4 MB chunks in one request/reply
breach Upstash's 10 MB cap. On the dedicated client every chunk travels as
its own bounded HTTP request, which also makes parallel chunk I/O safe; the
`'b'` prefix keeps a chunk from ever being JSON-parseable by the shared
SDK's auto-deserialization.

Reads of `kismetart:cfile:*` on the gated path go through `strictRead`
(`lib/redisRead.ts:42-66`) — the fail-closed posture `hiddenMoments` uses
(`lib/hiddenMoments.ts:55`), so a Redis outage can't leak or corrupt gated
state. The public descriptor (existence, name, size, version, updatedAt —
never storage internals) is assembled into the artwork page payload next to
the other Kismet augmentations in
`app/artwork/[address]/[tokenId]/page.tsx`'s `Promise.all`.

### 4.1 Why not in the token metadata JSON?

`kismet_thumbhash` proves a custom `kismet_*` key round-trips through
inprocess — **for a flat string** (`lib/inprocess.ts:115-129`; written
`MintForm.tsx:809`, read back on every surface). Rejected for the file itself
because every replacement would then be a tokenURI update, which (a) requires
the artist's wallet signature + the inprocess PATCH each time
(`app/api/moment/update-uri/route.ts:98,154`), (b) trips the `created_at`
re-rank bug the codebase carries a scar from (`lib/notifications.ts:158-165`),
(c) publishes the ciphertext txid in public metadata for no benefit, and
(d) contradicts the artist's own "not on-chain, upgradable" framing.

Validation also **killed the first draft's Phase-3 "mirror a descriptor into
metadata later" idea**: a nested `kismet_bundle: {…}` object has *zero*
in-repo passthrough precedent (every shipped custom key is a flat scalar), and
freezing `{version, sha256}` into permanent metadata while Redis stays the
authority guarantees the mirror is **permanently wrong within days** — stale
provenance is worse than none. The platform's established way to surface a
Kismet-side fact is response-stitching (`kismet_duration_sec`,
`kismetCollection` — `lib/inprocess.ts:144-192`), which is exactly what the
descriptor-in-page-payload above already does. Dropped entirely.

### 4.2 Version semantics

- Replace = new record, `v+1`, fresh `blobSeq`. Same-bytes replace
  (identical sha256) is a no-op with a toast.
- Rollback = re-activate an old history record as `v+1` **carrying its
  original `blobSeq` verbatim** — the bytes already exist, no re-upload.
  Only versions inside the 3-version bytes-retention window are rollback
  targets (`restorable` in the manage view); older rows keep their metadata
  but restoring one means re-uploading it. Rollback provably never prunes.
- The manage panel lists old versions (name, size, date) with one-click
  rollback where restorable; the only *download* anyone gets — artist
  included — is the current version. Collectors only ever see current.
- Detach (DELETE) **frees the stored bytes in the same commit** — real
  deletion is a deliberate property of the Redis pivot; history rows remain
  as the artist's record, all non-restorable.

### 4.3 Erasure (validation finding — the draft missed this entirely)

`app/api/admin/erase-profile/route.ts` documents itself as a hard,
irreversible erase, and today runs address-keyed whole-key deletes in one
`Promise.all` (`:145-159`) — it can never find address-*valued* members inside
per-artwork keys. Two additions are therefore **part of this feature, not a
follow-up**:

1. Every collectors-index mirror write (§6.1) — including the listings-fill
   site, whose buyers appear in **no** forward index today — also writes
   `SADD kismetart:cfile-refs:<addr>`.
2. Erase reads `cfile-refs` (and the collected ZSET, **before** deleting it —
   the current all-parallel structure gives no such ordering) and issues the
   per-artwork `ZREM collectors` / `HDEL cfile-dl` / `SREM` cleanups.

Without this, a hard-erased user's wallet address is retained in per-artwork
structures indefinitely — for secondary buyers, unreachably.

---

## 5. API surface

New route family `app/api/collector-file/` (no existing route can be reused:
`/api/img` is deliberately unauthenticated + CDN-cacheable,
`app/api/img/route.ts:386-395,518-520`, and must stay that way).

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/collector-file?collection=&tokenId=` | PUT | session + `canEditMomentMetadata` | Attach or replace. Raw zip body, `x-file-name` header (normalized, §10.2), optional `?note=`. Full guard ladder below. Returns the new public descriptor. |
| same | GET | session + creator/admin | Manage view: descriptor + history + unique-downloader count. |
| same | DELETE | session + `canEditMomentMetadata` | Detach: clears the pointer AND tombstones serving (kept history stays artist-visible only). |
| `/api/collector-file/download?collection=&tokenId=` | GET | two-path gate (§5.1) | Decrypt-and-send (buffer, then respond with `Content-Length` — GCM cannot stream-verify). `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. Writes `cfile-dl`. 401 / 403 not-holder / 404 none / 423 blocked / 503 verify-unavailable. |
| `/api/collector-file/notify` | POST | session + `canEditMomentMetadata` | Explicit "tell collectors" (also a checkbox on PUT). The 24 h cooldown **is** a `SET NX EX 86400` lock — no read-then-write race; returns reach estimate. |
| `/api/collector-file/rom?collection=&tokenId=` | GET | per `playable.access` | Collectors-mode ROM for the web player (§7). Public mode never touches this route. |

**The PUT guard ladder, in order** (each item exists today except the last):
`checkRateLimit('cfile-put:<ip>', 5, 60)` → session → `canEditMomentMetadata`
(RPC throw ⇒ 503; permission false ⇒ 403) → `isPlatformPausedFor` (per
`update-uri:116` — note update-uri has *only* the pause check; the blacklist
check is borrowed from the collect route's pattern,
`app/api/collect/route.ts:284-285`, accepting its documented 15-min memo
staleness and fail-open) — **no pass gate**, an implementation-time
correction: the actual precedents for spending Turbo credit (`/api/upload`)
and for artist edits (`update-uri`) both run without one, and the on-chain
ADMIN|METADATA requirement is already a stronger artist-authorization than
pass validity (`uploadServer`'s header parenthetical describes its MCP
caller's gating, not a universal contract) → bounded body read + zip magic →
`acquireLock('cfile-lock:…')` and a **strict** record read + identical-bytes
dedup — the lock and dedup come BEFORE the meters, so a racing co-admin's 409
and a nervous double-upload burn nothing, and a degraded record read can never
be written back over (both review findings) → `consumeUserQuota('cfile-upload')`
+ `consumeUserQuota('cfile-bytes')` (**own kinds** — the draft's plan to debit
`upload-bytes` would let 15 zip iterations lock an artist out of minting
metadata for the day) → **a fail-closed platform day-ceiling**: a plain
`INCRBY`-and-compare day key whose Redis *failure denies* — deliberately
inverted from `consumeUserQuota`'s fail-open, because this is the only
backstop on permanent Arweave spend (`PLATFORM_SIGN_DAILY_CAP` covers only
`/api/sign`; precedent for a platform-wide cap on this helper's caller:
`PLATFORM_MINT_DAILY_CAP` in `app/api/agent/prepare-mint/route.ts:65,224`) →
`acquireLock('cfile-lock:…')` **before any spend** (second PUT ⇒ 409; the
draft's post-upload commit meant a double-click paid for an orphaned permanent
ciphertext) → bounded body read via the `lib/boundedBody.ts` doctrine
(Content-Length pre-check, then actual-bytes enforcement) → zip sanity (§10.2)
→ encrypt → upload (timeout) → verify → commit → release lock.

**Session-only on PUT (no signed message) is a deliberate asymmetry** from
`update-uri`'s signature+nonce, and it matches the closer precedent: spending
platform Turbo credit is already session-only on `/api/upload` (50 MB JSON)
and `/api/sign`. update-uri's signature exists because it mutates
inprocess-side token state through the platform key; this route mutates only
Kismet-side state.

**Concurrency and memory (corrected by validation):** PUT holds ~64 MB peak
(body + cipher output + Turbo's signed data item) ⇒ **`MAX_CONCURRENT = 1`**
(the transcode-gif precedent, `app/api/transcode-gif/route.ts:37`), increment
before the first await (`app/api/img/route.ts:278-288` discipline). Download
holds ciphertext + plaintext simultaneously (~32 MB) ⇒ **`MAX_CONCURRENT = 2`**
(~64 MB worst case). Both budgets live against the **6 GB container limit**
alongside `/api/img`'s and transcode-gif's existing appetites — not against
the 4 GB V8 heap (Buffers are off-heap).

**The download's upstream fetch copies `/api/img`'s hardening wholesale** —
race-to-headers and total budgets (`app/api/img/route.ts:34,52`),
gateway-pinned redirect resolution (`lib/media/gatewayFetch.ts:44-80`),
actual-bytes cap, and a failed-read memo keyed by txid (`:127-128,427-433`) so
an arweave.net edge dying at 25 MB costs one probe per minute, not one 25 MB
re-read per collector click.

### 5.1 The ownership gate — two paths, precisely

**Path 1 (zero-ceremony, covers Mini App + signed-in web):**

```ts
const address = await getSessionAddress(req)                  // lib/session.ts:72
if (!address) → offer path 2
const wallets = await expandToGateWallets(address)            // BOUNDED union (addressUnion.ts)
const holds = await holdsAny(collection, tokenId, wallets)    // balanceOfBatch, fails closed
```

- `expandToFidSiblings` alone is **uncapped** (validation caught the draft
  claiming otherwise) — the bound comes from the union helper's own
  `MAX_UNION_WALLETS` cap. The shipped gate (`lib/collectorFileGate.ts`)
  uses `expandToGateWallets` directly: despite the pass-flavored name it is
  exactly the bounded caller-first FC-sibling union, deduped/lowercased and
  failing degraded to `[caller]` — the pass-specific blacklist logic lives
  in `hasGateAccess`, not in the union helper, so nothing pass-shaped leaks
  into "who holds this token".
- Cache the **expanded union** per address (~5 min), not just the verdict —
  the sibling expansion is the 4–6 sequential dependent reads
  `REDIS_IMPLEMENTATION_REVIEW.md:227-232` calls the latency floor.
- `holdsEditionBatch` is module-private today (`lib/raffle.ts:181`) — lift it
  and `holdsEdition` into `lib/ownership.ts` rather than re-implementing.

**Path 2 (wallet proof — the fallback the first draft lacked):** the raffle's
shipped pattern verbatim (`app/api/raffle/enter/route.ts:64-84` +
`lib/raffleMessage.ts`): a freshness-bounded message binding
`(collection, tokenId, address, issuedAt)`, verified with
`serverBaseClient().verifyMessage` — **ERC-1271-aware, so smart-account
holders work** — then `holdsEdition(signer)`. This is what covers a holder
whose wallet is *not* in their FC verification set (the RCA-class residue the
union cannot reach: some Base-App smart accounts, wallets never verified) and
a web collector who never signs in. Client behavior: try path 1 silently; on
its 403, surface "Verify ownership with your wallet" (one signature).

**Path 3 (freshness grace):** `/api/collect` has *already receipt-verified*
`(account, collection, tokenId)` on-chain at the moment of collect
(`app/api/collect/route.ts:212`) — and its own client documents that the
server RPC lags the buyer's receipt by seconds
(`hooks/useDirectCollect.ts:329-331` retries for exactly this). So collect
(and the airdrop/listing-fill verified paths) mints
`SET kismetart:cfile-grace:<coll>:<id>:<addr> EX 900`, and the gate accepts
grace ∨ holdsEdition. Without this, the flagship "Your download is ready"
moment 403s its first click — validation rated that the worst bug in the
draft's UX.

Live-balance semantics stand: **secondary buyers gain access the moment the
Seaport fill lands; a seller who parts with their last edition loses it** —
the token is the license (one line of UI copy says so). Downloads do **not**
check the blacklist — moderation gates *artist* actions and, when needed, the
per-artwork kill-switch; a collector who paid keeps what they bought unless
the file itself is pulled.

**Path 4 (Mini App delivery ticket — added by the UX validation round):** the
gate above authenticates the *request*, but on the primary mobile surface it
cannot deliver the *file*: the Quick-Auth JWT is attached by a patched
`fetch` only (`providers/FarcasterProvider.tsx:64-109`), so an `<a href>`
navigation to the download URL inside the host webview carries **no
credentials at all** (the `__Host-` cookie exists only where the user SIWE'd);
a fetch-received blob has no reliable save path out of an RN WebView
(`lib/miniAppEnv.ts:33` — the mobile host is React Native, not a browser tab);
and the repo contains **zero** file-save precedent and **zero**
`sdk.actions.openUrl` calls today (verified: the only `sdk.actions.*` uses are
`addMiniApp`, `ready`, `composeCast`). Therefore, in Mini App context the
Download button does: authenticated `fetch` →
`POST /api/collector-file/ticket` (runs the same gate, returns a **single-use,
~5-minute, artwork+address-bound opaque ticket URL**) →
`sdk.actions.openUrl(ticketUrl)` → the device's real browser downloads it, the
ticket being the entire auth. Tickets are `SET NX EX 300` keys consumed on
first use; the same endpoint powers an optional "get this on my desktop"
copy-link with a slightly longer TTL. On web, the plain cookie-carrying
navigation remains the path and no ticket is minted.

Guardrails: `checkRateLimit('cfile-dl:<ip>', 20, 60)` +
`consumeUserQuota('cfile-download', identity)` (both fail open by platform
convention — acceptable here because they guard cost, not authorization; the
authorization path is fail-closed end to end: `strictRead`, `holdsEdition`,
kill-switch, single-use tickets).

---

## 6. Versioning notifications ("people can download again the new file")

### 6.1 The audience index (new, required)

Nothing today can enumerate collectors of one artwork — `lib/collected.ts` is
forward-only, inprocess has no owners endpoint, ERC-1155 has no enumeration.
The raffle solved the same problem with a per-artwork entrant set; we add the
collector version: `kismetart:collectors:<collection>:<tokenId>` (§4),
mirror-written where a collector becomes known:

1. `app/api/collect/route.ts:418` — beside `recordCollected` (primary mints +
   gifts; `account` is the receipt-verified recipient). Agent/scout collects
   route through this same endpoint, so they're covered transitively.
2. `app/api/airdrop/notify/route.ts:414` — each on-chain-verified recipient.
3. `app/api/listings/[id]/route.ts:171` — the Seaport fill's receipt-verified
   `buyer` (today this site writes **no** forward index at all — secondary
   buyers were invisible; this is what makes their update notifications work).
4. `app/api/webhooks/pass-transfer/route.ts:167-168` — honest scope note the
   draft lacked: this webhook is **hardcoded to the Pass collection**, so it
   only ever covers Pass artworks. For ordinary artworks (Sylvester's),
   off-platform wallet-to-wallet transfers stay invisible to the index — those
   holders still pass the download gate (live balance) and get the on-page
   badge; they just miss push/bell until they interact once.

Every one of these writes also feeds `cfile-refs` (§4.3). At fanout time,
additionally union in `HKEYS cfile-dl` — anyone who ever downloaded is an
interested party even if the index missed their acquisition.

Event-sourced from ship date, like the forward index. Backfill for
already-minted artworks (Sylvester will predate the feature): a one-shot walk
of `alchemy_getAssetTransfers` cloned from
`scripts/reconcile-pass-validity.mjs:142` — run on demand for artworks that
attach a file, **requires an Alchemy `BASE_RPC_URL`, and must handle
`TransferBatch` as well as `TransferSingle`, in both directions**, or the
reconstructed set is wrong.

### 6.2 The fanout — with a cost model (validation found the draft's version could take the site down)

Three platform facts bound this design: each `writeNotification` +
`dispatchFarcasterPush` costs **~10–12 Redis commands**; the platform's whole
current volume is ~579 K commands/month against a **$20 Upstash budget cap
that hard-stops the only database** (`REDIS_IMPLEMENTATION_REVIEW.md:36-38,
580-582`); and the push half of the pipeline is **fire-and-forget**
(`lib/notifications.ts:275-280`) — so a naive 10 k-recipient loop is ~20% of a
month's commands in one `after()` plus thousands of detached in-flight HTTPS
chains: the OOM-incident shape (`OPS_RUNBOOK.md:27-46`).

Therefore:

- **Audience ceiling 2,000, enforced by refusal, not truncation.** Above it,
  the notify call returns the count and does nothing; the artist sees "this
  edition is too large for direct notification — collectors will see the
  update badge" (the passive path is the floor anyway). Raising the ceiling is
  an ops decision that arrives together with a raised Upstash cap — the
  projected per-fanout command delta gets a row in
  `REDIS_IMPLEMENTATION_REVIEW.md`'s budget table **before** ship.
- **Holder filter with sane failure semantics.** Filter the audience through
  the exported `holdsEditionBatch`, applied per delivery batch of 50 so a
  filter failure stops delivery exactly where it stands, and ex-holders
  aren't pinged about a file they can no longer download. Its raffle
  contract is all-or-nothing-false on any chunk failure
  (`lib/raffle.ts:208-212`) — fine for a draw, catastrophic here (one flaky
  chunk ⇒ zero notified ⇒ cooldown burned). The lifted variant returns
  `null` on failure, and the fanout **stops at the persisted cursor**; the
  cooldown is released (DEL) only when a fresh run delivered nothing.
- **Paced delivery, push awaited.** Batches of 50 (`FANOUT_BATCH`),
  `_forcePriority` to skip the 2-reads-per-recipient priority probe, and
  the push dispatch **awaited per recipient** (`_awaitPush`) — each awaited
  send holds ≤10 s (`SEND_TIMEOUT_MS`) and at most one batch is in flight,
  so in-flight push HTTP is bounded to 50 (the detached fire-and-forget
  shape is the OOM-incident shape). Scheduled via `after()`. **The
  notify-lock's VALUE is the run's progress cursor** — a
  `{cursor,total,done,startedAt}` record advanced after every delivered
  batch with `SET … keepTtl` (the 24 h window never extends). A process
  death mid-fanout leaves `done:false`; the notify route reads that and
  queues a **resume from the cursor** over the same deterministically
  sorted audience instead of answering 409.
- **The 24 h per-artwork cooldown IS the dedup.** `file_update` deliberately
  stays **out of `BURST_DEDUP_TYPES`** — validation caught that its lock key
  is `(type, recipient, actor, tokenAddress)` with **no tokenId**
  (`lib/notifications.ts:230`), so membership would silently suppress an
  artist updating two artworks in the same collection within 60 s. The
  `SET NX EX 86400` notify-lock (§4) is per-artwork and race-free, which is
  everything the burst dedup would have half-provided.

### 6.3 The notification type

New type `file_update` in `ALL_NOTIFICATION_TYPES` (`lib/notifications.ts:6`).
Touch points, with the honesty pass applied: **four are compiler-enforced**
(`compose()`'s `never` default, `NotificationContent`'s, `notificationHref`'s
return type, `PUSH_TYPE_LABELS`'s `Record<NotificationType,…>`) and **three
compile silently if forgotten** and must be on the checklist: `TYPE_LABELS`
(`Record<string,…>`, `NotificationModal.tsx:18`), `DRAGGABLE_FILTERS`
(`NotificationFeed.tsx:20`), and the `isPriority` if-chain
(`lib/notifications.ts:168-197` — add an explicit branch: priority, the
recipient paid for this).

Copy (within `TITLE_MAX 32` / `BODY_MAX 128`,
`lib/farcasterNotifications.ts:312-313`):

> **Download updated** · "Pixel Art Gallery – Sylvester" has a new file from
> @andreaboi — tap to get v2. _(+ artist note when present)_

`compose()` builds SITE_URL-target URLs like every other type; the "targetUrl
host must equal SITE_URL" rule is a Farcaster-host contract (violations
invalidate every token in the request) that the send path satisfies by
construction — the explicit validator exists only on the broadcast path.

**Push opt-in:** today only `collect` is seeded on
(`DEFAULT_ENABLED_PUSH_TYPES`, `lib/farcasterNotifications.ts:106`).
Recommendation stands: seed `file_update` on for new registrations — it is the
platform's closest thing to "a thing you own changed". Existing users get the
bell regardless (product sign-off, §11 Q2).

### 6.4 The passive path (reaches everyone)

Push reaches Mini App opt-ins; the bell reaches signed-in users; the floor is
the page: the collector card shows **"Update available — v3"** whenever
`cfile.v > HGET cfile-dl <addr>`, on the artwork page and the collected tab.
One HGET alongside reads the page already does — and it is the mechanism that
actually guarantees "people can download again the new file" for every
collector eventually, including everyone the index or the ceiling missed.

---

## 7. "Playing live with online emu"

The artwork stays a normal Kismet moment (cover PNG as `image` — the framed
cat). Play is a page affordance, not a new media kind; nothing in
`resolveMomentMedia` changes.

- **Emulator: binjgb** — MIT, C-compiled-to-wasm, cycle-accurate DMG (+
  passable CGB), battery saves + save states + rewind, five-file embed, 605★
  hobby project whose target hardware froze in 1989 (low bus factor is
  acceptable for a frozen target; we vendor a pinned build). **Committed
  constraint from validation: the build must need neither threads nor
  SharedArrayBuffer** (single-threaded emscripten; AudioWorklet without SAB
  ring buffers) — this repo sets no COOP/COEP anywhere, *cannot* adopt
  `require-corp` without breaking Arweave media, WalletConnect, and the Mini
  App embed, and its own ffmpeg precedent is deliberately the single-threaded
  core (`lib/media/transcodeGif.ts:9`). This also sharpens the EmulatorJS
  footnote: the RetroArch path typically *wants* threads, making it a far
  bigger change than "heavier" — not a drop-in later swap.
- **Surface: a full-page route** `/artwork/[address]/[tokenId]/play` — **not
  an iframe**. Kismet renders zero iframes today, is itself embedded in the
  Farcaster webview, and has an RCA'd pathology about nested-frame connection
  sharing (`components/MomentImage.tsx:94-102`); an iframe `sandbox` with
  `allow-same-origin allow-scripts` is also self-removable, i.e. theater.
  Canvas + touch D-pad/A/B (Mini App users are on phones), keyboard on
  desktop. Battery saves persist per artwork — **capped to the 2–3 most
  recent carts** (MBC5 battery RAM is up to 128 KB ≈ 170 KB base64; a handful
  of carts in `localStorage` starts crowding the ~5 MB origin quota that
  wagmi/RainbowKit state also lives in).
- **Vendoring:** `public/gb-player/` with the wasm committed and the upstream
  commit hash pinned in a README. Honest note (validation): `public/
  ffmpeg-core/` is *not* a vendored-binary precedent — it's gitignored and
  copied from an npm dep at postinstall (`scripts/copy-ffmpeg-core.mjs`).
  binjgb has no official npm package, so committing the built wasm is a new
  (small, defensible) precedent.
- **ROM extraction is Phase-2 server work with real caps** (validation): a
  zip parser is a **new server-side dependency** (fflate-class, or ~200 lines
  over `zlib.inflateRaw` — either way, say it; §3's "no new dependency" claim
  is Phase-1-only). Enforce on *actual inflated bytes* with mid-inflate abort
  (cap 16 MiB), cap entry count (~2,000) and central-directory size, reject
  non-normalizing entry names, store the chosen **entry index** (not a name a
  duplicate could shadow), and filter macOS junk by **prefix `__MACOSX/` and
  basename `._`** — the naive name filter fails on the actual test file,
  which contains `__MACOSX/…/._Pixel Art Gallery - Sylvester.gb`, an
  AppleDouble fork with a `.gb` extension that would be detected as a second
  ROM (or served as one, 4 KB of resource fork).
- **Access is the artist's dial, and it is a *storage* decision at attach
  time, not a header decision at read time** (validation): `'public'` mode
  uploads the extracted ROM as its **own plaintext Arweave object** and serves
  it through the existing CDN-ready public byte path (`/api/img?u=ar://…` —
  it already streams arbitrary `ar://` with content-type passthrough and
  `public, immutable` caching, `app/api/img/route.ts:399-401,518-520`);
  `'collectors'` mode serves through the gated decrypt route with
  `private, no-store`. The two must never share a cacheable route — a
  decrypted ROM cached public cannot be un-cached by flipping a flag. The
  manage panel says plainly: **public play is irreversible for that version**.
- **Later polish:** render the artist's own overlay art (the zip ships
  Kismet-branded bezels) as the player chrome.

---

## 8. The exact experience — validated surface by surface

A second validation round traced every moment of this experience against the
real render paths (`MomentDetailView`'s action column, the collect success
path, the notification surfaces, the collected tab, the Mini App affordances).
What follows is what the design as specified actually produces, with the
render evidence, followed by the honest ledger of what remains to be desired
(§8.2).

### 8.1 Step by step

**Non-holder on the artwork page (web or Mini App).** The page is unchanged
above the fold: cover art (the framed cat), title, creator, description, then
the action row `[price|supply] [collect] [gift]`
(`MomentDetailView.tsx:2124-2171`). The download card renders as a new
full-width row in the one clean seam the column has — between the gift form
(`:2181`) and the mobile sale-window line (`:2183`); validation ruled out
"under the collect box" (that space is occupied, and the desktop utility row
below it centers the sale date with an invisible width-strut copy of the
price box, `:2236-2239`, that a new column would break). Card copy:
`⬇ collector download · Sylvester.zip · 357 KB · v2 · updated aug 25` with
the state line `collect to download`. Advertising the perk to non-holders is
the point (Bandcamp's "includes high-quality download" line). On a sold-out
edition the card's state line becomes `available with the edition — see
market` when a live listing exists.

**The collect moment.** Today's entire success feedback is a bottom-center
toast (`Collected!`, plus a `Share it to /kismet?` action in the Mini App —
`hooks/useDirectCollect.ts:405-421`) and the collect button relabelling to
`collect+`; there is no success panel, no confetti anywhere in the repo, and
no haptic on collect (haptics fire for mint, follow, raffle entry and share —
not collect). So the design does not "add a row to the success state" (rev 1's
phrasing — there is no such state); instead **the download card itself is the
success moment**: it flips to `your download is ready ⬇` keyed on the
**optimistic `hasCollected` flag** (`:683`), NOT on `alreadyOwned` — the
owned-edition UI (`CollectedActions`, `×N own`, the comment box) waits for the
on-chain `balanceOf` refetch (`:267-275`), which is the client-side mirror of
the RPC lag the §5.1 grace marker absorbs server-side. Gift path: the gifter's
toast stays as-is; the recipient arrives later via their `gift` notification,
whose target is this artwork page — where the card already shows them the
download (they hold the token). Both notification copies gain one clause
naming the included file.

**Downloading — web, signed in:** one click. The `__Host-` session cookie
rides the same-site navigation; the server verifies, decrypts, sends;
Sylvester's 357 KB arrives sub-second (a 16 MiB worst case takes a few
seconds of gateway fetch + decrypt).

**Downloading — web, signed out:** exactly one wallet interaction, matching
the product's DNA: every transactional collector surface today avoids
sessions (raffle entry, follow, listing, buy, comments all use raw signatures
or receipts — validated), so the default is the §5.1 path-2 signed message
(`sign to verify ownership`, the raffle toast pattern,
`RaffleButton.tsx:110-123`); the `SignInPrompt` component (`sign in to
download`) is the alternative for users who'd rather establish the 7-day
session.

**Downloading — Mini App (the primary surface):** the button does
fetch-ticket → `sdk.actions.openUrl(ticketUrl)` → the device browser saves
the zip (§5.1 path 4). This is one tap plus a host-browser hop — the best
available on a surface where in-webview saving does not exist. The card's
subtext in-app says `opens in your browser`. This is the feature's weakest
moment and §8.2 owns it.

**The update moment.** The artist replaces the file with a note ("added
music!") and checks *notify collectors*. What each collector actually
receives, in reach order:
1. **The page badge (everyone, eventually):** `update available — v3` on the
   card whenever `cfile.v > HGET cfile-dl <addr>` — the guaranteed floor.
2. **The bell (signed-in visitors):** an unread row — accent left-border +
   dot, actor avatar, `@andreaboi updated the download for "Pixel Art Gallery
   – Sylvester"` (`NotificationRow` pattern, `:283-301`) — landing on the
   artwork page; the badge polls in within ≤120 s while the app is open
   (`NotificationBell.tsx:20,64-74`). Note the bell itself sign-in-gates its
   feed (`NotificationFeed.tsx:345-353`).
3. **Native push (opt-in Mini App users only):** `Download updated` →
   artwork page (the push vocabulary has no other destination for
   token-typed events, `farcasterNotifications.ts:361-362`). Reach is
   structurally a minority: the push **master toggle defaults off**
   (`NotificationModal.tsx:79`), per-type opt-in defaults off, and tokens
   exist only for users who added the Mini App — §8.2.
Re-download is the same one click; the badge clears when `cfile-dl` records
the new version.

**Finding it again later.** The only route to one's holdings today is
`/profile/<address>` → the Collected grid (`ProfileView.tsx:1070-1076`; the
nav has exactly three destinations plus the avatar, `Nav.tsx:29-31`). The
update pip on collected-tab cards rides the card *footer* row — validation
found all four image corners are already spoken for (admin star, hidden
badge, pass badge, pin — `MomentCard.tsx:586-616`).

**The artist, end to end.** Enter via the existing pencil-`edit` affordance
(`:1625-1634`, gated by `useMomentEditPermission`). The manage-download
section renders **adjacent to, not inside,** the metadata panel's save path —
the metadata save drags Arweave propagation waits, a second wallet signature,
and an on-chain write behind it (`:1207,:1245,:1248`); attaching a zip is
session-only and must not inherit that pipeline. Attach = drag-drop, `.zip`,
≤16 MiB, ~seconds for real files; a concurrent co-admin upload gets a clean
409 `someone else is updating this file`. Replace shows the version history
(with one-click rollback, §4.2), the release-note field, *notify collectors*
with a live reach estimate — or the over-ceiling message (`this edition is
too large for direct notification; collectors will see the update badge`) —
and the **unique-downloader count** (HLEN counts people, not downloads; the
label says so). Attach-at-mint stays out of v1: the tokenId doesn't exist
until after mint, and the artwork-page panel covers new and already-minted
work alike (including Sylvester's, if it predates the feature).

### 8.2 What remains to be desired — the validated ledger

Ordered by how much experience is lost, with the evidence for why each gap is
real and what would close it.

1. **The primary surface delivers the perk worst.** Kismet's distribution is
   the Farcaster/Base Mini App; the ticket flow (§5.1 path 4) makes downloads
   *possible* there, but the honest journey is tap → host browser → a zip in
   a phone's Files app — for an artifact whose real destinations are a
   desktop, a flashcart, an Anbernic handheld. There is no email channel to
   send it (validated: none exists), and no "send to my desktop" affordance
   beyond the ticket copy-link. *Closers:* the copy-link/QR ticket variant
   ships with v1; an email channel is a separate infra decision; and
   **in-browser play (Track A) is the one form of the work that is
   first-class on mobile** — the strongest argument that play matters
   specifically for the Mini App audience, independent of marketing.
2. **The perk is invisible where discovery happens.** Feed cards and cast
   embeds have no slot for it: `MomentCard`'s four image corners are taken,
   compact cards have no meta row, and a cast embed renders a fixed image.
   The Bandcamp-style advertisement exists only on the artwork page.
   *Closer:* a one-line `⬇ includes download` footer on non-compact cards is
   cheap; embeds are unfixable (host-rendered).
3. **"Notification when the file is updated" is delivered as *eventually*,
   not *immediately*, for most collectors.** Push reaches only Mini App users
   who added the app AND flipped the master toggle (default off) AND the
   type toggle; the bell reaches signed-in users who open the app; the badge
   reaches everyone but only on their next visit. The artist's mental model
   (Bandcamp emails everyone) is not what ships. *Closers:* seed the type on
   for new registrations (§11 Q2), a one-time prompt to enable push after a
   first download (the `maybePromptCollectNotifs` precedent exists on the
   mint path), and — the real answer at scale — an email channel, which is a
   platform decision bigger than this feature.
4. **No "my downloads" destination.** A collector with five downloads has no
   page listing them; they revisit artworks one by one (push and bell both
   land on artwork pages; profile → Collected is the only aggregate view).
   *Closer:* a `downloads` filter chip on the own-profile Collected section —
   small, additive, not in v1.
5. **The collect moment stays thin.** The card flip is real feedback, but the
   celebratory beat is still a 3-second toast; no haptic fires on collect
   (it fires for mint, follow, raffle, share — the gap predates this
   feature). *Closer:* one `hapticNotifySuccess()` call and a toast
   description naming the download; two lines, worth doing with v1.
6. **Sold-out + secondary is a dead end in the card.** A non-holder on a
   sold-out edition is told the download exists but the card doesn't route
   them to the live secondary listing when one exists (the data is on the
   page already). *Closer:* the `see market` state line above — v1 copy, not
   new machinery.
7. **Off-platform holders of ordinary collections get badge-only treatment.**
   The transfer webhook is hardcoded to the Pass collection, so a
   wallet-to-wallet recipient of Sylvester is invisible to the collectors
   index until they touch the platform; they can always download (live
   balance) but are never pushed. *Closer:* an Alchemy webhook per tracked
   collection is real new surface — deliberately deferred; the badge is the
   designed fallback.
8. **Editions above the 2,000-collector ceiling get no direct fanout** —
   refusal by design (§6.2), badge-only, until ops raises the Upstash budget
   with the cap. The artist-facing message says exactly this.
9. **The gate can ask a real holder to sign.** Path 2 exists precisely
   because the FC-verification union can miss a holding wallet; for that
   collector the experience is one extra signature with no explanation of
   why their ownership wasn't instant. *Closer:* copy that says `verify the
   wallet that holds this edition` — honesty, not machinery.
10. **Play is absent from Track B entirely.** Until Andrea answers §11 Q1,
    the "or playing live with online emu" half of the request — and the only
    mobile-first-class form of the work (see #1) — has no ship date.

---

## 9. Alternatives — validated, with two rationales rewritten

Validation steel-manned each rejected option; two rejections stand **on
different grounds than the first draft gave**, and one decision is now
explicitly scheduled for a re-vote.

| Option | Verdict | The honest reasoning |
|---|---|---|
| Plaintext zip on Arweave, txid held server-side | **Rejected — rationale rewritten** | The draft's "enumerable by owner wallet" is a one-line fix (dedicated upload wallet; the server path already omits the File-Name tag). The real reason: the pointer lives one careless serialization away from a public page payload, this team has shipped that bug class twice (`VIDEO_PLAYBACK_RCA.md`, `PATRON_GATE_MINIAPP_RCA.md`), and with plaintext that bug is a **permanent unrevocable public URL**. Encryption converts it to a non-event (§3.1) — at the cost of a worse worst case and the buffering ceiling. For the *public-play* ROM, plaintext is exactly what we use (§7). |
| Zip in `animation_url` / token metadata | **Rejected — stands as written** | Public by definition; every update = artist signature + inprocess PATCH + the `created_at` re-rank scar; contradicts "not on-chain". The Phase-3 metadata *mirror* is additionally dead (§4.1): nested-key passthrough is unproven and a frozen version descriptor is stale by construction. |
| Bytes in Redis (base64) | **Rejected — rationale replaced** | The draft's "per-download bandwidth billing" was **false** (Upstash PAYG bandwidth is free ≤200 GB/mo; 500 downloads of Sylvester ≈ $0.00). The real killers: base64 of a "music added" zip lands against the **10 MB hard request cap**, and — decisive — a user-controlled byte path coupled to the **$20 budget cap that hard-stops the platform's only datastore** (`REDIS_IMPLEMENTATION_REVIEW.md:580`) is a total-outage vector, not a degraded feature. |
| **Cloudflare R2 + presigned URLs** | **Deferred, scheduled re-vote — no longer "rejected"** | The steel-man is strong and the draft undersold it: zero-egress, deletable versions (permanence is an *anti-feature* for a file whose defining property is that it changes), presigned URLs delete the whole decrypt-buffer path, `aws4fetch` is ~5 KB, and `OPS_RUNBOOK.md:205` already contemplates R2. What keeps it out **today**: Cloudflare is *not yet* fronting this stack (`SCALING.md:27` — "CDN not yet fronted"; the `cf-connecting-ip` handling is defensive), so R2 now genuinely is a sixth external dependency with new credentials on a stack that counts to five. **The decision is sequenced, not closed: when `OPS_RUNBOOK.md §3` (the CDN cutover — the repo's own #1 infra move) executes, re-take this choice; the gate/versioning/notification layers are storage-agnostic behind `putFile/getFile`, so the swap is contained.** Trigger for an early re-vote: version churn (frequent large replacements), not file size — each superseded 16 MiB version is ~$0.51 forever on Arweave and $0 on R2. |
| Lit Protocol / client-side token-gated decryption | **Rejected — stands** | New protocol dependency + wallet decryption ceremony for a perk; the server already holds a simpler trust position. |
| One-day MVP: plaintext txid in `MomentMeta`, gate the pointer | **Noted as the honest spike** (the draft omitted it) | If the goal were "validate the UX with Andrea this week": one plaintext upload + the ownership gate + a pointer field, no crypto, no index, no notifications. Everything in it survives into the full design except the storage call. Kept on the table for sequencing (§12), not as the destination. |

---

## 10. Limits, costs, failure modes, obligations

### 10.1 Numbers (corrected)

- **Cap 16 MiB/version** — 2× the MBC5 format ceiling (8 MiB), 45× today's
  file. Costs at Turbo retail (~$32.56/GiB): Sylvester ≈ **$0.011**/version;
  worst case ≈ **$0.51**/version, permanent. Per-identity quota
  (`cfile-upload` 15/day, `cfile-bytes` 256 MiB/day) bounds one identity at
  ≈ $7.6/day of permanent spend — Sybil-multiplied, hence the **fail-closed
  platform day-ceiling** (§5), which is the only true backstop
  (`consumeUserQuota` and `checkRateLimit` both fail open;
  `PLATFORM_SIGN_DAILY_CAP` never covered the server-JWK path).
- **Memory:** PUT ≈ 64 MB × `MAX_CONCURRENT 1`; download ≈ 32 MB ×
  `MAX_CONCURRENT 2` — budgeted against the **6 GB container limit** next to
  `/api/img` (4×100 MB resizes) and transcode-gif (1×300 MB), not against the
  4 GB V8 heap (Buffers are off-heap; `OPS_RUNBOOK.md:96-104,128-129`).
- **Fanout:** ≤2,000 recipients ≈ ≤24 K Redis commands per notify (~4% of
  current monthly volume) — with the ceiling-refusal, pacing, and
  budget-table row from §6.2.
- **Fail-closed on authorization** (`strictRead`, `holdsEdition`, kill-switch,
  the day-ceiling); **fail-open on cost guards** (rate limit, quota) by
  platform convention. RPC-down and Redis-down produce 503 "temporary",
  distinguishable from 403 "not a collector".
- **Gateway risk:** the Arweave pool is `arweave.net` alone
  (`lib/arweave/gateways.ts:19-21`) — downloads share the exposure all media
  already has, softened by the failed-read memo and the optimistic Turbo
  cache window.

### 10.2 File-host obligations (validation forced this section into existence)

Serving artist-authored bytes under kismet.art creates duties the first draft
skipped:

- **Filename hygiene:** never echo `x-file-name`. Normalize to
  `[A-Za-z0-9 ._-]{1,64}`, strip control chars, quotes, path separators, and
  bidi overrides (U+202E can render `galleryexe.gb` as `bg.exe`), force a
  terminal `.zip`, RFC 6266-encode. The header value is artist-controlled
  input into a response header — treat it like one.
- **Zip sanity, honestly scoped:** the `PK\x03\x04` sniff is a typo filter,
  not a content control (JAR/APK/DOCX share it; readers parse from the end of
  the central directory). v1 stores bytes as-authored and relies on: `.zip`
  forced extension + `attachment` + `nosniff` + the kill-switch. Phase 2's
  extraction applies the real caps (§7).
- **Kill-switch + tombstone:** `kismetart:cfile-blocked` checked on
  **download** (blacklisting an artist must be able to stop an
  already-attached file, not just future PUTs); DELETE tombstones serving.
  The ciphertext on Arweave is permanent either way — the key never leaving
  the server *is* the takedown mechanism, which is itself an argument
  encryption wins over plaintext.
- **The sunset promise, re-scoped:** the draft's "if Kismet winds down we
  publish the master key" would republish **every moderated and malicious
  payload ever uploaded, forever**. Corrected commitment: *publish per-file
  keys for files not under moderation hold* (per-`keyId` derivation makes
  selective release trivial), or escrow key release per artist. Still a
  strong collector-protection story — now one we can actually keep (§11 Q3).

---

## 11. Open questions

1. **Which comes first for Andrea: public play, or the gated download?**
   Validation made a strong case (§12) that a *public* play page is days of
   work and markets the collect — but only Andrea can decide whether the
   Sylvester ROM should be publicly playable (that choice is irreversible for
   that version, §7). Their messages elaborate the download thrice and float
   play once; ask, don't guess.
2. **Seed `file_update` push on by default?** Recommendation yes; only
   `collect` is seeded today — product sign-off.
3. **Sunset stance, re-scoped:** commit publicly to "keys released for
   non-moderated files if Kismet winds down"? It should be a deliberate
   promise, not an accident (§10.2).
4. **Secondary-market copy:** one line in the collector UI: sell your last
   edition, lose the download. Mechanically settled; needs product blessing.
5. **Backfill scheduling:** run the Alchemy walk per-artwork on attach
   (recommended: only when the artist first attaches a file to a pre-feature
   artwork), or not at all and lean on the passive badge?
6. **The R2 re-vote** is calendared to the CDN cutover (`OPS_RUNBOOK.md §3`),
   or earlier if version churn materializes (§9). Owner: whoever executes the
   cutover.

---

## 12. Build plan — re-sequenced after validation

Validation's strongest structural point: **the gate, versioning, and
notification layers are storage-agnostic and survive every storage answer** —
so nothing below is hostage to the R2 re-vote. Its second point: a *public*
play page reuses the shipped `/api/img` byte path end-to-end and is **days**,
versus weeks for the full gated stack — but public play requires Andrea's
consent to publish the ROM (Q1). Hence two tracks instead of the draft's
three phases:

**Track A — public play (days; ships first IF Andrea wants public play):**
plaintext ROM upload at attach (or directly, pre-feature) → `/artwork/…/play`
full-page route → vendored single-threaded binjgb → touch controls. No new
secret, no index, no crypto, no notifications. It is also the live demo that
sells the collect on Farcaster, where a gated download is invisible in a cast.

**Track B — the gated download + versioning + notifications (the elaborated
ask; ships regardless):**
`lib/collectorFile.ts` (model + HKDF/GCM with `keyId`/AAD/known-answer test;
pure decision logic split for `scripts/verify-collector-file.ts` wired into
`verify:flows`) → lift `holdsEdition`/`holdsEditionBatch` into
`lib/ownership.ts` (batch variant gains the nullable-failure contract §6.2
needs) → `app/api/collector-file/` routes with the §5 guard ladder, locks,
concurrency caps, timeouts, and upstream hardening → two-path gate + grace
markers → collectors index + `cfile-refs` mirror writes (4 sites) + erase-
profile integration (§4.3) → `file_update` across 4 enforced + 3 checklist
touchpoints, ceiling-and-paced fanout, notify-lock cooldown → `BundlePanel`-
equivalent UI in `MomentDetailView` + post-collect CTA → Upstash budget-table
row + raised cap → end-to-end test with the actual Sylvester zip (attach →
collect on a test edition → download → byte-identical sha256 → replace →
notification lands → badge shows → rollback → still decrypts).

**Later:** collectors-mode play (`/api/collector-file/rom` + `playable`
config, §7 caps), overlay-skinned player chrome, zip-hygiene lint in the
manage panel, attach-at-mint, the R2 re-vote at CDN cutover.

If Andrea prefers everything gated, Track A folds into "later" and Track B
leads — the tracks are independent by construction.

---

## 13. Validation record

**Method.** Three independent adversarial passes over revision 1, plus a
first-hand re-verification of the auth chain: (1) a claim-by-claim fact-check
of every `file:line` anchor and mechanism assertion (61 claims audited: 38
confirmed, 6 wrong, 17 imprecise or missing a caveat — all corrected above);
(2) an attack pass on storage/crypto/ops (3 blockers, ~12 must-fix
amendments — all folded in); (3) a steel-man of each §9 alternative with
independently re-derived costs (two rejection rationales rewritten, one
decision re-scheduled, cost figures corrected 4–5×, phasing challenged);
(4) direct re-reads of `PATRON_GATE_MINIAPP_RCA.md` §9,
`app/api/raffle/enter/route.ts`, `lib/farcasterAuth.ts`, and the session
affordances, yielding the two-path gate.

**What survived unchanged — the load-bearing decisions:**
- Live `balanceOf` (`holdsEdition`) over the event-sourced ledger — every
  pass independently re-confirmed this as the only correct gate.
- Keeping file state off tokenURI/metadata (the `created_at` scar + artist's
  own "not on-chain, upgradable").
- Encryption-at-rest on Arweave via the existing server Turbo path — upheld,
  but on the rewritten §3.1 rationale.
- The new collectors reverse index with the listings-fill site included.
- The notification pipeline reuse + the passive badge as the floor.
- Fail-closed `strictRead` posture on gated reads.
- binjgb for play; full separation of public vs gated ROM delivery.

**What was wrong in revision 1 (worst first):**
1. Rollback was undecryptable (key derived from the mutable `v`) — fixed with
   `keyId` + AAD + pinned tag length + known-answer test.
2. The fanout had no cost model on a database with a hard-stop budget cap and
   a fire-and-forget push path — fixed with the ceiling/refusal, pacing,
   awaited push, and failure semantics that don't burn the cooldown.
3. Memory math was ~3× optimistic, PUT had no concurrency cap, and the upload
   helper has no timeout — fixed (PUT=1, DL=2, 6 GB-container framing,
   AbortSignal).
4. Concurrent PUT lost updates *after paying* for permanent storage; the
   cooldown had a read-then-write race — fixed with locks before spend.
5. The post-collect CTA would 403 during RPC lag — fixed with the grace
   marker minted by `/api/collect`'s already-receipt-verified path.
6. The gate missed holders outside the FC-verification union and used an
   uncapped expansion — fixed with the two-path gate + `planUnionCheck`.
7. Erase-profile could never reach the new per-artwork address data — fixed
   with `cfile-refs` + erase ordering.
8. Costs were 4–5× low, the Redis-blob rejection cited a nonexistent cost
   while missing the real one, and the plaintext rejection cited a fixable
   problem as architectural — all rewritten; the R2 rejection was downgraded
   to a scheduled re-vote.
9. Assorted: burst-dedup key has no tokenId (dropped); only 4 of 7
   notification touchpoints are compiler-enforced (now stated); the Phase-3
   metadata mirror was unsound (deleted); "bundle" naming collided with the
   size-check tooling (renamed); the AppleDouble `._*.gb` in the actual test
   zip breaks naive ROM detection (filter fixed); iframe/SAB assumptions for
   the emulator don't hold here (full-page route, single-threaded build);
   filename header injection, kill-switch, and the over-broad sunset promise
   (§10.2).

**Round 2 — UX validation (added after rev 2).** A dedicated pass traced the
experience against the real render paths (`MomentDetailView`'s action column
and edit surface, the collect success path, `NotificationModal`/`Row`/`Bell`,
`ProfileView`'s Collected tab, the Mini App affordances and sign-in surfaces)
plus the Mini-App auth/delivery mechanics. It produced §8.1/§8.2 and two
design changes: **the delivery ticket** (§5.1 path 4 — the JWT is
fetch-patched only, navigations carry no credentials in-app, RN WebViews
can't save blobs, and the repo has zero `sdk.actions.openUrl` or file-save
precedent, so without a ticket the primary surface simply could not receive
the file), and **the success-moment correction** (there is no collect success
surface to extend — feedback today is a toast plus a button relabel — so the
download card itself carries the moment, keyed on the optimistic
`hasCollected` flag rather than the RPC-lagged `alreadyOwned`). It also
relocated the card to the one clean seam in the action column
(`:2181/:2183`), moved the collected-tab pip to the card footer (all four
image corners are taken), and separated the manage panel from the metadata
save path (which drags a propagation wait, a second signature, and a chain
write). The residual-gaps ledger in §8.2 is that round's honest remainder.

**Implementation delta (shipped on this branch).** Track B is implemented as
designed with these evidence-earned refinements: (1) no pass gate on PUT (see
§5 — `/api/upload` and `update-uri` are the precedents, and on-chain
ADMIN|METADATA is the stronger check); (2) downloads are **ticket-first on
every surface** — one client code path mints a single-use capability URL and
web navigates to it while a Mini App hands it to `sdk.actions.openUrl` (the
download route still honors a plain cookie navigation as a fallback);
(3) a small `GET /api/collector-file/status` read powers the card + update
badge (public descriptor + the viewer's last-downloaded version); (4) the
`notifiedAt` display field was dropped — the `SET NX EX 86400` notify-lock IS
the cooldown state and the manage view reads its TTL, so there is no second
copy to drift; (5) tickets are **peeked** up front and **consumed only after
the bytes are read and integrity-checked** — a busy slot, a Redis blip, or
a mid-transfer failure never burns the single use, and the losing racer of
a double-redeem gets the 403; (6) share tickets (30-min TTL, marked `share`
in the ticket record) land on an HTML **confirm page** unless `go=1` is
present, so link-unfurl bots in chat apps can't redeem them, and
`Sec-Purpose`/`Purpose` prefetch requests get a body-less 204; (7) the
crash-resume cursor of §6.2 lives in the notify-lock's value, written per
delivered batch; (8) the §10.2 kill-switch has an admin route
(`/api/admin/cfile-block`, GET/POST) that audits every block/unblock
through `recordAdminAction`; (9) the artwork page reads the record via
`getCfileRecordForSSR` — strictRead with a tri-state result, so a Redis
blip renders as "descriptor unknown" (the card fetches status itself)
rather than as "no file attached". The `file_update` push type ships seeded
ON for new registrations per §6.3's recommendation (a one-line revert if
product disagrees).

**Storage-pivot delta (see the pivot note at the top).** On top of the
above: the byte path is `lib/collectorFile.ts`'s chunked blob store
(`writeCfileBlobChunks`/`readCfileBlob`/`commitCfileMutation`) with
sequential per-chunk commands and 'b'-prefixed base64 values; `planAttach`/
`planRollback`/`planDetach` in the pure core own the 3-version retention
window via explicit `stored` flags (position can't tell you bytes exist —
detach frees bytes while keeping rows) and emit the exact chunk keys each
commit must delete; the PUT ceiling checks the `cfile-bytes` ledger
fail-closed; rollback is offered only for `restorable` rows.
`scripts/verify-collector-file.ts` (wired into `verify:flows`) now pins the
chunk codec round-trip, the request-cap margin, JSON-unparseability of
chunks, the storage math the ceiling ledger relies on, and the retention
planner's prune/never-prune/detach invariants.

**Format extension (post-merge).** The feature accepts **zip, PDF, and GLB**
(Binary glTF). One registry in the core (`CFILE_KINDS`: extension, MIME,
magic bytes) drives everything: the server detects the format from leading
magic bytes only (`PK\x03\x04` / `%PDF-` / `glTF` per the IANA
`model/gltf-binary` registration) — never from the claimed extension or
Content-Type header — the normalizer forces the DETECTED kind's extension
(a PDF named `model.glb` serves as `.pdf`), the download route serves the
kind's MIME, and every file still ships as `attachment` + `nosniff` (a PDF
is never rendered inline on the origin). `CfileVersion.kind` is optional —
records written before the extension are all zips and read as such. The
chunk store, gate, tickets, retention, ceiling and notifications are
format-agnostic and unchanged; the 16 MiB cap stays uniform. Client pickers
share one accept-list (`lib/collectorFileTypes.ts`) and upload as explicit
`application/octet-stream`, leaving the magic bytes as the single authority.

**Viewer + SVG (post-merge).** The feature accepts a fourth kind, **SVG**,
and renders two of the four **in-page**. Rationale, in order: a zip can
already carry any file, so first-class kinds buy convenience, not delivery —
what creates new value is *viewing*. GLB earns a viewer because most
collectors cannot open a `.glb` at all (iOS Quick Look is USDZ-only; macOS
Preview and current Windows have no handler); SVG earns one because its
viewer is free (`<img>`); PDF deliberately gets none, because it opens
natively everywhere and honest in-page rendering on iOS would cost a pdf.js
dependency (Safari renders iframe PDFs as a first-page-only image).
**Everything stays downloadable** — viewing and downloading serve different
needs (see it now vs. keep it), both sit behind the same collect gate, and
since viewing transfers the same bytes, offering both costs nothing.

`GET /api/collector-file/view` is a SEPARATE route from the download path
because four of its properties are inverted: session-only (no tickets — a
ticket exists so a Mini App can hand a URL to the device browser for
*saving*), never stamps the download marker (seeing is not having: it would
tell a v2 holder they are current on v3 and count lookers in the artist's
downloader stat), cacheable (`private, max-age=3600` — a cached copy is a
downloaded copy anyway, and it keeps repeat views off the metered bandwidth
and the reassembly slot; the accepted cost is that a seller keeps cached
viewing for the window), and viewable-kinds-only. Views debit their own
looser `cfile-view` meter rather than rationing the download budget.

Two format-specific facts drive the implementation. **SVG has no magic
bytes** — it is XML text that may open with a BOM, whitespace, an XML
declaration, comments, or a DOCTYPE — so it is detected by a *bounded* text
sniff (4 KB) that runs only after every binary matcher fails; binary
signatures therefore always win. **SVG is the only active-content kind we
store**: it can carry `<script>`, event handlers and `foreignObject`, and
blob: URLs inherit the creating origin, so navigating to one would execute
artist script as kismet.art (the WhatsApp/Telegram Web XSS). Browsers
disable scripting only in *image* contexts, so the rule — pinned in the
viewer's comments and by the verify oracle's viewable-kind assertions — is:
render SVG exclusively through `<img src={blobUrl}>`, never inline, never
`<object>`/`<iframe>`, never opened; and the view route keeps `attachment`
+ `nosniff` so even a direct navigation saves rather than renders. Our CSP
is Report-Only, so that discipline is the control, not a second line.

**Net verdict.** The architecture is optimal *for this stack today* in the
precise sense that every layer reuses a pattern that has already survived
production here, adds no external dependency, and keeps the artist's three
explicit properties (upload from Kismet, not-on-chain upgradability, update
notifications) first-class. Two decisions are deliberately left open because
they belong to humans, not this document: whether Sylvester's ROM plays
publicly (Andrea), and whether storage moves to R2 once Cloudflare actually
fronts the stack (ops, at the CDN cutover).
