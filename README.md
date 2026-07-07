# Korral StoreLink MCP Server

A custom **MCP server (stdio)** that lets a Duvo agent do a Korral buyer's
replenishment job against **StoreLink**: for one SKU at one store, check on-hand
vs recent sales and raise a replenishment order when the gap warrants.

## The unit of work
For one SKU at one store, reach a terminal state:
- **order raised** — gap justifies it, write is made and audited
- **no order needed** — well stocked
- **failed-safe** — no creds / key rotated / StoreLink error → refuse clearly, never guess

## Tools exposed (agent-facing)
`list_stores`, `get_store`, `get_inventory`, `get_recent_sales`,
`raise_replenishment` (the one write), `get_replenishment_status`,
plus `get_sku`, `get_supplier`.

## Deliberately NOT exposed
- **No raw POS transaction dump** — `get_recent_sales` returns a summary only.
- **No arbitrary StoreLink passthrough** — no generic proxy tool.
- **The write is a single explicit, audited tool** — not a generic POST.

## Decision logic lives in the agent
Tools return facts (on-hand, 24h sales). The **agent** computes the gap and the
`gap > 6 units` rule. Keeping policy out of the tools keeps the server a thin,
auditable data/authz layer.

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

## Run it
```bash
docker build -t fde-task .
docker run --rm -i fde-task        # stdio server; the agent is the client
```
Local demo without an LLM (plays the agent, shows both branches + refusal):
```bash
npm install && npm run smoke
```

## Demo (on camera)
1. SKU 8847291 (Madeta Butter 250g), stores **47** and **102** — 47 triggers an
   order (gap 8), 102 does not (well stocked). Both branches shown.
2. Store **55** has no key → safe, clear refusal.
3. One buyer-readable audit line for the write in `audit.log`.
