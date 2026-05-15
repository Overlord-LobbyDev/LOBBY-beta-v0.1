# LOBBY Commerce API — Contract Spec

This document is the authoritative spec for every commerce-related HTTP / WebSocket endpoint the LOBBY desktop client calls. The frontend in `index.html` and `admin.html` is already wired to expect these exact shapes — the server just needs to implement them.

**Core rule:** the server is the single source of truth. The client never grants ownership, never mutates LC balance, never marks anything "owned" locally. Anything the client sends is a request; the server validates and decides.

---

## Authentication

| Use case | Header |
| --- | --- |
| Normal user calls | `Authorization: Bearer <session_jwt>` |
| Admin commerce calls | `Authorization: Bearer <admin_jwt>` **AND** `X-Finance-Token: <step_up_token>` |

The session JWT is whatever your existing auth issues. The **finance step-up token** is a short-lived (15 min) credential issued by `/admin/auth/finance-step-up` after the admin re-enters their password. Without it, every `/admin/finance/*`, `/admin/store/*`, `/admin/featured*` route MUST return 403 even for users with the admin role.

---

## User-facing endpoints

### `GET /me/wallet`
Return the current LOBBY Coins balance for the authenticated user.

```json
{ "lc": 12450, "lifetimeLcSpent": 8600 }
```

### `GET /me/payment-providers`
Return which payment provider the server has chosen for this user, based on region/device. The client never overrides this.

```json
{
  "preferred": "stripe",
  "available": ["stripe", "paddle"],
  "region": "GB"
}
```

`preferred` ∈ `stripe | paddle | lemon | iap_apple | iap_google`.

### `POST /lc/topup/intent`
Begin a LOBBY Coins purchase. The server creates a pending transaction row and returns the checkout URL for the chosen provider.

Request:
```json
{ "packId": "starter" }
```

Pack IDs (must match frontend `LC_PACKS`): `starter | plus | pro | elite | treasury`.

Response (Stripe / Paddle / Lemon Squeezy):
```json
{
  "txnId": "txn_01HZK4...",
  "provider": "stripe",
  "checkoutUrl": "https://checkout.stripe.com/c/pay/...",
  "expiresAt": 1719876543210
}
```

Response (Apple / Google IAP — native app only):
```json
{
  "txnId": "txn_01HZK4...",
  "provider": "iap_apple",
  "productSku": "lobby.lc.starter"
}
```

The client opens `checkoutUrl` in the OS browser (Electron) or as a popup (web). For IAP it hands the SKU to the native bridge.

### `POST /lc/topup/confirm` *(internal — webhook handlers call this)*

The frontend does NOT call this. Each payment provider's webhook handler (`/webhooks/stripe`, `/webhooks/paddle`, `/webhooks/lemonsqueezy`, `/webhooks/iap`) must:

1. Verify the webhook signature.
2. Look up the `txnId` (passed in `metadata`).
3. Mark the transaction as `succeeded` and credit the user's wallet atomically.
4. Push `lc-credited` over WebSocket to that user (see *WebSocket events* below).

### `GET /me/cosmetics`
What the authenticated user owns + has equipped globally.

```json
{
  "owned": ["np-holo", "frame-flame", "banner-tekken-stage"],
  "equipped": {
    "nameplate": "holo",
    "frame": "flame",
    "banner": "tekken-stage",
    "chatfx": null
  },
  "activePreview": {
    "productId": "np-rainbow",
    "expiresAt": 1719876600000
  }
}
```

