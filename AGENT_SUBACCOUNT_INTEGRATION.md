# Sub-account integration — corrected provider architecture (verified)

> Research outcome for wiring auto-collect into *our* wagmi/RainbowKit app.
> Verified against the **installed** `@wagmi/connectors@6.2.0` + `@base-org/account@2.4.0`
> types (docs.base.org / wagmi.sh block automated fetch; shipped types are
> authoritative). Corrects the standalone-SDK approach in `lib/agent/scout/baseAccount.ts`.

## The finding

`@wagmi/connectors` exports a first-class **`baseAccount`** connector, and:

```ts
// node_modules/@wagmi/connectors/dist/types/baseAccount.d.ts
export type BaseAccountParameters =
  Mutable<Omit<Parameters<typeof createBaseAccountSDK>[0], 'appChainIds'>>
```

So `baseAccount({ … })` accepts **the same options as `createBaseAccountSDK`** —
including **`subAccounts`** (`creation`/`defaultAccount`/`funding`/`toOwnerAccount`)
and **`paymasterUrls`** — with `appChainIds` supplied by the wagmi config's chains.

**Implication:** configure sub-accounts **on the wagmi connector**, and drive the
flow through the **wagmi-connected provider** + wagmi hooks. Do **not** spin up a
separate `createBaseAccountSDK` (as the current `baseAccount.ts` does) — in a wagmi
app that's a second, parallel session and would prompt the user to connect twice.

Corroborating facts: Base mini-apps use the **`baseAccount` + `injected`** connectors;
the Base App (post-April-2026) runs apps as **standard web apps**; the Farcaster
mini-app wallet supports EIP-5792 `wallet_sendCalls`. EOAs still cannot use
sub-accounts/spend-permissions (gating unchanged).

## The integration (apply with a smoke test)

### 1. `lib/wagmi.ts` — configure the connector (the one risky change)
Add/route Coinbase Smart Wallet through the `baseAccount` connector with the
sub-account config (preserve the existing Farcaster + injected connectors):

```ts
import { baseAccount } from 'wagmi/connectors'
import { getCryptoKeyAccount } from '@base-org/account'

baseAccount({
  appName: 'Kismet',
  appLogoUrl: process.env.NEXT_PUBLIC_FARCASTER_ICON_URL ?? undefined,
  subAccounts: {
    creation: 'on-connect',        // auto-provision the sub-account
    defaultAccount: 'universal',   // keep the user's main identity primary
    funding: 'spend-permissions',  // auto-fund from the parent within the cap (tap-free)
    toOwnerAccount: getCryptoKeyAccount, // browser key signs the sub-account (Mode A)
  },
  // paymasterUrls: { 8453: process.env.NEXT_PUBLIC_PAYMASTER_URL! }, // gasless (optional)
})
```

> **Top risk — verify before/at apply:** `lib/wagmi.ts` is the wallet config every
> user hits. Reconcile with RainbowKit's existing Coinbase/Base Account wallet (avoid
> a duplicate connector), confirm the Base App injected provider + this connector
> coexist, and smoke-test a normal connect on web + Base App before shipping. This is
> the only change that can regress all wallet connections — do it deliberately.

### 2. Provider for the utilities — use the connected one
The `@base-org/account/spend-permission` utilities take a `provider`. Get it from
wagmi (`const provider = await connector.getProvider()`), not a fresh SDK. With the
connector's `subAccounts` config, `eth_requestAccounts` returns `[universal, sub]`
(sub second) and `useSendCalls` routes tap-free through the sub-account.

### 3. Refactor `lib/agent/scout/baseAccount.ts`
Replace `getCollectingSdk()`/`createBaseAccountSDK` with provider-passed functions
(take the wagmi connected provider). Keep `requestSpendPermission` /
`getPermissionStatus` / `fetchPermissions` / `requestRevoke`. Sub-account address
comes from wagmi (`accounts[1]` / `wallet_getSubAccount`), not `sdk.subAccount.get()`.

## What this turn ships (verifiable now, no `lib/wagmi.ts` change)

- `hooks/useSmartWalletAgentEligibility.ts` — the gate (read-only; safe).
- `components/AutoCollectPanel.tsx` — the **auto-collect** setup + management UI
  (states: ineligible / set-up / active), built against the stable
  `useCollectingAccount` interface.

The provider refactor (§3) + the connector config (§1) are the **smoke-test-gated**
wiring that makes it live — intentionally not applied blind here.

