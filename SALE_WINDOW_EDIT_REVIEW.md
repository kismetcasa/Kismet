# Editing Moment Sale Windows — Upstream Review & Integration Design

**Date:** 2026-07-30
**Status:** IMPLEMENTED (v1, window edits only) — §3 shipped as designed. The build:
`lib/saleEdit.ts` (pure read/merge/encode core) + `hooks/useUpdateMomentSale.ts` (direct
user-signed `callSale`) + `useMomentSaleEditPermission` (ADMIN|SALES gate,
`lib/permissions.ts`) + the inline sale editor in `components/MomentDetailView.tsx` +
`app/api/moment/sale-refresh/route.ts` (chain-read re-sync of the Redis sale indexes) +
`scripts/verify-sale-edit.ts` (pins the §3.1/§3.3 invariants; wired into `npm run check`).
Price / per-address cap / fundsRecipient edits stay out of scope per §3.5.
**Question answered:** In Process can now edit a moment's sale after mint. How exactly do
they do it, and how should Kismet support the same?

Sources read first-hand (the docs site is a rendered mirror of these repos):

| Repo | What it is | State reviewed |
|---|---|---|
| `sweetmantech/in-process-api` | The deployed `api.inprocess.world` implementation | `8bcaca9`, 2026-07-29 (HEAD) |
| `sweetmantech/docs` | Source of docs.inprocess.world (Mintlify, incl. `openapi.json`) | `4fe547d`, 2026-07-29 (HEAD) |
| `sweetmantech/docs-in-process` | The OLD vocs docs cited in `lib/collections.ts:5` | stale — last commit 2026-01-14 |

---

## 1. What In Process actually shipped

### 1.1 It is NOT the PATCH /moment endpoint

`PATCH /moment` ("Update Moment URI" — the page that prompted this review) updates **only**
`newUri` and optionally `newCollectionAddress`. Its request schema carries no sale fields.
Sale editing is a **separate endpoint**, live since **2026-02-19**
(in-process-api commit `3255a23`, "feature: set sale api") and now documented as **"Set Sale"**:

```
POST https://api.inprocess.world/api/moment/sale        (operationId: setMomentSale)
x-api-key: <artist API key>
{
  "moment": { "collectionAddress": "0x…", "tokenId": "1", "chainId": 8453 },
  "pricePerToken":        "1000000000000000",   // optional, base-units integer STRING
  "saleStart":            1717200000,           // optional, unix seconds, JSON NUMBER
  "saleEnd":              1719999999,           // optional, unix seconds, JSON NUMBER
  "maxTokensPerAddress":  0,                    // optional, 0 = unlimited
  "fundsRecipient":       "0x…"                 // optional
}
→ 200 { "hash": "0x…", "chainId": 8453 }        // returned AFTER the tx is mined
```

There is no GET twin: `getSaleHandler.ts` / `validateSaleQuery.ts` exist in their tree but are
mounted on no route — sale reads still come from `GET /moment` (or chain).

### 1.2 How the update executes (their `updateSaleHandler`)

1. **Read the live on-chain sale row** for the moment via multicall — ERC20Minter first; if its
   `saleEnd > 0` the sale is `erc20Mint`, otherwise the FixedPriceSaleStrategy row is used.
2. **Merge**: provided fields override, everything else (including `maxTokensPerAddress`,
   `fundsRecipient`, and `currency` for USDC sales) is carried over from chain. The strategy
   itself can never be switched by this endpoint — it writes back to whichever minter currently
   holds the sale.
3. **Relay**: encode `Zora1155.callSale(tokenId, strategy, setSale(tokenId, merged))` and send it
   as a **paymaster-sponsored CDP user operation** from the artist's smart wallet.
   `sendUserOperation` **waits for the receipt** (≤60 s), so a 200 means the new window is
   already live on-chain.
4. **No DB write**. Unlike `updateMomentURI` (which calls `indexMoment` in-band), the sale
   handler touches nothing in their Supabase mirror.

### 1.3 How their own reads catch up (matters for our caching)

