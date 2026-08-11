# Why a fresh mint can be missing from the home / latest-sales feeds

_Investigation of the report "text mints (or a recent mint by
`0x4a90f5a9401158a70f5f307aa13ff0b0e62c7b51`) aren't showing up in our main
feed or latest sales feed." Every mechanism claim below is anchored to code
(`file:line` at the commit this document ships with). Production state could
not be queried from the investigation sandbox (network egress to kismet.art /
api.inprocess.world is policy-blocked there), so §4 ships a diagnosis script
that pinpoints the failing gate in one command wherever egress is open._

---

## 1. What the two surfaces actually request

| User-facing surface | Request | Evidence |
|---|---|---|
| **Home tab** ("main feed", mints sub-tab) | `/api/timeline?scope=standalone` | `components/DiscoverPage.tsx:56-59,398-400` |
| **Trending tab → "latest sales" pill** (default) | `/api/timeline?sort=latest-sales&scope=standalone` | `components/DiscoverPage.tsx:330-345,363` |
| Profile "created" tab (where a mint *does* appear) | `/api/timeline?creator=<addr>&limit=50` — **no `scope` param → `'all'`** | `components/ProfileView.tsx:500`, `app/api/timeline/route.ts:237-239` |

Both problem surfaces request **`scope=standalone`** — the strict "Mints"
scope. The profile feed does not. That asymmetry is the single most likely
explanation for "visible on the profile, missing from both feeds" (gate G4
below).

## 2. The gate chain — everything a moment must pass

`/api/timeline` builds every feed the same way: fan out to In Process's
per-collection `GET /timeline`, merge, filter, sort, slice
(`app/api/timeline/route.ts`). A moment appears in the **home** tab only when
**all** of G1–G4 hold; **latest sales** additionally needs G5; position needs
G6.

| Gate | Requirement | Enforced at | Written by |
|---|---|---|---|
| **G1** | Collection ∈ `kismetart:collections` (tracked set) — otherwise the fan-out never fetches it: **invisible in every feed, including the profile** | `route.ts:291-293` → `lib/kv.ts:72-81` | **Only** `POST /api/collections` (`app/api/collections/route.ts:541`) — invoked **client-side** after auto-deploy mints (`lib/registerCollection.ts`, `components/MintForm.tsx:802,924-929,1361-1367`) |
| **G2** | In Process's `/timeline?collection=…` returns the row (its index is fed by its own `moment/create[/writing]` endpoints, not chain scans — see `app/api/timeline/route.ts:116-123`) | `route.ts:90-131` | In Process (upstream) |
| **G3** | Not hidden: moment / parent collection / creator (`kismetart:hidden-*`) | `route.ts:795-833` | admin & creator hide actions |
| **G4** | `<addr>:<tokenId>` ∈ `kismetart:created-mints` — the **strict Mints scope**: "only moments tracked in created-mints (mints via MintForm + covers minted at Create-Collection time) appear" | `route.ts:503-514` → `lib/kv.ts:145-165` | **Only** `lib/mint-proxy.ts:397` (`after()`, best-effort) + the Create-Collection cover path (`app/api/collections/route.ts:569`) |
| **G5** | Latest/most-sales only: **not** in the free census `kismetart:sale-free` (free mint ≠ sale), and ranked by `kismetart:trending-latest` — written **only** by Kismet's own `/api/collect` (`app/api/collect/route.ts:267-270`). Unranked rows sort **below every ranked row** | `route.ts:682-716` | `/api/collect` (rank), `/api/moments` browse write-through (census, `app/api/moments/route.ts:129-136` → `lib/saleEnds.ts`) |
| **G6** | Ordering: newest-first uses the KV `moment-meta.createdAt` pin when present, else upstream `created_at` | `route.ts:434-475,773-780` | `mint-proxy` `setMomentMeta` at mint; timeline stitch backfills pins for rows that already have a meta record |