## Deep-dive: verified handling of each piece

Researched against the installed RainbowKit/wagmi/@base-org types + the Base docs
RainbowKit integration page (search-confirmed; docs.base.org blocks fetch).

### Piece 1 — `lib/wagmi.ts` (the every-user change)

**Current:** `connectors: [farcasterMiniApp?(gated), injected?(Coinbase WebView), …rainbowKitConnectors]`,
where `rainbowKitConnectors = connectorsForWallets(getDefaultWallets().wallets, …)`.
So the Base Account/Coinbase entry comes from RainbowKit's **default list** — which
takes **no per-wallet options**, so we can't attach `subAccounts` there.

**Verified facts (read from the installed runtime source, not just `.d.ts`):**
- `@wagmi/connectors@6.2.0` `baseAccount({ … })` **honors `subAccounts`/`paymasterUrls`.**
  Its `getProvider()` does `createBaseAccountSDK({ ...parameters, appChainIds, preference })`
  — i.e. it **spreads every parameter** into the SDK
  (`node_modules/@wagmi/connectors/dist/esm/baseAccount.js`). ✅
- **RainbowKit 2.2.10's `baseAccount` wallet DROPS `subAccounts`.** ❌ Its factory is
  `({ appName, appIcon }) => …` and the body does
  `const { preference, ...optionalConfig } = baseAccount` — destructuring off the
  **function object itself**, not the options arg — so `optionalConfig` is `{}` and the
  underlying connector is built with only `{ appName, appLogoUrl, preference }`
  (`dist/wallets/walletConnectors/chunk-5C3SILBQ.js`). Passing `subAccounts` to it is a
  **silent no-op**. This resolves the earlier "verify the options arg" item: it does **not**.
- `getDefaultWallets()` (2.2.10) default list is
  `[safeWallet, rainbowWallet, baseAccount, metaMaskWallet, walletConnectWallet]` — so
  **today's Base Account entry is exactly that subAccounts-less wrapper.**
- `connectorsForWallets` runs `uniqueBy(wallets, "id")` (keeps the **first** by `id`).
  RainbowKit's wallet has `id: "baseAccount"`, so a second `baseAccount`-id wallet is
  **discarded** — you must **replace** the entry in-list, not append (else the broken
  default wins). This makes "no duplicate" a **correctness** requirement, not cosmetics.

**Corrected approach (do not blind-edit):** don't use RainbowKit's `baseAccount` wallet.
Build a **custom RainbowKit `Wallet`** (modeled on RK's own, but calling the **wagmi**
connector directly with the full config) and put it in a custom `connectorsForWallets`
list in place of the default `baseAccount`. RK calls each wallet factory with
`{ projectId, appName, appIcon, options, walletConnectParameters }`, so take `appName`/
`appIcon` from there:

```ts
import { createConnector } from 'wagmi'
import { baseAccount as baseAccountConnector } from 'wagmi/connectors'
import { getCryptoKeyAccount } from '@base-org/account'
import type { Wallet } from '@rainbow-me/rainbowkit'

// RK 2.2.10's built-in `baseAccount` wallet silently drops subAccounts, so wrap
// the wagmi connector ourselves. Keep id:"baseAccount" so it REPLACES (uniqueBy)
// the default entry — exactly one Base Account row, with sub-accounts wired.
const baseAccountWithSubAccounts = ({ appName, appIcon }: { appName?: string; appIcon?: string }): Wallet => ({
  id: 'baseAccount',
  name: 'Base Account',
  shortName: 'Base Account',
  rdns: 'app.base.account',
  iconUrl: async () => process.env.NEXT_PUBLIC_FARCASTER_ICON_URL ?? '/icon.png', // needs a real asset
  iconAccent: '#0000FF',
  iconBackground: '#0000FF',
  installed: true,
  createConnector: (walletDetails) => {
    const connector = baseAccountConnector({
      appName: appName ?? 'Kismet',
      appLogoUrl: appIcon ?? process.env.NEXT_PUBLIC_FARCASTER_ICON_URL ?? undefined,
      subAccounts: {
        creation: 'on-connect',
        defaultAccount: 'universal',     // keep the user's main identity primary
        funding: 'spend-permissions',    // tap-free auto-funding within the cap
        toOwnerAccount: getCryptoKeyAccount,
      },
      // paymasterUrls: { 8453: process.env.NEXT_PUBLIC_PAYMASTER_URL! }, // gasless (optional)
      preference: { telemetry: false },
    })
    return createConnector((config) => ({ ...connector(config), ...walletDetails }))
  },
})
```

