# secrets/

Per-store StoreLink API keys, one file per store: `store-<id>.key`.
Each key is scoped to a single store and sent as the `X-Korral-Store-Key`
header on every StoreLink request.

- Real `.key` files are **git-ignored** (never committed).
- `.key.example` files show the format and let you run the demo locally:
  `cp store-47.key.example store-47.key` (already done in this workspace).
- **No key file for a store = the server refuses to serve it.** This is the
  "no creds → safe refusal" behaviour (store 55 has no key on purpose).
- **Prod:** these are provisioned via **GCP Secret Manager** and mounted at
  runtime — not baked into the image. See `DEPLOYMENT.md`.