**Nothing anywhere filters text mints as a category.** A writing mint flows
through `/api/write` → the exact same `proxyMintRequest` as media mints
(`app/api/write/route.ts:5`), gets the same `markCreatedMint`/`setMomentMeta`
writes, and the media classifier (`lib/media/resolveMomentMedia.ts:56`,
`content.mime === 'text/plain'`) is only consulted when a viewer applies the
`media=` browse filter. If a text mint is missing, it failed a *generic* gate
— the same one a media mint would have failed on the same path.

## 3. Where the pipeline actually loses mints (validated weaknesses)

These are the concrete ways a *successful on-chain mint* ends up invisible.
Ranked by likelihood for this incident.

**W1 — G4 loss: the created-mints write is fire-and-forget, unrepaired.**
`markCreatedMint` runs inside `after()` (post-response), `.catch(bestEffort…)`
(`lib/mint-proxy.ts:395-397`): a Redis blip logs and is lost **forever** — no
retry, no reconciliation (the repo has `reconcile-*.mjs` scripts for two other
lost-write classes, none for this one). A container restart between response
and `after()` (every deploy on the single-box setup) drops the whole hook
batch. Symptom matches this incident exactly: **on the profile (scope `all`),
missing from home + trending (scope `standalone`), permanently.**

**W2 — G4 skip: the writes are gated on upstream response shape.**
All post-mint KV writes run only `if (contractAddress && tokenId)` parsed from
the In Process 200 body (`lib/mint-proxy.ts:335-341`) — and the skip is
**silent** (non-OK responses are logged; an OK-but-shapeless one is not). In
Process migrates its contracts (the 2026-07 comments migration,
`lib/inprocess.ts:14-16`), so a drift here would break feed registration for
**every** new mint while mints keep succeeding on-chain. No CI pin covers this
(`scripts/verify-mint.ts` checks splits + intent schema only).

**W3 — off-platform mints are excluded from home *by design*.**
A moment minted on inprocess.world (or any other In Process client) into a
tracked collection shows on the artist's Kismet profile but is deliberately
dropped from the strict Mints surface (`app/api/timeline/route.ts:489-492`,
`lib/kv.ts:38-42`). If the artist minted this piece outside Kismet, current
behavior is working-as-designed — and the question becomes policy (§5 F3).

**W4 — G1 loss: auto-deploy wrapper registration is client-side only.**
After an auto-deploy mint, the **browser** must call `POST /api/collections`
(`registerCollectionWithBackoff` — fire-and-forget, bails permanently on
401/403, dies with the tab). The server never registers the wrapper itself.
Consequence: close the tab at the wrong moment → the moment is invisible
**everywhere** (profile included). And the **agent mint path has no browser at
all**: a Base-MCP agent auto-deploy mint (`public/agent-skill/references/mint.md:81`
→ `/api/mint`|`/api/write`) leaves the wrapper permanently untracked — agent
first-mints are structurally invisible today. (Existing-collection mints are
unaffected — the collection is already tracked.)

**W5 — latest-sales semantics: new mints don't belong there until collected.**
Rank = most-recent **Kismet** collect; free mints are censored out entirely; a
priced-but-uncollected mint is present but sorts below every ranked row —
pages deep, effectively invisible (`route.ts:693-716`). Collects made on other
clients never rank it (the zset is written only by `/api/collect`). Agent
mints default to **free** (`app/api/agent/prepare-mint/route.ts:115`), so an
agent mint will *never* appear in latest sales, by design. New-mint visibility
is the home tab's job, not this tab's.

## 4. Pinpointing this specific mint (run where egress is open)

```
UPSTASH_REDIS_REST_URL=… UPSTASH_REDIS_REST_TOKEN=… \
node scripts/diagnose-feed-visibility.mjs --creator 0x4a90f5a9401158a70f5f307aa13ff0b0e62c7b51
```