Their `in_process_sales` table is fed exclusively from an **Envio on-chain indexer**
(`Primary_Sales` entity = the strategies' `SaleSet` events) drained by a **Vercel cron running
every minute** (`/api/indexer/run`, upsert `onConflict: 'moment'` — one row per moment,
overwritten on every SaleSet). Two consequences:

- After any sale change, upstream `GET /moment` / timeline serve the **stale row for ~1–2 min**
  (their moment resolver prefers the DB row and only falls back to chain when no row exists).
- The ingest is **sender-agnostic**: a `callSale` submitted directly from the artist's own wallet
  lands in their DB exactly like one relayed through their API. Their API path confers **zero
  data-consistency advantage** for sale edits.

### 1.4 Authorization — deliberately stricter than update-uri

`POST /moment/sale` passes three gates; `PATCH /moment` passes only the third:

1. Moment must exist in their `in_process_moments` mirror.
2. **DB admin gate (new):** `in_process_admins` must contain a row for
   `(collection, tokenId)` or `(collection, 0)` with `artist_address` = the **primary wallet of
   the account owning the API key**. That table is indexed from raw on-chain
   `UpdatedPermissions` holders.
3. **Operational wallet gate:** iterate the key-owner's linked wallets, derive each wallet's CDP
   smart account, use the first that holds on-chain **ADMIN (bit 2) at tokenId 0**; throw if none.
   (On-chain, `callSale` itself is `onlyAdminOrRole(tokenId, PERMISSION_BIT_SALES = 8)` —
   ADMIN **or** SALES, token-level or collection-wide.)

Their unit tests (`validateUpdateSaleBody.test.ts`) pin gate 2 explicitly — 403 when
`selectAdmins` returns empty for the caller's primary wallet.

### 1.5 Upstream quirks to know about (all verified in their code)

| # | Quirk | Consequence |
|---|---|---|
| 1 | The "at least one field" check uses truthiness for `pricePerToken \|\| saleStart \|\| saleEnd` (only `maxTokensPerAddress` gets `!== undefined`) | `{saleStart: 0}` alone or `{saleEnd: 0}` alone → 400. Workaround: always send the full window. |
| 2 | `saleStart`/`saleEnd` are `z.number()` on **update** but `bigIntString` on **create** | The documented open-ended sentinel `18446744073709551615` (maxUint64 — what Kismet writes at mint) **cannot round-trip JSON**: it parses to 2^64, `BigInt(2^64)` overflows uint64, viem's encode throws → 500. **"Never expires" is inexpressible via their API today.** Any large-but-representable stand-in (e.g. 2^53) would render in Kismet as a real "Sale ends year 285,616" deadline, because `parseRealSaleEnd` (lib/inprocess.ts:363) only treats ≥ maxUint64 as open-ended. |
| 3 | When a moment has **no** sale row at all, the merge base is all-zeros fixedPrice | An update against a sale-less token would write `fundsRecipient = 0x0` unless explicitly provided. |
| 4 | Their DB stores `price_per_token` as a JS `Number` | Wei prices with >15–16 significant digits can drift in *their* mirror. Chain and Kismet's own reads are unaffected. |
| 5 | `GET /moment` (current deploy + docs) returns `sale` / `admins` keys with **numeric** `saleStart`/`saleEnd` | Kismet's `MomentDetail` types expect `saleConfig` / `momentAdmins` with strings — see §3.4. |

---

## 2. Can Kismet just call POST /moment/sale? Almost certainly not.

Kismet holds **one platform key** (`INPROCESS_API_KEY`). Walk the gates for a typical
Kismet-minted moment:

**Who is actually admin on-chain** (all verified in code and, per existing repo comments, on
live collections):

- The **creator's EOA** — defaultAdmin. On CreateCollectionForm deploys the deployer EOA is
  defaultAdmin (asserted post-deploy by `verifyDeployPermissions`, lib/permissions.ts:144). On
  auto-deployed collections In Process passes `account` (the creator EOA Kismet sends in the
  mint payload, components/MintForm.tsx:866) as the factory's `defaultAdmin`
  (their `protocolSdk/create`: `contract.defaultAdmin || account`).
- The **creator's per-creator In Process smart wallet** — granted ADMIN@0 in their create
  setup-actions. This is the wallet that executes the creator's mints
  (lib/resolveSmartWallet.ts:42-50: "verified on-chain … the platform OPERATOR wallet does NOT").
- **Split recipients** (and their smart wallets) — token-level ADMIN, from their splits setup.
- `OPERATOR_SMART_WALLET` (the CDP account behind our key) — **only** on
  CreateCollectionForm-deployed collections (we bake the grant into setupActions) and
  PLATFORM_COLLECTION. **Not** on auto-deployed collections (lib/config.ts:34-40).

Now the gates:

- **Gate 2** wants our key-account's *primary wallet EOA* in the indexed admin set. That EOA
  appears in none of the grants above (the operator *smart wallet* is what we grant, and only on
  some collections). Expected result: **403 Forbidden** on most or all moments.
- **Gate 3** wants a smart account derived from our key's wallets to hold ADMIN@0 — i.e. the
  operator smart wallet. Fails on every auto-deployed collection.
- Even where both pass, quirk #2 means we cannot express Kismet's open-ended convention.

And we have run this experiment before in another costume: **admin-class writes through the
relay already failed and were migrated off it** — airdrops and contract-metadata edits are now
direct user-signed transactions precisely because "the relay executes admin writes as the
operator wallet (perms=0), which empirically rejects them"
(hooks/useUpdateCollectionMetadata.ts:25-29). A sale update is the same write class
(`callSale` = admin/SALES-gated), with an *extra* DB gate on top.

> **Cheap empirical check** (worth one curl before committing to anything): POST /moment/sale
> with the production key against a Kismet test moment. Expected 403; if it surprises us and
> works, the relay option reopens for the gas-free-UX case — but quirk #2 (no open-ended) and
> the auto-deployed-collection gap still stand.

---

## 3. How Kismet should do it: direct, user-signed `callSale`

Follow the established admin-write family (useUpdateCollectionMetadata, useAirdrop,
useGrantPermission): the artist's connected wallet signs
`collection.callSale(tokenId, strategy, setSale(tokenId, newConfig))` on Base.

**Why this is the right call:**

1. **Authorization always holds.** The creator EOA is defaultAdmin on both collection origins
   (§2); token-level co-admins (split recipients) and SALES-bit holders pass the same on-chain
   gate. No dependency on which smart wallet In Process derived, no DB mirror gate.
2. **Full expressiveness.** `saleEnd` is a bigint — the exact maxUint64 sentinel round-trips,
   matching the mint-time convention (`OPEN_ENDED_SALE`, components/MintForm.tsx:725) and
   `parseRealSaleEnd`'s classifier.
3. **Upstream converges regardless of sender** (§1.3). Their Envio→cron pipeline ingests our tx
   within ~1–2 min; their API relay would be no faster.
4. **Same trust/provenance model as our other admin writes** — the artist lands as the on-chain
   updater; no platform gas quota, no platform-pause coupling, no 45–60 s relay wait (Base
   confirms in seconds).
5. Cost: one wallet confirmation + trivial Base gas — the accepted UX for airdrop / authorize /
   collection edits.

**Strategy address parity is already exact** — the two minters our reads use are byte-identical
to the ones their sale updater targets on 8453:
FPSS `0x2994762aA0E4C750c51f333C10d81961faEBE785`, ERC20Minter
`0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014` (lib/zoraMint.ts:31-32 ⇔ their
`protocolSdk/constants.ts`).

### 3.1 Write path (new hook, e.g. `useUpdateMomentSale`)

1. **Read the full live struct** from the moment's active strategy — same discrimination
   `resolveOnchainSale` uses (FPSS row wins when `saleEnd ≠ 0`, else ERC20Minter+USDC;
   lib/saleConfig.ts:315), but keep **all** fields: the `sale()` ABIs already return
   `maxTokensPerAddress`, `fundsRecipient`, `currency` (lib/saleConfig.ts:14-73).
2. **Merge only the edited fields.** Never clobber:
   - `fundsRecipient` — on split moments it is the 0xSplits SplitWallet; overwriting it
     **redirects revenue**;
   - `maxTokensPerAddress`;
   - `currency` (ERC20 path; ERC20Minter's `setSale` rejects zero currency and zero price —
     also means a USDC sale can't be edited to free on either path; re-verify Zora's exact
     checks if/when price editing ships).
3. **Encode + send**: `setSale` with the strategy-matching tuple (5-field FPSS / 6-field ERC20),
   wrapped in `callSale`, via `writeContractAsync` + `ensureBase` + `BUILDER_DATA_SUFFIX`.
   The FPSS `setSale`/`callSale` fragments already exist in lib/collections.ts:82-153 (deploy
   path) — share them, add the ERC20 variant, don't redefine.
4. **Wait for the receipt** before declaring success (useAirdrop contract).

### 3.2 Permission gate for the affordance

Mirror `useMomentEditPermission` (on-chain `permissions(tokenId, caller) | permissions(0,
caller)`) but with a **different mask**: `ADMIN | SALES` where `PERMISSION_BIT_SALES = 8`
(new constant in lib/permissions.ts — the bit table in lib/collections.ts:20 already documents
it). Note the masks genuinely differ: a METADATA-only co-admin gets the pencil but must not get
sale controls; a SALES-only holder gets sale controls but no pencil. `skip: isCreator` shortcut
applies the same way.

### 3.3 Edit-time validation (adapted from MintForm's invariants)

- Close-after-open when both edges are real.
- **Do not** carry over MintForm's 10-minute-minimum close (MintForm.tsx:743) — that guard
  protects the setup-time self-mint, which doesn't exist at edit time. "End the sale now"
  (saleEnd = now) is a legitimate action.
- A **future saleStart is safe on edit** for the same reason (the create-path restriction that
  self-mint forces saleStart=0 does not apply).
- Open-ended = the maxUint64 sentinel — hoist `OPEN_ENDED_SALE` out of MintForm into a shared
  module so mint + edit can't drift.
- **Never write saleEnd=0 to "close"** — every Kismet read treats `saleEnd == 0` as "no sale
  row" (lib/saleConfig.ts:192,333; feed classifiers), so the price/pill would vanish instead of
  showing "Ended". Use `saleEnd = now`.
- Hide the affordance when there is no readable sale row (`resolveOnchainSale` → null) and for
  sold-out capped editions (a window edit can't revive supply).

### 3.4 Propagation — what must be updated after a confirmed edit

Collect-side correctness needs **nothing**: `useDirectCollect` re-reads the chain at click time
and `fetchEligibleTokens` gates against `block.timestamp` (lib/saleConfig.ts:145-152, 192-194),
so nobody can ever mint outside the *true* window. The work is display/index freshness:

| Target | Action |
|---|---|
| Redis sale indexes `kismetart:sale-ends` / `kismetart:sale-free` | Add a small server route (e.g. `POST /api/moment/sale-refresh {collection, tokenId}`) that re-reads the sale **on-chain server-side** (`onchainSaleConfigFallback`) and calls `recordSaleEnds` — trustless (no client-supplied values, can't be abused to write fiction), idempotent, rate-limited; the client calls it after the receipt. This is the one-line fix for the Ending-Soon + free feeds. |
| Client detail state | Mirror the metadata edit: build the merged `saleConfig`, `setCachedDetail(...)` + local `setDetail` (MomentDetailView.tsx:1240-1241) — required because the client detail LRU has **no TTL** and the refetch effect early-returns on a cache hit (lib/momentCache.ts:12-24, MomentDetailView.tsx:496-497). |
| react-query price cache | `invalidateQueries({ queryKey: ['moment-sale', key] })` (hooks/useMomentSale.ts:92-99; nothing invalidates it today). |
| Other viewers / feeds | Accept bounded staleness: In Process mirror ~1–2 min + our 60 s fetch-cache on `/moment` + `/api/moments` 30 s s-maxage. Practically ≤ ~3 min. Note the upstream `sale` key rename (§1.5 #5) means our `data.saleConfig` check misses, so the on-chain fallback fires per request (app/api/moment/route.ts:68-75, lib/momentDetail.ts:84-91) — detail reads are effectively chain-fresh already. If tighter feed freshness is ever wanted, that's `next: { tags }` + `revalidateTag`, machinery the repo doesn't have today. |
| Seaport listing rows | `mintPrice`/`mintPriceCurrency` are frozen at listing time and drive the `below=1` filter (app/api/listings/route.ts:706-734, lib/listings.ts:375-377) — **not self-healing**. Sidestep in v1 by scoping to **window edits only** (no price edits); a price-edit v2 must refresh open listing rows for the token. |

Pre-existing UI gaps an edit feature will make visible (fine to ship with, worth noting):
cards/detail compute `Date.now()` at render with no ticking re-gate, so an open/close boundary
crossing while the page sits open doesn't flip the button until a re-render; and a drop
rescheduled into the future is `zrem`'d from ending-soon and re-enters only once it opens *and*
is browsed (lib/saleEnds.ts:62-63 — by design).

### 3.5 Suggested v1 scope

- Edit **saleStart / saleEnd** only (the ask): open now, schedule, extend, end now, make
  open-ended. Price / per-address cap / fundsRecipient stay read-only (avoids the listings
  desync and the ERC20 zero-price trap).
- UI: a "sale" section in the detail-view editor area, gated by the ADMIN|SALES mask (§3.2),
  reusing MintForm's datetime-local inputs + helper copy.
- A verify script pinning the pure merge/encode helper (strategy discrimination, field
  preservation, sentinel, saleEnd=now-not-zero), in the repo's verify-* tradition — the merge
  mistakes (clobbered fundsRecipient/currency) are exactly the silent-money-bug class those
  scripts exist for.

---

## 4. Open items

1. **Empirical relay probe** (§2): one authenticated POST /moment/sale against a test moment to
   confirm the expected 403 — documents the constraint, and reopens the sponsored-relay option
   if it unexpectedly passes.
2. **Upstream asks** (nice-to-have, none blocking): accept string `saleStart`/`saleEnd` on
   update like create (sentinel round-trip); align the sale endpoint's authz with update-uri's
   for platform keys; mount the already-written GET sale handler.
3. **Verify the `sale`/`admins` rename against the live API** and update `lib/inprocess.ts`'s
   wire-contract comment + `MomentDetail` consumers (`momentAdmins` fallback in
   MomentDetailView degrades silently to the other creator sources if the rename is live).
4. `lib/collections.ts:5` cites the stale docs repo — repoint to `sweetmantech/docs` /
   docs.inprocess.world when next touched.
