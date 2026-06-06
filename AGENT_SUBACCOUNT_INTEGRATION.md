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

### Sources
- Installed types: `@wagmi/connectors@6.2.0` (`baseAccount.d.ts`),
  `@base-org/account@2.4.0`.
- [wagmi `baseAccount` connector](https://wagmi.sh/react/api/connectors/baseAccount) ·
  [Base mini-apps → standard web app](https://docs.base.org/mini-apps/core-concepts/base-account) ·
  [Use Sub Accounts](https://docs.base.org/base-account/improve-ux/sub-accounts)
