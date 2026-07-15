# Collect (primary mint)

Mint a copy of a moment to the user's Base Account. Pays the sale price (ETH or
USDC) plus a small Zora protocol mint fee.

## 1. Prepare

```
POST BASE/api/agent/prepare-collect
{
  "collection": "0x…",        // or omit and pass "url"
  "tokenId": "42",            // or omit and pass "url"
  "url": "BASE/moment/0x…/42", // alternative to collection+tokenId
  "account": "0xYourBaseAccount",
  "amount": 1,                 // optional, default 1
  "comment": "great piece"    // optional mint comment
}
```

Also available as a GET with the same parameters in the query string — for
surfaces where POST can't reach Kismet (see SKILL.md "Reaching the endpoints"):

```
GET BASE/api/agent/prepare-collect?collection=0x…&tokenId=42&account=0x…&amount=1
```

The server reads the live sale on-chain and decides ETH vs USDC and the price —
do not pass a price. If there's no active sale, it's sold out, or the wallet hit
its per-wallet limit, you'll get a `409`; relay that to the user.

The response `calls` is:
- **ETH** → one `mint` call carrying `value = (mintFee + price) × amount`.
- **USDC** → `[approve, mint]` when allowance is short, else just `[mint]`.

## 2. Execute

Show `summary` (e.g. *"Collect 1× token #42 for $5.00 …"*). Then:

```
send_calls({ chain: "base", calls })
```

One approval in Base Account (the `approve` + `mint` are batched). Wait for the
confirmed **txHash**.

## 3. Record

Take `record.bodyTemplate`, replace `txHash`'s placeholder with the confirmed
hash, and:

```
POST BASE/api/collect    (record.bodyTemplate with txHash filled)
```

`/api/collect` independently verifies the mint on-chain before crediting, so this
is safe to call and idempotent. If it returns non-2xx the mint still happened —
just report that recording lagged.

## Batch — collect several in one approval

To collect a basket (e.g. the user said "collect these" or you're proposing a
curated set), use the batch endpoint instead of N single collects:

```
POST BASE/api/agent/prepare-collect-batch
{ "items": [ { "collection": "0x…", "tokenId": "1" }, { "url": "BASE/moment/0x…/2" } ],
  "account": "0xYourBaseAccount",
  "recipient": "0xOptionalCollector",  // optional, defaults to account
  "comment": "great set" }             // optional mint comment
```

It returns one `calls` batch (a single `send_calls` approval — USDC items share
one summed approve) plus a `records[]` array (one `/api/collect` per item). After
the single approval confirms, POST each `records[]` entry with the **same**
txHash. Unavailable items come back in `skipped`.
