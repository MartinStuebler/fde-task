# Deployment — Korral StoreLink MCP Server

## Prerequisites
- Docker installed
- Per-store keys present in `secrets/store-<id>.key` (locally, copied from the
  `.key.example` files; in prod, from GCP Secret Manager — see below)

## Build & run
```bash
docker build -t fde-task .
docker run --rm -i fde-task
```
This is a **stdio MCP server** — there is **no port** and no HTTP endpoint. It
reads/writes newline-delimited JSON-RPC on stdin/stdout, so it is launched as a
**subprocess of the Duvo agent** (the agent is the MCP client), not a web service.
`docker run -i` keeps stdin open so the agent can drive it.

## Use it
- The agent connects over stdio and calls the tools: `list_stores`,
  `get_inventory`, `get_recent_sales`, `raise_replenishment`, etc.
- Quick check (no LLM) that the container responds:
  ```bash
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | docker run --rm -i fde-task
  ```
- Full local demo (plays the agent, shows both branches + refusal):
  `npm install && npm run smoke`
- Observability: FDE structured logs → **stderr**; buyer audit lines → `audit.log`.

## Deploying into Korral's GCP (production)
1. **Where it runs.** Ships as a container inside **Korral's own GCP project**,
   on **GKE/GCE alongside Duvo's agent runtime**. Because it's a stdio server, it
   runs as a **subprocess of the agent pod**, not a public/LB-fronted service.
   StoreLink stays off the public internet; **no customer data leaves Korral's
   tenancy.**
2. **Secrets.** Per-store keys come from **GCP Secret Manager**, mounted at
   runtime (env/volume) into `secrets/` — never baked into the image, never in
   git. The server reads them at startup and reloads a key on rotation (401).
3. **Ownership.** Duvo owns the **image and CI/CD pipeline**; **Korral IT approves**
   the deploy into their project and controls the network/IAM boundary.
4. **11pm fix path.** Push a new image → redeploy the internal workload
   (rollout of the agent pod that embeds this server). No public surface to change.

## Confirm with Korral IT before day 1
- Egress / network rules (StoreLink reachability, no public exposure)
- Secret Manager access + which service account may read per-store keys
- Key **rotation cadence and format** (so the reload-on-401 path matches reality)
- GCP **project / service-account boundaries** for the agent + this server

## Notes
- **No `EXPOSE` / no port** — intentional; stdio, not HTTP.
- The `gap > 6` replenishment policy lives in the **agent**, not in a tool; the
  server stays a thin, auditable data + authz layer.
- Terminal states per case: **order raised / no order needed / failed-safe**
  (no creds → refuse; key rotated → reload+retry; StoreLink error → fail clearly).