Then build the list by swapping this in for the default `baseAccount` (keep the other
default wallets, and the existing Farcaster/injected gating, untouched):

```ts
const { wallets } = getDefaultWallets()
const customWallets = wallets.map((g) => ({
  ...g,
  wallets: g.wallets.map((w) => (w === baseAccount ? baseAccountWithSubAccounts : w)),
}))
const rainbowKitConnectors = connectorsForWallets(customWallets, { projectId, appName, appIcon })
```

(Or assemble the group list explicitly. The `iconUrl` must point at a real asset — RK
throws on a bad `iconAccent`, and a missing icon renders blank in the modal.)

**Base App nuance:** post-April-2026 the Base App runs apps as standard web apps and
uses the `baseAccount` + `injected` connectors. Today our Base App path is `injected()`
only (no `subAccounts` config). **Verify** whether the Base App injected provider
honors the sub-account RPCs, or whether the configured `baseAccount` connector should
be the Base App path too (it likely should). The Farcaster connector may be vestigial
for the Base App post-migration.

**Smoke test before ship (mandatory — breaks all connections if wrong):** normal
connect on web (RainbowKit modal shows ONE Base Account, no dupes), connect in the
**Base App**, connect in a **Farcaster** mini-app, and an EOA connect (MetaMask) —
all must still work; then confirm a sub-account is provisioned on a Base Account.

### Piece 2 — `baseAccount.ts` refactor + mount `AutoCollectPanel`

**Provider (replace the standalone SDK):** get the **connected** provider from wagmi
and pass it to the `@base-org/account/spend-permission` utilities (they take a
`provider`):

```ts
const { connector, addresses } = useAccount()
const provider = (await connector?.getProvider()) as ProviderInterface
// requestSpendPermission({ account: universal, spender: subAccount, token: USDC,
//   chainId: 8453, allowance, periodInDays, provider })
```

Remove `getCollectingSdk()`/`createBaseAccountSDK` from `baseAccount.ts` (that second
SDK = a second session / double connect). **Sub-account address** comes from wagmi
once the connector has `subAccounts` (defaultAccount:'universal'): `addresses?.[1]`
(or `wallet_getSubAccount`). **Tap-free collect** (later phase): wagmi `useSendCalls`
from the sub-account; `funding:'spend-permissions'` auto-funds from the parent.
Keep the EIP-5792 `wallet_getCallsStatus` `status===200` gate already fixed.

**Mount in ProfileView (owner section):** render owner-only + **lazy-loaded** so the
heavy `@base-org/account` dep stays out of the profile's initial bundle (the profile
route is ~380 kB; a static import would likely trip `check:bundle`):

```ts
import dynamic from 'next/dynamic'
const AutoCollectPanel = dynamic(
  () => import('@/components/AutoCollectPanel').then((m) => m.AutoCollectPanel),
  { ssr: false },
)
// …in the owner area (e.g. near the public-view toggle / above the sections grid):
{isOwner && <AutoCollectPanel />}
```

`AutoCollectPanel` already self-gates on `useSmartWalletAgentEligibility`, so an
eligible owner sees setup/manage and an EOA owner sees the soft note.

**Verify at smoke test:** `connector.getProvider()` returns an EIP-1193 provider that
supports `coinbase_fetchPermissions` / spend-permission RPCs on each connector
(RainbowKit baseAccount, Base App injected); `addresses?.[1]` resolves the sub-account;
and run `next build` + `check:bundle` after mounting (the lazy import should keep the
profile route under threshold).

### Sequencing
Apply Piece 1 + Piece 2 **together** behind one smoke test (Piece 2's provider
refactor is non-functional until Piece 1 configures the connector). Until then,
`AutoCollectPanel` stays unmounted.

### Sources
- Installed types: `@wagmi/connectors@6.2.0` (`baseAccount.d.ts`),
  `@base-org/account@2.4.0`.
- [wagmi `baseAccount` connector](https://wagmi.sh/react/api/connectors/baseAccount) ·
  [Base mini-apps → standard web app](https://docs.base.org/mini-apps/core-concepts/base-account) ·
  [Use Sub Accounts](https://docs.base.org/base-account/improve-ux/sub-accounts)
