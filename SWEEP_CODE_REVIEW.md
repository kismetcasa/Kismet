# Sweep branch — line-by-line code review

_Every added, changed, or removed **code** line on `claude/blissful-thompson-ri31io`
relative to `main` (21 code files across the index/API phase, §1–§12, and the
client phase, §13–§19; the Markdown documents are out of scope),
with a verdict per line or per inseparable unit (a statement that spans lines,
a docblock) and the exact reason it earns its place — or the fix applied when
it did not. Line numbers refer to the files as they stand after this review's
fixes. Unchanged neighbouring lines are cited only as context, never
reviewed._

> **Method.** Each file was read in full with line numbers; each unit was asked
> two questions — *what breaks or becomes wrong if this line is deleted?* and
> *is every claim in it true of the code and of the external systems it
> names?* A unit stays when both answers hold. Claims about viem, Multicall3,
> and go-ethereum were checked against source (see `SWEEP_IMPLEMENTATION.md`
> §10). Where a unit is a test, the question is whether its assertion can fail.

---

## 0. Findings and fixes from this review

Seven units did not meet the bar as written. All are fixed in the same commit
as this document.

| # | File:line (after fix) | Finding | Fix |
|---|---|---|---|
| F1 | `lib/sweepIndex.ts:81–85` | **Robustness bug.** A candidate's `addr` can originate from an upstream inprocess row (`m.address`), not only the validated tracked set. An invalid address would throw inside `encodeFunctionData` (line 129) and abort **every** rebuild until that row changed — one bad upstream row would silently freeze the pool forever. | Validate with `isAddress` and skip the row, the same tolerance the census shows such rows. |
| F2 | `scripts/verify-sweep.ts:300` | **Vacuous assertion.** The check ended with `&& ha.length < 60 + 1`; the maximum possible length is 60, so the clause could never fail and only pretended to test something. | Removed the clause; the meaningful predicate (no `ART_3` row survives) stays. |
| F3 | `app/api/admin/sweep/route.ts:24–34` | **Dishonest fallback.** `isSweepEnabled().catch(() => false)` reported *disabled* when the truth was *unknown* (Redis unreadable) — an operator could conclude the feature is off while it is on. | A flag-read failure is a 503. The comment also records the memo caveat: a cached verdict can outlive a blip that nulls the index. |
| F4 | `app/api/sweep/route.ts:32–35, 53` | **Slow flag propagation.** The flag-off answer carried `stale-while-revalidate=120`, so a shared cache could serve "disabled" for up to 150 s after an operator enabled the feature. | Separate `DISABLED_CACHE` without SWR (≤ 30 s plus the 60 s memo). |
| F5 | `lib/sweepIndex.ts:44–48` | **Wrong number in a comment.** Said "≈ 20 KB of calldata"; a 200-element `Call3[]` encodes to 256 bytes per element = ≈ 51 KB, with ≈ 58 KB of return data. It also cited a gas figure that was not derived. | Corrected sizes with the encoding arithmetic; the gas claim is now qualitative and true. |
| F6 | `lib/zoraMint.ts:66–70` | **Vague reason.** "must not carry the payable mint() entry along" did not say why a second ABI exists at all. | States the real reason: keeping the payable `mint()` unexported forces every mint encoding through `buildEthMintCall`, the treasury-critical single source. |
| F7 | `lib/statsHealth.ts:3–4` | **Formatting wart.** My edit had broken a sentence across a two-word line. | Reflowed. |

_Line numbers throughout §1–§12 are as of the client phase: the client phase
inserted one import line in `lib/saleConfig.ts` (after line 14), removed five
lines from `app/api/sweep/route.ts` (the response type moved to the core), and
added header and import lines to `scripts/verify-sweep.ts` (after lines 19 and
40); every anchor below was re-read against the final files._