### `PATCH /me/cosmetics/equip`
Equip a cosmetic globally (NOT per-lobby — that's `/me/loadouts`).

Request:
```json
{ "slot": "nameplate", "productId": "np-holo" }
```

Server validates the user owns it. Returns 403 if not.

### `POST /me/cosmetics/preview`
Start a temporary preview ("try it on"). Server clamps duration to `TRY_ON_MAX_SECONDS = 120`.

Request:
```json
{ "productId": "np-rainbow", "duration": 120 }
```

Response:
```json
{ "previewId": "prv_01HZK...", "expiresAt": 1719876720000 }
```

Server-side: schedule a job to emit `preview-expired` over WebSocket when the window ends. Override any existing preview from the same user.

### `DELETE /me/cosmetics/preview`
End the active preview early. Idempotent.

### `GET /me/loadouts`
Per-lobby alter-ego loadouts.

```json
{
  "default": { "displayName": "Overlord", "pronouns": "he/him", "nameplate": "", "frame": "", "banner": "", "chatfx": "" },
  "lobby-id-tekken": { "displayName": "Iron Fist", "pronouns": "", "nameplate": "fire", "frame": "flame", "banner": "tekken-stage", "chatfx": "" },
  "lobby-id-chess":  { "displayName": "GM_OL", "pronouns": "", "nameplate": "chrome-cyber", "frame": "", "banner": "", "chatfx": "" }
}
```

### `PATCH /me/loadouts/:lobbyId`
Save the loadout for a specific lobby (`default` is a reserved sentinel that applies anywhere there's no override).

Request:
```json
{ "displayName": "Iron Fist", "pronouns": "", "nameplate": "fire", "frame": "flame", "banner": "tekken-stage", "chatfx": "" }
```

Server MUST verify the user owns every equipped cosmetic. If not, return 403 with the offending product ID.

### `DELETE /me/loadouts/:lobbyId`
Clear that lobby's loadout — falls back to `default`.

### `GET /lobbies/public`
Real lobbies that have opted into Discover. Used to populate the carousel + recommendations. Pure read.

```json
[
  { "id": 12, "name": "TEKKEN UK", "tag": "fighting", "members": 1284, "online": 372, "tags": ["tekken8","fighting"], "cover": "https://…/header.jpg", "fallback": "linear-gradient(...)", "badge": "trending" }
]
```

### `GET /tournaments/global`
Real tournaments across the platform.

```json
[
  { "id": 88, "name": "Weekend Throwdown", "game": "tekken8", "status": "LIVE", "entrants": 64, "prize": "$500", "startsAt": "2026-05-18T19:00:00Z" }
]
```

### `GET /tournaments/me/stats`
The current user's personal tournament record.

```json
{ "wins": 12, "lossesQF": 4, "winRate": 0.62, "currentRank": "Diamond II", "trophies": 3 }
```

### `GET /featured/spotlight`
The editorial "LOBBY Featured" slot. Returns `null` if nothing currently featured.

```json
{
  "id": "feat_2026_05_w20",
  "kind": "tournament",
  "name": "WEEKEND THROWDOWN — $500",
  "headline": "Pro circuit — registration closes in 4h",
  "hero": "https://…/hero.jpg",
  "heroHi": "https://…/hero@2x.jpg",
  "targetId": 88,
  "startsAt": "...",
  "endsAt": "..."
}
```

The client unconditionally prepends this to the carousel rotation.

---

## Admin endpoints

All require `Authorization` admin role **and** the `X-Finance-Token` header. Return 403 otherwise.

### `POST /admin/auth/finance-step-up`
Re-validate the admin's password and issue a 15-minute finance scope token.

Request: `{ "password": "..." }`
Response: `{ "token": "fts_01H...", "expiresInSeconds": 900 }`

The token is HMAC-signed with a server secret + the admin's user ID, expiry baked in. It is NOT a JWT extension — it's a separate credential that can be revoked instantly via a server-side cache.

### `GET /admin/finance/summary`
The Finance dashboard payload.

```json
{
  "revenueTodayUSD": 1248.32,
  "revenueTodayDeltaPct": 12.4,
  "revenueMTDUSD": 38200.10,
  "revenueMTDDeltaPct": 4.8,
  "lcSoldToday": 184000,
  "refunds30dUSD": 220.00,
  "refundRatePct": 0.74,
  "topSkus": [
    { "id": "pass-crown-s1", "name": "Crown Pass Season 1", "tier": "mythic", "units": 412, "lcEarned": 11876800 }
  ],
  "payouts": [
    { "date": "2026-05-12", "provider": "stripe", "grossUSD": 6240.50, "feesUSD": 192.30, "netUSD": 6048.20, "status": "paid" }
  ]
}
```

### `GET /admin/finance/transactions?q=&status=&provider=&limit=`
Transaction list, paginated.

```json
[
  { "id": "txn_01H...", "userId": 4421, "username": "Overlord", "provider": "stripe", "packLabel": "Pro", "amountUSD": 24.99, "lcCredited": 3400, "status": "succeeded", "createdAt": "..." }
]
```

`status` ∈ `succeeded | pending | failed | refunded | disputed`.

### `POST /admin/finance/refund`
Refund a transaction.

Request: `{ "txnId": "txn_...", "reason": "Duplicate purchase" }`

Server must:
1. Call the provider's refund API.
2. Atomically: deduct the refunded LC from the user's wallet (if balance < amount, clamp to 0 and log the discrepancy).
3. Mark the transaction `refunded`.
4. Append to audit log.
5. Push `wallet-update` over WS to that user.

### `GET /admin/store/products`
List of all cosmetic product IDs for the grant form's dropdown.

```json
[
  { "id": "np-holo", "name": "Holographic Name", "tier": "legendary", "category": "nameplates" }
]
```

### `GET /admin/store/audit?limit=`
Last N grant/revoke entries.

```json
[
  { "at": "2026-05-13T20:11Z", "adminId": 1, "adminUsername": "ops", "action": "grant", "userId": 4421, "userUsername": "Overlord", "productId": "np-holo", "productName": "Holographic Name", "reason": "Apology — chargeback resolution" }
]
```

### `POST /admin/store/grant`
Grant a cosmetic to a user. **Always logged.**

Request: `{ "userId": 4421, "productId": "np-holo", "reason": "..." }`

### `POST /admin/store/revoke`
Revoke a cosmetic. Always logged. If the cosmetic is currently equipped, server unequips it first.

### `GET /admin/store/lookup-user?q=`
Find a user by ID, username, or email.

```json
{ "id": 4421, "username": "Overlord", "email": "…", "lcBalance": 12450, "owned": [{ "id": "np-holo", "name": "Holographic Name" }] }
```

### `GET / PUT / DELETE /admin/featured`
CRUD for the LOBBY Featured slot.

PUT payload:
```json
{ "kind": "tournament", "targetId": 88, "headline": "WEEKEND THROWDOWN — $500 prize", "hero": "https://…/hero.jpg", "startsAt": "...", "endsAt": "..." }
```

---

## WebSocket events (server → client)

These are pushed on the existing user WebSocket connection.

| Type | Payload | When |
| --- | --- | --- |
| `lc-credited` | `{ txnId, lcAdded, newBalance }` | After a payment provider's webhook confirms a top-up. |
| `lc-spent` | `{ productId, lcSpent, newBalance }` | After a server-side spend (cosmetic purchase). |
| `wallet-update` | `{ newBalance }` | Any other wallet mutation (admin grant of LC, refund, etc.). |
| `cosmetic-granted` | `{ productId, name }` | Server granted a cosmetic to the user (admin or system). |
| `cosmetic-revoked` | `{ productId, name }` | Server revoked a cosmetic. |
| `preview-expired` | `{ productId }` | The temporary try-on window has ended. |

The client already handles all of these (`window.handleLCCredited`, `window.handlePreviewExpired`, etc.) and re-fetches `/me/wallet` for `wallet-update`.

---

## Data model recommendations

```sql
CREATE TABLE lc_wallets (
  user_id      BIGINT PRIMARY KEY,
  lc_balance   BIGINT NOT NULL DEFAULT 0,
  lifetime_spent BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE lc_transactions (
  id           TEXT PRIMARY KEY,            -- prefix txn_
  user_id      BIGINT NOT NULL,
  provider     TEXT NOT NULL,                -- stripe|paddle|lemon|iap_apple|iap_google
  provider_ref TEXT,                          -- charge_, sub_, paddle_subscription_id, etc.
  pack_id      TEXT NOT NULL,
  amount_cents INT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  lc_credited  INT NOT NULL,
  status       TEXT NOT NULL,                -- pending|succeeded|failed|refunded|disputed
  fee_cents    INT,
  refunded_cents INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  INDEX (user_id), INDEX (status), INDEX (provider)
);

CREATE TABLE cosmetic_ownership (
  user_id      BIGINT NOT NULL,
  product_id   TEXT NOT NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source       TEXT NOT NULL,                -- purchase|grant_admin|pass_bundle|gift
  source_ref   TEXT,                          -- txn_… or admin user id
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE cosmetic_loadouts (
  user_id      BIGINT NOT NULL,
  scope        TEXT NOT NULL,                -- 'default' or lobby id as text
  display_name TEXT,
  pronouns     TEXT,
  nameplate    TEXT,
  frame        TEXT,
  banner       TEXT,
  chatfx       TEXT,
  PRIMARY KEY (user_id, scope)
);

CREATE TABLE cosmetic_previews (
  user_id      BIGINT NOT NULL,
  product_id   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id)                       -- one active preview per user
);

CREATE TABLE admin_audit (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_id     BIGINT NOT NULL,
  action       TEXT NOT NULL,                -- grant|revoke|refund|featured_publish|...
  target_user_id BIGINT,
  product_id   TEXT,
  txn_id       TEXT,
  reason       TEXT,
  meta_json    JSONB
);

CREATE TABLE featured_slot (
  id           TEXT PRIMARY KEY,             -- always 'global' for now
  kind         TEXT NOT NULL,                -- tournament|lobby|announcement
  target_id    TEXT,
  headline     TEXT,
  hero         TEXT,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  updated_by   BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## Security checklist

- **Never** trust client-sent `lc_balance` or `owned` lists. Re-derive on every read.
- All `/me/*` writes must verify the caller owns the resource.
- All `/admin/*` calls require BOTH the admin role bit on the session JWT **and** a valid `X-Finance-Token` header.
- Webhook endpoints (`/webhooks/stripe|paddle|lemonsqueezy|iap`) must verify provider signatures.
- Wallet credits are atomic transactions — never read-modify-write without a row lock.
- `cosmetic_ownership` writes are idempotent by `(user_id, product_id)`.
- Refund flow: provider refund → wallet debit → mark txn refunded → audit log → WS push. All in one DB transaction or use a saga with compensating actions.
- Audit log is append-only. Never delete rows.

---

## Pack pricing reference (set in Stripe / Paddle / Lemon dashboards)

| pack_id | LC | Bonus | USD |
| --- | --- | --- | --- |
| starter  | 500    | 0    | 4.99 |
| plus     | 1,200  | 100  | 9.99 |
| pro      | 3,000  | 400  | 24.99 |
| elite    | 7,500  | 1,500 | 49.99 |
| treasury | 15,000 | 4,000 | 99.99 |

For IAP (Apple / Google) use SKUs `lobby.lc.starter` etc. The store IDs must match across all provider catalogs.

---

## Implementation order (suggested)

1. `lc_wallets`, `lc_transactions`, `/me/wallet`, `/me/payment-providers` (read).
2. Stripe checkout: `/lc/topup/intent` + `/webhooks/stripe` → first paid LC top-up working end-to-end.
3. `cosmetic_ownership`, `/me/cosmetics`, `/me/cosmetics/equip`, store-side spend (deduct LC, insert ownership, push WS).
4. `cosmetic_loadouts`, `/me/loadouts` GET/PATCH/DELETE.
5. `cosmetic_previews` + `/me/cosmetics/preview` POST/DELETE + scheduled expiry job + `preview-expired` WS.
6. Admin finance suite (last — but ALL admin endpoints check `X-Finance-Token` from day one).
7. Paddle / Lemon / IAP providers — same shape, additional webhook handlers.