The script (read-only; ships with this document) checks every gate above in
route order for the artist's newest works — or one piece via
`--artwork <collection>:<tokenId>` / the artwork URL — and prints the failing
gate plus the exact one-off remedy. Decision table it automates:

| Observation | Diagnosis | Remedy |
|---|---|---|
| On profile, missing from home | **G4** — not in `created-mints` | `SADD kismetart:created-mints <addr>:<tokenId>`; if minted through Kismet, also investigate W1/W2 |
| Missing from profile too; artwork URL loads | **G1** (untracked wrapper) or **G2** (upstream index gap) | `SADD kismetart:collections <addr>` / escalate to In Process |
| In home, missing from latest sales | **G5** — free mint (by design) or no Kismet collect yet (unranked) | none — or the product change in §5 F4 |
| In feeds but far down | **G6** — no `createdAt` pin + old upstream `created_at` | pin via `moment-meta` |

## 5. Recommended fixes, ranked for this codebase

**F1 — make feed registration server-side and loss-proof (the real fix).**
In `proxyMintRequest`, on upstream success:
1. `await markCreatedMint(...)` + `setMomentMeta(...)` **before returning the
   response** instead of inside `after()`. Two Redis REST calls (~ms) appended
   to a request that already waited up to 60 s on In Process — latency-noise,
   and it eliminates the restart/after() loss window. Keep the heavy fan-out
   (notifications, drop coordination) in `after()`.
2. When the request was an auto-deploy (`hasNameAndUri`), also
   `addTrackedCollection(contractAddress, { name, artist: account }, 'auto-deploy')`
   server-side. Closes W4 for browser *and* agent mints in one move —
   `source: 'auto-deploy'` never touches the curated set, so the fail-closed
   classification (`lib/kv.ts:210-216`) is preserved. The client's existing
   `registerCollectionWithBackoff` stays as meta enrichment (image/thumbhash)
   and is now redundant for correctness instead of load-bearing.