Also added under review: a comment at `lib/sweepIndex.ts:77–79` giving the
patron re-check its reason (it would otherwise read as dead duplication of the
census's exclusion), and `Moment[]` typing at `app/api/sweep/route.ts:87` in
place of an indirect `ReturnType<…>[]`.

**Considered and deliberately left unchanged**

| Unit | Why it stays as is |
|---|---|
| Explicit `private, no-store` headers on responses Next would already serve uncached | Repository convention (`/api/admin/*`, the agent routes) and robust if a route is ever made cacheable; two short constants. |
| `getSweepIndex` validates only the blob's top-level shape, not each item | The blob is written only by `rebuildSweepIndex`; the serve path never parses numbers from it (`selectSweepItems` reads strings); per-item validation would be code for a failure mode that does not exist. |
| The `sweep-index` phase records no `skipped` outcome when the census is skipped | `sweepHealthy` is computed from `lastError` and the blob's age, not `lastRunAt`, so a `skipped` stamp would change nothing observable. |
| `String(it.m.token_id)` (`lib/sweepIndex.ts:86`) | The type says `string`, the runtime value is upstream JSON; the cast costs nothing and keeps `isValidTokenId` honest. |
| `keyOf` and `interleaveTier` lowercasing already-lowercase input | `lib/sweepRank.ts` is a public pure API; its own contract cannot assume the index's normalization, and the verifier feeds it mixed case. |
| `export const runtime = 'nodejs'` on both routes | Matches every sibling API route that touches Redis and viem. |

**Checks after the fixes:** `typecheck` ✅ · `lint` ✅ · `verify:sweep` ✅ (77 assertions at this revision; 104 after the client phase — F2 removed a vacuous clause from one of them, not an assertion).

**Client phase — findings caught by the same review before commit** (the code
in §13–§19 was read line by line before it was committed; these are what that
read changed, recorded so the commit is not mistaken for a first draft):

| # | File:line (after fix) | Finding | Fix |
|---|---|---|---|
| C1 | `hooks/useSweep.ts` (removed) | A `void sweepTotalValue` line "referenced" an otherwise-unused import so the import would not be flagged — a line whose only purpose was to justify another line. | Import and line removed; the verifier is where `sweepTotalValue` earns its place. |
| C2 | `hooks/useSweep.ts:142–143` | An all-invalid pool page fell through to `fetchEligibleTokensMulti` with no refs, whose empty-input answer is indistinguishable from an RPC failure, so the sheet would have said "could not verify" instead of "nothing to sweep". | Early return before the read. |
| C3 | `hooks/useSweep.ts:219–224` | If three consecutive simulations failed on insufficient funds, the loop could exit with a basket that never passed a simulation, and that basket would have reached the wallet. | On the last allowed simulation the remainder is shed as unaffordable; a non-empty basket is now always one that passed a simulation. |
| C4 | `hooks/useSweep.ts:246–250` | When the gas estimate was unavailable the final affordability check was skipped entirely. | The constant headroom stands in for a missing estimate, so the check always runs. |
| C5 | `components/SweepSheet.tsx:223–224` | With an empty basket the totals line rendered "0 artworks · free" (`formatPrice("0")` prints "free"). | The price is shown only when the total is non-zero. |

---

## 1. `lib/sweepRank.ts` — new, 115 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–18 | Module docblock | Keep | The three rules a reader needs before touching the sort: outlay not sticker price (the arithmetic 0.0001 + 0.000111 = 0.000211 ETH is correct), tier interleave, and the dormant options. 15–16 state the zero-import constraint the verifier depends on (it runs on bare Node). 16–17 draw the boundary with the core — paid-ness is not decided here — which is why no assertion in this module's tests claims it. |
| 20–29 | `RankableSweepItem` | Keep | Every field is consumed: `address`/`tokenId` by `keyOf` (39); `outlayWei` by the primary compare (44); `artist` by the interleave (63–74) and the cap (108–109); `createdAtMs` by the tie-break (45–47). Nothing else is carried, so the ranker cannot silently depend on a field the index forgets to fill. |
| 31–37 | `RankOptions` | Keep | Both options are read (92, 104). They exist dormant so the "no cap or floor for v1" decision is reversible by one call-site change, and so their semantics are pinned now (verifier 204–216) instead of invented later under pressure. |
| 39 | `keyOf` | Keep | The final tie-break must be a total order or the output depends on input order; the key is the canonical member form. Lowercases because this is a public API that accepts mixed-case addresses (the verifier feeds a mixed-case `COL_A`). |
| 41–51 | `compareBase` | Keep | 44: bigint comparison — wei exceeds 2^53, so no `Number` coercion. 45–46: `NEGATIVE_INFINITY` for unknown dates makes them sort after every known date under the descending compare at 47 (pinned 198–200). 48–50: key tie-break closes the order; determinism under shuffling is pinned at 232. |
| 53–58 | Docblock | Keep | Names the two invariants the loop relies on: input already in `compareBase` order; unattributed items never merged. |
| 59–81 | `interleaveTier` | Keep | 60–61: two structures because two facts are needed — first-appearance order (`groups`) and membership lookup (`byArtist`); a null-artist item needs a group with no key, which the array provides. 63–66: singleton groups for unattributed items (pinned 193–195). 67: lowercase guards a mixed-case `artist`. 76–80: round-robin. Termination: round `r` pushes every group's item at index `r`; the sum of group lengths equals `tier.length`, so the guard at 77 fails exactly after the longest group is drained. |
| 83–87 | Docblock | Keep | The contract callers rely on: the whole ranked list, not a prefix. |
| 88–115 | `rankSweepCandidates` | Keep | 92–93: copy before sort — `sort` mutates in place and the caller's array must survive; the floor filter produces the copy when set. 94: one sort. 96–102: tiers are contiguous runs of equal outlay after the sort, so a linear scan segments them. 104–105: a cap applies only when it is an integer ≥ 1 (pinned 211–213: 0, −1, 1.5, NaN are ignored); a silently applied `perArtist: 0` would rank nothing. 106–114: the cap walk keeps each artist's earliest (cheapest) items and never counts unattributed ones (pinned 207–209). |

## 2. `lib/sweepIndexCore.ts` — new, 253 lines (1–229 here; 231–253 in §18)

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–4 | Imports | Keep | All consumed: `Moment` (215, type-only, so the core stays runtime-free of the inprocess module), `MAX_COLLECT_ALL_BATCH` (16), the two classifiers (97, 117), the ranker and its types (137, 150). |
| 6–12 | Header | Keep | Fixes the module's scope (pure; ETH-only; USDC invisible by design) where a future contributor looks first. |
| 14–17 | `SWEEP_MAX_N`, `SWEEP_DEFAULT_N` | Keep | The cap is the collect-all cap by import, not a copied `20`, so the two cannot drift (pinned 299). Default 10 is the design's default basket. |
| 18–22 | `SWEEP_POOL_SIZE`, `SWEEP_SERVE_MIN` | Keep | 120 = 6 × 20: the serve prefix is up to 60 rows (3n), so the blob keeps a second full reserve for click-time drops (pinned 300). 30 floors the serve prefix so a small `n` still returns a usable reserve. |
| 24–53 | `SweepIndexItem` | Keep | Each field has a consumer in the shipped API or the designed client: `address`/`tokenId` (keys, calls); `priceWei` + `feeWei` (sheet line, per-call `value` recomputation); `outlayWei` (sort key, stored so serving never re-adds); `maxPerAddress` (client cap check without a read); `remaining` (sheet count; the scarce-edition tie-break option); `saleEnd` (sheet countdown); `creator` (display; hidden-user filter, 201); `artist` (interleave; filter, 202); `createdAt` (tie-break, 138); `name`/`image`/`thumbhash` (sheet rows; projection 224–226). Wei as strings because the blob is JSON. |
| 55–61 | `SweepIndex` | Keep | `eligible` is what an operator judges before enabling; `updatedAt` drives the health age. |
| 63–73 | `SweepCandidate` | Keep | Decouples the pure core from `ResolvedCatalogItem` (which drags a full `Moment` and `MomentMeta`); the builder maps one to the other (`lib/sweepIndex.ts:94–105`) and the verifier constructs candidates directly. |
| 75–87 | `SweepSaleRow`, `SweepSupplyRow` | Keep | The minimum the rules need; `fundsRecipient` and `uri` are absent on purpose so decoded rows never hold strings. |
| 89–90 | `sweepKey` | Keep | One definition of the member form shared with the hide sets and `/api/collect`; lowercases so two keys can never denote one token (pinned 301). |
| 92–99 | `isLivePaidSale` | Keep | The type predicate (95) is what lets `buildSweepItem` use `sale` after the guard without a cast. 97 delegates the shared window rule; 98 is the product decision (free excluded) in exactly one place. |
| 101–135 | `buildSweepItem` | Keep | 115–118: the three drop reasons, each pinned (152–154). 116 is the fail-closed fee rule: absence from the fee map means "unknown or out of bounds" (`lib/saleConfig.ts:740–751`), so the token cannot be priced honestly. 120 lowercases at the boundary (pinned 156). 131–133: conditional spreads keep absent preview keys absent (pinned 167), so the blob carries no `undefined`/null noise. |
| 137–147 | `toRankable` | Keep | The string-wei → bigint adapter; `Date.parse` of the ISO pin, NaN → null. Returns the item alongside so the ranked order maps back (151). |
| 149–162 | `rankIndexItems`, `finalizeSweepIndex` | Keep | 161: `eligible` is the ranked count before the cut (pinned 257) and `items` the cut (258–259). |
| 164–170 | `clampSweepN` | Keep | Defaults on absent or garbage, clamps to `[1, SWEEP_MAX_N]` (pinned 284–288). `parseInt`, not `Number`, so `"7.9"` yields 7 rather than a fractional count. |
| 172–175 | `serveCount` | Keep | The 3n reserve rule with its floor (pinned 282). |
| 177–206 | `selectSweepItems` | Keep | 197: the bound is checked before the filters, so the prefix is exactly `serveCount(n)` visible rows. 199–200: moment and collection hides. 201–202: both identities are checked because the census's hidden verdict uses the unfolded creator while an admin may have hidden the folded EOA behind a smart-wallet creator; the sweep is thereby at least as strict as the feeds. Pinned 274–281. |
| 208–229 | `sweepItemToMoment` | Keep | Projects onto `Moment` so `/api/sweep` can call the feeds' enrichment unchanged — the only way to get username, avatar, the curated-collection chip and the hidden-identity scrub from one choke point. 219/221: `uri`/`admins` are required by the type and unread by enrichment. 220: `hidden` is a required `MomentAdmin` field; `false` is the only honest constant (the index knows nothing about it) and enrichment does not read it. Pinned 293–297. |

## 3. `lib/sweepIndex.ts` — new, 223 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–22 | Imports | Keep | All consumed: `decodeFunctionResult` 137/163; `encodeFunctionData` 126/153; `Address` 129/152/179; `getBlock` 64; the two Redis keys 191, 214, 220–221; `serverBaseClient` 115; `isFlagSet` 215; `memoize` 217; `isAddress` 85; `isValidTokenId` 89; `PATRON_COLLECTION_ADDRESS` 80; `FPSS_SALE_ABI` 127/137, `aggregate3Strict` 122/149, `readMintFeesWithBound` 177; the two zoraMint exports 125, 154; `ResolvedCatalog` (type) 72, 114; every core export at 13–21 (used 116–188). |
| 24–42 | Header | Keep | The two-pass design and the failure contract; the closing sentence (correctness never depends on freshness) is the justification for the hourly cadence. |
| 44–52 | Chunk constants | Keep (F5) | Sizes are derived: 256 bytes per `Call3` element → ≈ 51 KB calldata and ≈ 58 KB return data at 200; pass 2 is bounded by the `uri` string per row, the same reason the feeds cap that read at 80/240. |
| 54–58 | `chunk` | Keep | Four lines, no dependency worth adding. |
| 60–69 | `chainNow` | Keep | Same clock `fetchEligibleTokens` uses; the wall-clock fallback is acceptable here because the click-time re-check is authoritative — the comment says exactly that. |
| 71–76 | `candidatesFromCatalog` head, hidden skip | Keep | Exported so a verifier can drive it with a synthetic catalog without Redis. 76: hidden rows never enter the pool. |
| 77–80 | Patron re-check | Keep | Redundant with `resolveCatalog` today, and kept on purpose: a swept pass would be credited as a purchase in the validity ledger, so the product rule is pinned at the consumer as well; the comment now says so. |
| 81–85 | Address validation | Keep (F1) | See F1. |
| 86–90 | Token id | Keep | Decimal check, then BigInt canonicalization so the key matches `/api/collect` and the hide sets ("007" and "7" collapse). |
| 91–93 | Dedup | Keep | The census dedups by raw `token_id`; canonicalization above can merge two rows, so a second dedup is required here. |
| 94–105 | Candidate | Keep | 98 lowercases `artist` because the fold's values come from a cache whose case is not guaranteed; 101 prefers the KV-pinned `createdAt` (the feed's moves on every reindex-on-edit); 102–104 carry preview fields only when present. |
| 110–117 | `rebuildSweepIndex` head | Keep | One client, one candidate list, one chain-time read per build. |
| 119–143 | Pass 1 | Keep | 121: sequential chunks keep RPC load flat. 124–131: `sale(collection, id)` on the FPSS target; the `as Address` cast is sound because 85 validated the string. 133–142: per-row decode; a decode failure skips the row; only live+paid rows enter `sales`. |
| 144 | `survivors` | Keep | Pass 2 reads only what pass 1 admitted. |
| 146–176 | Pass 2 | Keep | Same shape against each token's own collection; a reverting or malformed row leaves no entry, which `buildSweepItem` treats as open — the shared rule. |
| 177–180 | Fees | Keep | One aggregate for all surviving collections; the set dedups. |
| 182–188 | Items, finalize | Keep | 185 passes `supply.get(key) ?? null` so "no entry" is the documented null. 188 ranks and cuts with no options — the §8 decision expressed in code. |
| 189–192 | Persist | Keep | A throw reaches the cron's own catch (`sync-stats/route.ts:96–99`), which records the phase error; a swallowed write would serve a stale pool silently. |
| 195–206 | `getSweepIndex` | Keep | Mirrors `getCatalogCensus`; the shape guard (202) rejects a truncated or foreign value instead of letting the route iterate garbage. |
| 208–217 | Flag read | Keep | 213–215: `isFlagSet` normalization (the number-versus-string trap). 217: 60 s memo; a rejection is never cached, which is what lets the public route fail closed on a blip. |
| 219–223 | `setSweepEnabled` | Keep | Mirrors the kill-switch route's `'1'`/DEL and invalidates own-pod immediately. |

