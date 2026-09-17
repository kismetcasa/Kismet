# Discover

Find things to act on. Every row includes a `nextAction` with the exact prepare
call to make next, so you can chain discover → prepare → execute. `nextAction`
is expressed as a POST; on a chat-only surface send the same `suggestedBody`
fields as a GET query string plus `format=json` (SKILL.md rung 3).

## Listings to buy (default)

```
GET BASE/api/agent/discover?kind=listings&currency=eth&maxPrice=0.05&limit=10&account=0xYourBaseAccount
```

- `currency` (`eth` | `usdc`) and `maxPrice` (human decimal) filter the feed.
  `maxPrice` is only applied when `currency` is also set.
- `collection` (optional) restricts to one collection.
- `account` (optional) is echoed into each row's `nextAction.suggestedBody`.

Each row: `{ kind, collection, tokenId, name, image?, price (base units),
priceLabel, currency, listingId, seller, momentUrl, nextAction }`. To buy a
row, follow its `nextAction` (→ `references/buy.md`).

## Artworks to collect in a collection

```
GET BASE/api/agent/discover?kind=collect&collection=0x…&excludeCollectedBy=0xYourBaseAccount&limit=10&account=0xYourBaseAccount
```

- `collection` is **required** for `kind=collect`.
- `excludeCollectedBy` drops tokens that address already collected.

Rows don't carry a price (the live sale is resolved by `prepare-collect`). Follow
each row's `nextAction` to collect (→ `references/collect.md`).

## Artworks by an artist

`discover` has no artist filter, but Kismet's public timeline does — it is what
Kismet's own Agent Collect engine reads:

```
GET BASE/api/timeline?creator=0xArtist&limit=20
```

Rows carry `address` (the collection) and `token_id`; feed each into
`prepare-collect`, which resolves price and eligibility on-chain. Timeline rows
have no `nextAction` and no collected filter: to skip what the user already
holds, check `GET BASE/api/timeline?collector=0xYourBaseAccount&limit=100`
(or ask) before preparing. Resolve a username to an address with
`GET BASE/api/search?q=<name>` (`users[].address`).

## Ranking

Rows are ordered by recency. There is no taste or relevance ranking;
availability is resolved by the prepare step.