3. `console.error` when a 2xx upstream body lacks `contractAddress`/`tokenId`
   (W2's silent skip becomes a tripwire), and pin the handling in a verify
   script alongside `verify-mint.ts`.

**F2 — repair what's already lost.** Run the §4 script; apply the printed
`SADD`s for this artist's piece(s). If the scan shows a wider gap, add the
missing members in bulk: any moment in a tracked collection that has a
`kismetart:moment-meta` record but no `created-mints` membership was
Kismet-minted (only Kismet paths write meta) and is safe to re-admit — the
same dry-run-by-default pattern as `reconcile-pass-validity.mjs`.

**F3 — only if this piece was minted off-platform:** decide the policy.
Recommended: keep the strict scope (it exists to keep home = Kismet mints) and
admit specific off-platform pieces deliberately via `SADD` (it *is* the
admission API). The alternative — auto-admitting all moments by rostered
Kismet artists — is a product decision, not a bug fix; don't back into it.

**F4 — latest sales:** leave ranking as-is (it honestly means "latest
collects"). If the missing piece is free, its absence there is permanent by
design; if priced, it appears the moment someone collects it on Kismet.

---

## 6. Incident resolution + chosen design (2026-08-11)

**Confirmed root cause.** The §4 script ran in production against
`0x4a90f5a9…b51`: the missing piece is `0x4dd71c80…8f66:2` ("37 bulders",
`image/gif`, minted 2026-08-09) — **not a text mint**; both of the artist's
`text/plain` pieces pass every gate. The piece failed exactly G4
(`created-mints: NO`) with `moment-meta: MISSING` and every other gate green —
i.e. **minted off-platform** (In Process directly) into the collection Kismet
auto-created for the artist's 2026-07-30 mint. It even had 2 Kismet collects
(latest 2026-08-10T07:57Z), so it was *ranked* in latest-sales yet excluded by
the same scope filter. Repaired in production with
`SADD kismetart:created-mints 0x4dd71c80a42b6d186ef921fd4ab4dbf917e98f66:2`
(result 1). W3 was the incident; W1/W2/W4 remain open latent classes.

**Going-forward policy** (matches the operator's expectation that surfaced
this): *a moment minted into a Kismet-registered collection **after** that
collection joined Kismet belongs in the Mints surface, whichever In Process
client minted it.* Moments predating registration stay excluded — the
"legacy" exclusion the strict scope was built for.

**Options weighed:**

| Option | Verdict |
|---|---|
| D0 — status quo, manual `SADD` per incident | Recurs on every cross-post; whack-a-mole |
| A — read-path classifier only (admit `created_at ≥` registration at filter time, no writes) | Policy lands instantly, but membership state diverges from the other consumers (sitemap `scanCreatedMints`, reconcile mint-counts, the future Mints ZSET of `REDIS_IMPLEMENTATION_REVIEW.md` #3), and every future consumer must re-implement the rule |
| B — cron reconciler (`/api/cron` + `CRON_SECRET` infra exists) | Converges membership but adds a scheduled component, up-to-interval staleness, and a duplicate In Process fan-out the feed already performs constantly |
| **C — write-through admission in the timeline route (chosen)** | The route already fans out to every tracked collection, already batch-reads every candidate's moment-meta, and already hosts two write-through stitches on this exact path (`pinMomentCreatedAtBatch`; `recordSaleEnds` on `/api/moments`). Admission is the third: zero new infra, zero staleness, membership stays the single materialized truth |

**C in one paragraph.** In the `scope=standalone` filter
(`app/api/timeline/route.ts:503`): for a candidate **not** in
`created-mints`, read its collection's registration stamp
(`collection-meta.createdAt` — deploy-time, first-write-wins, so the boundary
is stable; one MGET of the merge's unique collection addresses, memoizable
15 min since stamps are immutable). If the moment's `created_at` ≥ the stamp,
keep the row in this response **and** `after()`-SADD it into
`kismetart:created-mints` (chunked batch + per-pod seen-cache + `bestEffort`
— the exact shape of the createdAt-pin stitch). Fail-closed everywhere: no
meta record, no stamp, or unparseable `created_at` ⇒ excluded, i.e. today's
behavior.

**Accepted residuals** (documented, not blocking):
- In Process's reindex-on-edit can bump a *meta-less* legacy row's
  `created_at` past the boundary → admitted permanently. Rare, and the
  moment-meta pin already protects every Kismet-minted row; an edited legacy
  piece surfacing is defensible behavior.
- Admission inherits In Process's rate limits rather than Kismet's mint
  quotas: an artist spamming their own collection off-platform now reaches
  home. Bounded per response by the fan-out's per-collection sample; the
  hide-user/collection/moment levers remove instantly.
- Admitted rows stay meta-less (no fabricated creator — the laundering rule
  in the pin stitch holds), so their ordering rides In Process `created_at`.

**Ship alongside (source-side hardening, §5 F1):** await
`markCreatedMint` + `setMomentMeta` *before* the mint-proxy response (two
Redis calls appended to a ≤60 s upstream request; the heavy fan-out stays in
`after()`); register auto-deploy wrappers server-side
(`addTrackedCollection(…, 'auto-deploy')` — closes the agent-mint G1 hole,
where no browser exists to call `/api/collections`); `console.error` when a
2xx upstream body lacks `contractAddress`/`tokenId`, with a verify-script pin.
The admission stitch is the net; the hardening keeps Kismet-minted pieces
from ever needing it.

*Investigation notes: production state was validated 2026-08-11 via the §4
script run in-container (egress from the original investigation sandbox was
policy-blocked). The upstream rows also carry a truthy top-level `hidden`
field with In Process semantics — already defended in `MomentCard.tsx:163-167`
(badge only for `isOwnMoment`), no action needed.*
