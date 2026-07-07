# Korral StoreLink MCP Server

A custom **MCP server (stdio)** that lets a Duvo agent do a Korral buyer's
replenishment job against **StoreLink**: for one SKU at one store, check on-hand
vs recent sales and raise a replenishment order when the gap warrants.

## Try it in 30 seconds

One command, no LLM: store 47 raises an order, 102 declines, 55 refuses (no key).
The build proving itself.

```bash
git clone https://github.com/MartinStuebler/fde-task && cd fde-task
cp secrets/store-47.key.example secrets/store-47.key
cp secrets/store-102.key.example secrets/store-102.key
npm install && npm run smoke
```

## What it is / the unit of work
For one SKU at one store, reach a terminal state:
- **order raised** — gap justifies it, write is made and audited
- **no order needed** — well stocked
- **failed-safe** — no creds / key rotated / StoreLink error → refuse clearly, never guess

## Tools exposed (agent-facing)
`list_stores`, `get_store`, `get_inventory`, `get_recent_sales`,
`raise_replenishment` (the one write), `get_replenishment_status`,
plus `get_sku`, `get_supplier`.

## Deliberately NOT exposed
- **No raw POS dump** — `get_recent_sales` returns a summary; a buyer needs a
  decision, not thousands of rows, and it keeps the agent's context lean and
  leaks less.
- **No arbitrary passthrough** — every capability is a named, reviewable tool, so
  Korral IT can audit exactly what the agent can do.
- **Single audited write** — `raise_replenishment` is the one state-changing
  action, explicit and logged, so no write is invisible.

## Decision logic lives in the agent
Tools return facts (on-hand, 24h sales). The agent computes
`gap = sold_24h − on_hand` and raises a replenishment order when `gap > 6`.
Keeping policy out of the tools keeps the server a thin, auditable data/authz layer.

- Store **47**: on-hand 4, sold 12 → `gap = +8` → **order raised** (8 units)
- Store **102**: on-hand 40, sold 3 → `gap = −37` → **no order needed**

## Observability (two audiences)
- **FDE stream:** structured JSON logs to **stderr** (stdout stays clean for the
  MCP protocol) — timestamp, request id, tool, args, outcome, errors.
- **Buyer stream:** one plain-English line per action to `audit.log`, e.g.
  `Store 47, SKU 8847291: on-hand 4, sold 12 in 24h, raised order #123 for 8 units.`

## Security / secrets
- Per-store keys loaded from `secrets/store-<id>.key` at startup; sent as
  `X-Korral-Store-Key`, scoped to one store.
- **Key rotation (401):** reload the key once from the secret store and retry;
  if it still fails, fail safe. (Demo hook: `ROTATE_ON_STORE=47`.)
- **No creds for a store → refuse** with a clear, safe message. Never guess.
- Prod secrets come from **GCP Secret Manager** (see `DEPLOYMENT.md`).
- Shipping into Korral's private GCP (StoreLink off the public internet, no
  customer data leaves the tenancy) is covered in `DEPLOYMENT.md`.

## Run it
```bash
docker build -t fde-task .
docker run --rm -i fde-task        # stdio server; the agent is the client
```
Local demo without an LLM (plays the agent, shows both branches + refusal):
```bash
npm install && npm run smoke
```

## Tradeoffs (1-hour build)
- **Stubbed StoreLink** (the brief permits it) to spend the hour on the agent
  surface, auth, and observability.
- **`gap > 6` is a fixed threshold**; in prod it'd be per-SKU and lead-time aware.
- **Rotation** handles 401 reload-and-retry; prod would add jittered backoff and
  per-store write rate limits.
- **Not yet included:** `get_replenishment_status` polling in the agent loop, and
  unit tests around the auth/rotation state machine.

## Deploy
Shipping into Korral's private GCP — GKE/GCE alongside Duvo's agent runtime,
secrets via GCP Secret Manager, the 11pm fix path, and the day-1 confirmations —
is covered in `DEPLOYMENT.md`.

## Demo (on camera)
1. SKU 8847291 (Madeta Butter 250g), stores **47** and **102** — 47 triggers an
   order (gap 8), 102 does not (well stocked). Both branches shown.
2. Store **55** has no key → safe, clear refusal.
3. One buyer-readable audit line for the write in `audit.log`.

4. <img width="584" height="775" alt="Screenshot 2026-07-07 at 6 00 37 PM" src="https://github.com/user-attachments/assets/4924c8cf-b0c0-4ece-9ed0-c93b87407790" />

