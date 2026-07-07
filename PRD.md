# PRD — Duvo × Korral StoreLink MCP Server (1-hour build)

This is the locked build spec. Do not deviate from scope without flagging it.

## Goal
Ship a custom MCP server that lets a Duvo agent do a Korral buyer's replenishment
job against StoreLink: check on-hand vs recent sales for a SKU at a store, and raise
a replenishment order when warranted. Then make it observable, secure around per-store
key rotation, and shippable into Korral's private GCP network.

## The unit of work (one case)
For one SKU at one store: decide if it will run empty, raise a replenishment order if
the gap justifies it. Terminal states: order raised / no order needed / failed-safe
(no creds, key rotated, StoreLink error).
The demo runs this single case twice (store 47, then 102) — the agent loops it.

## Stack decisions
- Language: Node 20 + TypeScript, run via `tsx` (NO compile step; Dockerfile runs tsx)
- MCP client for demo: Claude Code
- Transport: stdio (Claude Code launches the server as a subprocess)
- StoreLink: in-memory stubs with realistic fake data (no real integration)

## Tools to expose (agent-facing surface)
Core (sacred):
- list_stores
- get_store(store_id)
- get_inventory(store_id, sku)            -> on-hand
- get_recent_sales(store_id, sku, hours)  -> summarized POS, NOT raw transactions
- raise_replenishment(store_id, sku, quantity)   -> the one write
- get_replenishment_status(store_id, order_id)
Droppable if behind:
- get_sku(sku)
- get_supplier(supplier_id)

## Deliberately NOT exposed (state in README)
- No raw POS transaction dump (summarize instead)
- No arbitrary StoreLink passthrough
- Write is a single explicit, audited tool — not a generic POST

## Decision logic
- Tools return facts (on-hand, 24h sales). The AGENT computes the gap and decides.
- The "gap > 6 units" rule lives in the agent, not in a tool.

## Write behavior
- Agent raises replenishment directly (no confirm step).
- Every write is loudly recorded to the audit log.

## Observability (two audiences)
- FDE stream: structured JSON logs to stderr — timestamp, request id, tool, args,
  outcome, errors with context. (stderr, so the stdio MCP protocol on stdout stays clean.)
- Buyer stream: plain-English audit line per action to a file, e.g.
  "Store 47, SKU 8847291: on-hand 4, sold 12 in 24h, raised order #123 for 8 units."

## Security / secrets
- Per-store keys loaded from a secrets file/dir at startup.
  Described as GCP Secret Manager in DEPLOYMENT.md for prod.
- Header X-Korral-Store-Key sent per request, key scoped to one store.
- Key rotates mid-request (401): reload the key once and retry, then fail clearly.
- No creds for requested store: refuse with a clear, safe message. Never guess.

## Deployment story (DEPLOYMENT.md, step 5)
- Runs as a container inside Korral's GCP, on GKE/GCE alongside Duvo's agent runtime
  (stdio server is a subprocess of the agent, not a public web service). StoreLink
  not on public internet; no customer data leaves Korral's tenancy.
- Secrets via GCP Secret Manager, mounted at runtime.
- Duvo owns the image + pipeline; Korral IT approves deploy into their project.
- 11pm fix: push new image, redeploy the internal workload.
- Confirm with Korral IT before day 1: egress/network rules, Secret Manager access,
  key rotation cadence + format, GCP project/service-account boundaries.

## Docker artifact
- Packages the server and runs it via tsx as a stdio process.
- NO EXPOSE / no port — this is a stdio MCP server, not an HTTP service.

## Scope priority
- SACRED: steps 1-2 running in Docker (core tools + live Madeta-butter demo working).
- DROPPABLE if behind: step 3 depth, step 4 second edge case, get_sku, get_supplier.

## Demo script (must show on camera, step 2)
1. SKU 8847291 (Madeta butter 250g), stores 47 and 102. Check on-hand vs last 24h POS
   for both; raise replenishment where gap > 6 units.
   Seed stubs so ONE store triggers an order and one does NOT (show both branches).
2. Ask for a store with no key -> show the safe, clear refusal.
3. Show one buyer-readable audit line for the write.