## 4. `lib/saleConfig.ts` — modified (changed lines only)

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–10 | viem import | Keep | Each new import is used: `decodeFunctionResult` 744, `encodeFunctionData` 735, `multicall3Abi` 712, `Hex` 707–708. |
| 12–22 | zoraMint import | Keep | `MAX_REASONABLE_MINT_FEE_WEI` 752, `MULTICALL3_ADDRESS` 711, `ZORA_1155_MINT_FEE_ABI` 735/745 (line 15, `MULTICALL3_BALANCE_ABI`, is the client phase's: §18). |
| 128–148 | `OnchainSaleWindow`, `classifyOnchainSaleWindow` | Keep | Extracted from the three `continue`s `fetchEligibleTokens` had (now line 246) in their original order (unset, ended, scheduled); the docblock records why ended precedes scheduled. Pinned at verifier 137–143. |
| 150–164 | `classifyTokenSupply` | Keep | The removed block tested `isOpenEdition` then `totalMinted >= maxSupply`; identical outcomes, now also returning `remaining` for capped rows. Pinned at verifier 148–158. |
| 246 | Window call in `fetchEligibleTokens` | Keep | Behavior-identical: a row is skipped iff it is not live. |
| 261–267 | Supply call in `fetchEligibleTokens` | Keep | Behavior-identical: `continue` on an exhausted capped edition; `remainingSupply` only for capped rows (`undefined` for open or unreadable). `const` because nothing reassigns it. |
| 690–716 | `aggregate3Strict` | Keep | 709: an empty batch short-circuits (a pointless round trip otherwise). 710–715: `readContract` on Multicall3 `aggregate3` with `allowFailure: true` per sub-call — per-row reverts return `success: false`, an RPC failure throws. The docblock's claim about viem's `multicall` was checked against `viem/actions/public/multicall.ts`: a rejected chunk is appended as per-call failures when `allowFailure` is true. |
| 718–756 | `readMintFeesWithBound` | Keep | 733: lowercased dedup so the map's keys match the index's addresses. 735: one calldata for all targets (`mintFee()` takes no arguments). 740–754: a call to an address without code returns success with empty data, which the decode rejects, so such a "collection" is dropped — fail-closed. 752 applies the exported bound, not a copy. |

## 5. `lib/catalogCensus.ts` — modified (changed lines only)

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 4 | `type MomentMeta` import | Keep | Types the field at 213. |
| 193–222 | `ResolvedCatalogItem`, `ResolvedCatalog` | Keep | Every field is consumed by the sweep builder (`lib/sweepIndex.ts:72–105`) or by `censusFromCatalog` (342–370). |
| 224–242 | `rebuildCatalogCensus` | Keep | Lock, skip, release unchanged; only the return type widens to carry the catalog to the cron. |
| 244–249 | `resolveCatalog` head | Keep | The walk half, named for what it does; the docblock states the abort contract consumers rely on. |
| 279, 287, 301 | `items` → `raw` | Keep | `items` now names the resolved array (325); one name for two arrays in one function would invite the wrong one. |
| 306–318 | `resolved` | Keep | Same creator precedence (309–312) and the same three-filter hidden verdict (313–316) as the removed loop; the facts are returned per item instead of folded into counters immediately. `?? null` (312) makes absence explicit for consumers. |
| 320–328 | Fold | Keep | 323 is the set the removed code built from `creators`; 327 applies the fold per item so one map serves both the census counts and the sweep's per-artist identity. |
| 330–338 | Return | Keep | The three walk statistics move unchanged. |
| 341–370 | `censusFromCatalog` | Keep | Reproduces the removed `fold(uniqueCreators)` and `fold(visibleCreators)` sizes exactly: `artists` is the set of folded creators over attributed items; `visibleArtists` the same over non-hidden items; `hidden` and `unattributed` count the same predicates. Pure and exported for a future verifier. |
| 372–399 | `runCensus` | Keep | Same order as before — compute, shrink guard, persist — and returns both halves. |

## 6. `lib/zoraMint.ts`, `lib/redis.ts`, `lib/statsHealth.ts`

| File:lines | Unit | Verdict | Why |
|---|---|---|---|
| `zoraMint.ts:66–71` | `ZORA_1155_MINT_FEE_ABI` | Keep (F6) | A second, `mintFee()`-only ABI so the payable `mint()` stays unexported; the comment now says why. |
| `zoraMint.ts:224–226` | Export of the bound | Keep | The batched reader must enforce this constant, not a duplicate; the comment says so. |
| `redis.ts:99–105` | `SWEEP_INDEX_KEY` | Keep | The comment carries the two facts a reader needs: the blob shape it copies and the abort-don't-overwrite ordering. |
| `redis.ts:106–111` | `SWEEP_ENABLED_KEY` | Keep | Names the flag convention it follows and the `isFlagSet` trap in one place, next to the key. |
| `statsHealth.ts:3–4` | Header | Keep (F7) | Now lists the third phase in one flowing sentence. |
| `statsHealth.ts:14` | `StatsPhase` | Keep | The union is the type the cron and the reader share; one new member. |
| `statsHealth.ts:86` | Docblock | Keep | "both phases" would now be false. |
| `statsHealth.ts:98–103` | Three reads | Keep | The `Record<StatsPhase, …>` return type requires the third key; reads stay parallel. |

## 7. `app/api/cron/sync-stats/route.ts` — modified

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 5 | Import | Keep | Used at 89. |
| 67–68 | Comment | Keep | Tells the reader where the third phase lives before they look for it. |
| 72–73, 77 | `result` | Keep | The census now returns an object; `'skipped' in result` and `result.census` are the minimal adaptation. |
| 79–86 | Comment | Keep | Records the three decisions a maintainer would otherwise re-derive: same walk, abort inheritance, own health phase, runs while the flag is off. |
| 87–99 | Sweep phase | Keep | Own try/catch so an RPC blip records as `sweep-index` and not as a census failure; the log carries the two numbers an operator needs (`eligible`, `pool`); the error message is bounded by `recordStatsRun`. |

## 8. `app/api/sweep/route.ts` — new, 111 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–16 | Imports | Keep | All used: `NextRequest`/`NextResponse` throughout; `Moment` 87; rate limit 39; `errorResponse` 40; the three hide sets 71–73; enrichment 89; index + flag 48, 56; `SWEEP_MAX_N` 59/108, `clampSweepN` 42, `selectSweepItems` 81, `sweepItemToMoment` 89, `SweepResponseItem` 93. |
| 18 | `runtime` | Keep | Consistent with sibling routes that touch Redis and viem. |
| 20–30 | Comment | Keep | The viewer-independence decision is the reason this response may be edge-cached; a reader changing the cache header needs it. |
| 31–36 | Cache constants | Keep (F4) | Three distinct policies for three distinct answers: pool (30 s + SWR), disabled (30 s, no SWR), failure (never). |
| (was 38–41) | `SweepResponseItem` | Moved | The two enrichment overlays are the only fields added to the index item; the type now lives in the pure core (`lib/sweepIndexCore.ts:231–238`, §18) so the client parses exactly what the route emits. |
| 38–42 | Rate limit, `n` | Keep | Same budget as `agent-discover`; `n` is clamped before any work. |
| 44–51 | Flag read | Keep | Fail closed and uncached on a blip (comment 44–45); a cached "off" would pin the feature dark for the window. |
| 52–54 | Flag off | Keep | Cached without SWR (F4). |
| 56–62 | No index | Keep | An honest empty pool with the same shape as a full one, cacheable — a client needs no special case. |
| 64–80 | Hide sets | Keep | The sets throw on a Redis failure by design (strictRead); serving the pool unfiltered would reveal hidden work, so the failure is a 503 and never cached. |
| 81 | Selection | Keep | The serve-time rules live in the core (pure, verified). |
| 83–92 | Enrichment | Keep | Display-only, so a failure degrades to bare addresses rather than a 5xx; the comment records why that leaks nothing. |
| 93–105 | Response items | Keep | Index by position is sound because enrichment returns `moments.map(...)` (same length, same order). The overlay fields are null when absent so the client never reads `undefined`. |
| 107–110 | Response | Keep | Carries `maxN` and `n` so the client can render the size toggle from the server's own limits. |

## 9. `app/api/admin/sweep/route.ts` — new, 68 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–8 | Imports, runtime | Keep | All used: admin session 21/51; rate limit 18/48; `errorResponse` 19/22/33/49/52/58/60; audit 63; the three index functions 31/35/62. |
| 10–16 | Docblock | Keep | Names the precedent (`scout-killswitch`) and the operator use of GET. |
| 17–22 | GET guard | Keep | Rate limit then admin session, the sibling routes' order. |
| 24–34 | Flag read | Keep (F3) | 503 on unreadable; the comment records the memo caveat and what `index: null` therefore means. |
| 35–45 | GET body | Keep | `eligible` and `pool` are the two numbers the rollout procedure checks before enabling; `private, no-store` as on every admin read. |
| 47–52 | POST guard | Keep | Tighter budget (20/min) than GET, as the kill-switch route does. |
| 54–60 | Body validation | Keep | Rejects non-JSON and non-boolean explicitly so a typo cannot flip the flag. |
| 62–67 | Write + audit | Keep | The write invalidates the memo; the audit entry carries the actor and the new value. |

## 10. `app/api/admin/stats-health/route.ts` — modified

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 8 | Import | Keep | Used at 32. |
| 28–33 | Fourth read | Keep | Parallel with the existing three. |
| 46 | `sweepAge` | Keep | Feeds both the verdict (59) and the snapshot (75). |
| 54–59 | `sweepHealthy` | Keep | Separate verdict so a monitor on `healthy` neither pages for a sweep-only failure nor goes quiet about the pipeline; the comment states both directions. |
| 68–69 | Phase + verdict | Keep | Same `phase(...)` projection as the other two phases. |
| 73–78 | Snapshot | Keep | `eligible` and `pool` are the operator's enable criteria; `ageMs` mirrors the other snapshots. |

## 11. `package.json`

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 21 | `verify:sweep` | Keep | Same invocation shape as its siblings (alias loader, strip-types, warning suppression). |
| 33 | `check` | Keep | Placed after `verify:sale-index` so the sale-config oracles run together; CI runs `check`. |

## 12. `scripts/verify-sweep.ts` — new, 381 lines (index half; the client half is §19)

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–26 | Header | Keep | Lists what the oracle guards and how to run it, the convention every sibling verifier follows (20–25, the client-half bullet, is §19's). |
| 28–46 | Imports | Keep | Every import is exercised below; relative `.ts` paths are what the strip-types runner resolves (47–59 are §19's). |
| 61–68 | `check` | Keep | The repo's pass/fail harness shape; a failing check is visible and counted. |
| 70–77 | Constants | Keep | `NOW` fixed so window tests are deterministic; `FEE` is Zora's real fee; `COL_A` is mixed-case on purpose (175, 293, 320 depend on it). |
| 79–117 | Factories | Keep | `sale`, `cand`, `rk`, `idx` make each assertion one line; each default is the common case so tests state only what differs. |
| 118–133 | PRNG, `shuffle`, `keys` | Keep | Deterministic randomness so a property failure reproduces; `shuffle` is what proves order-independence (202, 213, 246). |
| 135–143 | Window rule (7 checks) | Keep | Covers every branch of `classifyOnchainSaleWindow` plus the sentinel and the malformed row; each can fail if a comparison flips. |
| 145–159 | Supply rule (6 checks) | Keep | Null, both open forms, room, exhausted, over-minted — every branch of `classifyTokenSupply`. |
| 161–188 | Admission (20 checks) | Keep | Each drop reason once (171–173) and each carried field once (175–182); 185–187 pin the absent-key rule and null passthrough. |
| 190–236 | Ranking (16 checks) | Keep | Cross-tier order (194); the farming scenario (203–205); artist order by newest (209); singleton nulls (214); unknown dates last (219); the cap's three properties (226–228); invalid caps (230–232); floor (234); no-option identity (235). |
| 237–268 | Property sweep (5 checks) | Keep | 300 random items: monotone outlay, permutation preserved, determinism, the farming property over every tier, and the cap bound. These are the assertions that catch a regression the hand-written cases miss. |
| 270–280 | Pool cut (4 checks) | Keep | Input is cheapest-last so the cut demonstrably ranks before it cuts. |
| 281–302 | Serve selection (8 checks) | Keep (F2 at 300) | Prefix sizes for 10 and 20, order preservation, and each of the four hide filters including the case-insensitive key. |
| 303–307 | `clampSweepN` (5 checks) | Keep | Absent, garbage, floor, ceiling, in-range. |
| 309–320 | Projection + constants (6 checks) | Keep | The three projection facts the route relies on, the cap identity, the pool multiple, the key normalization. |
| 380–381 | Exit | Keep | Non-zero exit is what makes `npm run check` fail. |

---

## 13. `lib/sweepBatch.ts` — new, 125 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–3 | Imports | Keep | `encodeFunctionData` 55; `Address`/`Hex` in the types; `DEFAULT_COLLECT_COMMENT` as the comment default (44); the two zoraMint builders 47/70/81 — every mint encoding goes through `buildEthMintCall`, which is the treasury rule. |
| 5–9 | Header | Keep | States the property the verifier relies on: no network, so the invariants are pinned without an RPC. |
| 11–24 | `SweepBasketItem`, `SweepCall` | Keep | The four inputs a mint needs and the three outputs a call carries; nothing from the index rides along, so a stale index value can never reach calldata. |
| 26–33 | `SWEEP_GAS_HEADROOM_WEI` | Keep | The constant the balance trim reserves before simulation (the node rejects an `eth_call` whose `value` the sender cannot cover — verified in go-ethereum's `buyGas`). Pinned at verifier 377. |
| 35–57 | `buildSweepCalls` | Keep | 47–54: `buildEthMintCall` with quantity 1 and the live price and fee; 55: encoded once, `to` is the item's own collection (cross-collection is the point). Pinned 331–344: decoded back to `mint(FPSS, id, 1, [KISMET_REFERRAL], (mintTo, comment))`, value = price + fee. |
| 59–61 | `sweepTotalValue` | Keep | Used by the verifier to assert the bundle's `msg.value` equals the sum (350); the hook sums rows instead because its rows carry the outlay. |
| 63–71 | `sweepBundle` | Keep | The strict bundle is `buildMulticall3Batch` unchanged; the wrapper exists so the docblock can carry the stranding warning next to the one call site that could loosen it. Pinned 347–350. |
| 73–88 | `sweepSimulationArgs` | Keep | Derived from the strict bundle (81) and only `allowFailure` flipped (85), so targets, calldata and values can never disagree between what is simulated and what is signed. Pinned 352–355. |
| 90–109 | `trimToBudget` | Keep | A cheapest-first prefix (92–93 explain why a prefix is the right subset and why tail drops cannot invalidate earlier sub-calls). 104 breaks on the first overflow; 108 returns the rest as dropped. Pinned 363–370, including the "never skips a cheaper item" property. |
| 111–125 | `applySimulation` | Keep | Position mapping (120–123); a length mismatch drops everything (117) because an unattributed slot must never be signed. Pinned 372–376. |

## 14. `lib/sweepSimulate.ts` — new, 78 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–4 | Imports | Keep | `PublicClient`/`Address` types; `walkError` (41) is the repo's depth-capped error-chain walker; `MULTICALL3_ADDRESS` 27/65; the two builders 25/62. |
| 6–8 | Header | Keep | The one fact a reader must know: both calls are read-only, so failure costs nothing. |
| 10 | `SweepSimulation` | Keep | Three outcomes the hook branches on (per-slot flags, insufficient funds, other). |
| 12–38 | `simulateSweep` | Keep | 23: an empty basket needs no call. 26–33: `simulateContract` on the allowFailure=true args with `value` and `account` — the exact bundle, not a stand-in. 34: per-slot `success`. 35–36: the error is classified so the hook can shed rows on insufficient funds instead of failing the sheet. |
| 40–47 | `isInsufficientFunds` | Keep | Matches viem's `InsufficientFundsError` by name and the node's message text through the wrapped chain; either alone misses one of the two shapes wagmi/viem produce. |
| 49–78 | `estimateSweepGasCost` | Keep | 60: zero for an empty basket. 62–73: gas on the STRICT bundle (what is signed) times `maxFeePerGas`, in parallel. 74: wei. 75–77: null on failure so the caller falls back to the headroom rather than trusting a number it does not have. |

## 15. `hooks/useSweep.ts` — new, 507 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–34 | Imports | Keep | Each is used: react hooks; wagmi `useConfig`/`usePublicClient`/`useWriteContract` (298–300); `getAccount` (416, 429); `base` (266, 299, 429, 438, 453); `toast` (344, 356, 382, 412, 418, 424, 461, 468, 475); viem types; `isAddress`/`isValidTokenId` (107); `useEnsureBase` (301), `useEnsureConnected` (302), `useWalletRecovery` (303); `BUILDER_DATA_SUFFIX` (448, 456); `trackFunnel` (334, 422, 476); `reportClientError` (288); `DEFAULT_COLLECT_COMMENT` (269, 446); the two chain reads (145, 152); `rankSweepCandidates` (184); the core constant, key and types (20–24); `MULTICALL3_ADDRESS`/`buildEthMintCall` (454, 440); the batch helpers (27–33); the simulation pair (214, 246). |
| 36–47 | Header | Keep | The state machine and the sentence that governs the whole file: everything that costs money is decided from live chain state, never from the index. |
| 49–80 | Types | Keep | Every status is rendered by the sheet's `buttonLabel` (SweepSheet 22–45); every row state is either rendered (`Row` 74–107) or filtered (`reserve`, sheet 135). `priceWei`/`feeWei`/`outlayWei` are the live values the calls are built from (118–123). |
| 82–100 | `UseSweepReturn` | Keep | Each field is consumed by the sheet (113) except `gasCostWei` and `updatedAt`, which the design's footnotes name for the next UI pass; they cost two fields and no reads. |
| 102–105 | Constants | Keep | Toast id shared with the recovery flow; the simulation cap the design fixes at "initial + two refills"; the same record retry count `useDirectCollect` uses. |
| 107–125 | Helpers | Keep | 107: the pool row is re-validated at the trust boundary even though the server validated it. 109–116: pending rows carry zeros until verified. 118–123: rows → basket items with the live values only. 125: the basket sum. |
| 127–129 | `Verified` | Keep | The two outcomes `open` branches on; an RPC failure is its own shape so it can never be mistaken for an empty basket. |
| 131–260 | `verifyBasket` | Keep (C2–C4) | 143: empty page = nothing to sweep. 145–148: one aggregate3 for price/supply/ownership/balance; a null balance is the aggregate failing, reported as "could not verify" (never "nothing eligible"). 150–158: live fees, RPC failure reported the same way. 160–181: each pool row is re-decided from the live read with a reason the sheet shows; 169–174 re-applies the paid rule so a price edited to zero since the build cannot slip in. 183–196: re-rank on live outlay with the index's rule. 198–206: budget trim before simulation, because the node rejects an `eth_call` the sender cannot fund. 208–241: simulate → drop → refill → re-simulate, bounded (212, 231), refills only from cheaper-than-room reserve rows (234), and — C3 — a non-empty basket is always one that passed a simulation. 243–250: gas refinement, C4. 252–259: rows assembled in display order with reasons. |
| 262–295 | `recordOne` | Keep | The `/api/collect` body the record endpoint verifies (collection, canonical tokenId, chainId, the bare price, the shared tx hash); bounded backoff because the server 403s until its own RPC sees the receipt (`useDirectCollect` precedent); `keepalive` so a navigation cannot drop it; the diagnostics sink on total loss because the mint has already landed. |
| 297–324 | Hook state | Keep | 298–303: the wagmi/recovery hooks. 305–310: six pieces of state, each rendered or returned. 312–318: rows are mirrored into a ref so `confirm` reads the latest removal, not a stale closure. 319–320: the double-tap latch. 321–323: the open sequence that discards a superseded verification (size toggle, "sweep the next N"). 324: the ref the recovery retry calls. |
| 326–390 | `open` | Keep | 328: sequence stamp. 329–334: reset, then the funnel event. 336–341: connect on demand (host wallet in a Mini App, modal on web); a declined connect is `idle`, not an error. 342–346: no public client is an error, not a silent empty. 348–363: the pool fetch, cached at the edge; disabled or empty is `empty`. 364–367: rows appear immediately as pending (the sheet opens instantly). 369–376: chain switch through the recovery toast. 378–387: verification. Every await is followed by a sequence re-check (337, 354, 359, 372, 379) so a stale result never overwrites a newer open. |
| 392–404 | `remove`, `restore` | Keep | Toggle a basket row out and back; only those two states transition, so a dropped row cannot be "restored" into the bundle. |
| 406–488 | `confirm` | Keep | 407: the recovery flag is consumed first (the hook contract). 408–420: latch, basket, client, authoritative signer (the wagmi store, so a wallet connected in this same tap counts). 421–424: latch set, funnel event, status, toast. 427–431: chain switch and the wagmi-store chain guard right before the send. 432–458: one item → direct `1155.mint` (keeps `Purchased.sender` = user); more → the strict Multicall3 bundle; both with the builder-code suffix. 460–465: receipt with the same 300 s bound as collect-all; a revert throws (nothing was charged). 467–469: records in parallel with bounded retry. 471–478: rows → swept, result, success toast, funnel, recovery ack. 479–487: the recovery toast with a retry that re-enters `confirm`; the latch is released in `finally`. |
| 490–507 | Return | Keep | `totalWei` and `unaffordable` are derived from rows on every render so the sheet never holds a second copy. |

## 16. `components/SweepSheet.tsx` — new, 244 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–13 | Imports | Keep | `useEffect`/`useRef` (115, 122–126); `X` (95, 188); `formatEther` (136); the three modal hooks (116–118); `useEthUsd` (114); the hook and its types; `MomentImage` (66); `formatPrice`/`shortAddress` (41, 60, 82, 224); the two size constants (20). |
| 15–18 | Header | Keep | Names the sheet's job: the trust surface, everything visible before the prompt. |
| 20 | `SIZES` | Keep | 10 and 20 from the shared constants, never literals. |
| 22–45 | `buttonLabel` | Keep | One place maps every status to the primary button's text; `ready` with an empty basket is spelled out separately from `empty`. |
| 47–110 | `Row` | Keep | 59–60: name falls back to the token id, artist to the enriched username then the short address. 61: dimmed states. 64–68: 40 px thumbnail through the same image component the feeds use, with the thumbhash placeholder. 73–86: the right column says exactly one thing per state — verifying, the reason, swept, or price + fee. 87–107: remove (44 px target, labelled) and undo, both disabled while busy. |
| 112–126 | Setup | Keep | Modal behaviors (116–118) in the `PatronInfoModal` pattern plus the focus trap. 120–126: open once on mount through a ref so wallet-state re-renders (which re-create `open`) cannot re-fetch. |
| 128–138 | Derived values | Keep | `busy` gates every control; reserve rows are hidden (135); the USD label only when a rate and a total exist (136); the button is disabled exactly when a tap could do nothing (138). |
| 140–143 | `onPrimary` | Keep | `ready` confirms; `error`/`done`/`idle` re-open (re-verify) — a retry after an on-chain revert must re-verify, not resend. |
| 145–157 | Dialog shell | Keep | Backdrop closes, card stops propagation; `role`/`aria-modal`/`aria-label` for the trap; `bg-black/80` and `bg-surface` as the sibling modal uses. |
| 158–191 | Header row | Keep | Title, subtitle, the size toggle (`aria-pressed`, disabled while busy, no-op on the current size), and a 44 px close. |
| 193–205 | Rows | Keep | Scroll-bounded list; the empty message names the actual state (loading / error / nothing). |
| 207–240 | Footer | Keep (C5) | `aria-live` totals (done → count + Basescan link; else count and, when non-zero, the total with USD); the primary button; the footnote with the unaffordable count. |

## 17. `components/SweepButton.tsx` — new, 44 lines

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 1–6 | Imports | Keep | `useState` (22); `dynamic` (13); `useQuery` (23); the response type (15, 18). |
| 8–11 | Header | Keep | The only behavior worth stating: nothing renders unless the pool is enabled and non-empty. |
| 13 | Lazy sheet | Keep | The sheet (hook, wagmi writes, image component) loads only when opened, so `/discover`'s initial JS carries only the button. |
| 15–19 | `fetchSweepAvailability` | Keep | A non-OK answer is "disabled", never an exception into the header. |
| 21–44 | Component | Keep | `staleTime` matches the endpoint's cache plus the flag memo (26–28); the discriminated-union check (30) is what lets TypeScript admit `items`; the button's classes are the header's own `stats` button with the accent border; the sheet mounts only while open. |

## 18. `components/DiscoverMarketView.tsx`, `lib/funnel.ts`, `app/api/sweep/route.ts`, `lib/sweepIndexCore.ts`, `lib/saleConfig.ts`

| File:lines | Unit | Verdict | Why |
|---|---|---|---|
| `DiscoverMarketView.tsx:15` | Import | Keep | Used at 795. |
| `DiscoverMarketView.tsx:793–795` | Mount | Keep | Between the market toggle and the stats block in the sticky header's top row — the one placement the decision names; the comment says when it renders nothing. |
| `funnel.ts` (+3 events, +4 comment lines, 1 reworded) | Events | Keep | The three events the hook fires (334, 422, 476); `app/api/funnel` and `lib/funnelServer` derive their allowlist and read set from this array, so nothing else changes. The header's "seven named events" was already false (the array held ten; it now holds thirteen) and is now a count-free sentence. |
| `app/api/sweep/route.ts` (−6/+1) | Shared type | Keep | The response item type moved to the pure core so the client and the route cannot drift. |
| `sweepIndexCore.ts:231–253` | `SweepResponseItem`, `SweepApiResponse` | Keep | The two shapes the client parses; a discriminated union so a disabled answer carries no items to misread. |
| `saleConfig.ts:15` | Import | Keep | `MULTICALL3_BALANCE_ABI` used at 840/909. |
| `saleConfig.ts:758–772` | Types | Keep | `EligibleTokenMulti` extends the existing `EligibleToken` (same per-row fields) plus the collection, so the sibling functions stay interchangeable; `ethBalance: null` is the documented "could not verify" signal. |
| `saleConfig.ts:774–918` | `fetchEligibleTokensMulti` | Keep | 801: empty refs short-circuit. 803–808: chain time as `fetchEligibleTokens`. 811–844: three slots per ref plus the balance slot, all through `aggregate3Strict` — one `eth_call` on the browser client (viem's `shouldPerformMulticall` returns false for aggregate3 calldata; verified in `actions/public/call.ts`). 846–851: RPC failure → no items AND null balance. 854–902: the same per-row rules as `fetchEligibleTokens`, in the same order, with the shared classifiers (865, 880) and the fail-closed balance rule (884); the owned skip defaults to 1 ("one of each"). 904–917: the trailing balance. |

## 19. `scripts/verify-sweep.ts` — client-half additions

| Lines | Unit | Verdict | Why |
|---|---|---|---|
| 20–25 | Header | Keep | Names what the new section guards. |
| 47–59 | Imports | Keep | The batch helpers under test, the comment default, the FPSS / referral / mint ABI from the shared verifier helpers (sourced from production constants, not hand-copied), and viem's decoders. |
| 322–357 | Bundle oracles (17 checks) | Keep | Every signed sub-call is decoded back to `mint` with the FPSS minter, the token id, quantity 1, the treasury referral, and `(mintTo, comment)` minter arguments (331–343); the sum (344); the strict bundle's function, `allowFailure === false` on every entry, alignment and `msg.value` (346–350); the simulated bundle's `allowFailure === true` with identical targets, calldata, values, `msg.value` and function (352–355); the empty basket (356). |
| 359–378 | Trim / simulation / headroom (10 checks) | Keep | Exact fit, partial prefix, zero and negative budgets, empty input, the prefix property (363–370); position mapping, the fail-closed mismatch, empty input (372–376); the headroom constant (377). |
