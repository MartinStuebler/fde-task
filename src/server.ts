import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import * as sl from "./storelink.js";
import { StoreLinkError } from "./storelink.js";
import { logEvent, audit, newRequestId } from "./logger.js";

const SECRETS_DIR = process.env.SECRETS_DIR ?? "secrets";

// --- Per-store key management ----------------------------------------------
// Keys are scoped to a single store and sent as X-Korral-Store-Key per request.
// Cached at first use; force-reloaded on a 401 (rotation).
const keyCache = new Map<string, string>();

function keyPath(storeId: string): string {
  return join(SECRETS_DIR, `store-${storeId}.key`);
}

function loadKey(storeId: string, force = false): string | null {
  if (!force && keyCache.has(storeId)) return keyCache.get(storeId)!;
  const p = keyPath(storeId);
  if (!existsSync(p)) return null; // no creds on file -> caller must refuse
  const key = readFileSync(p, "utf8").trim();
  keyCache.set(storeId, key);
  return key;
}

// Refusal surfaced when we hold no credentials for a store. Never guess a key.
class RefusalError extends Error {}

// Run a StoreLink call with the store key. On a 401 (rotation), reload the key
// once from the secret store and retry. If it still fails, fail clearly.
function withKey<T>(storeId: string, fn: (key: string) => T): T {
  const key = loadKey(storeId);
  if (!key) {
    throw new RefusalError(
      `No credentials on file for store ${storeId}. Refusing — a key must be provisioned (GCP Secret Manager) before this store can be served. Not guessing.`
    );
  }
  try {
    return fn(key);
  } catch (err) {
    if (err instanceof StoreLinkError && err.status === 401) {
      logEvent({ level: "warn", msg: "key_rotation_detected_reloading", store_id: storeId });
      const fresh = loadKey(storeId, true);
      if (!fresh) throw new RefusalError(`Store ${storeId} key rotated and no replacement is available. Failing safe.`);
      return fn(fresh); // single retry with rotated key
    }
    throw err;
  }
}

// --- Tool result helpers ----------------------------------------------------
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string): ToolResult => ({ content: [{ type: "text", text: msg }], isError: true });

// Wrap every tool with structured FDE logging + failed-safe error handling.
function tool<A extends Record<string, unknown>>(name: string, handler: (args: A) => ToolResult) {
  return (args: A): ToolResult => {
    const rid = newRequestId();
    logEvent({ level: "info", rid, tool: name, args, event: "start" });
    try {
      const res = handler(args);
      logEvent({ level: "info", rid, tool: name, event: "ok", isError: res.isError ?? false });
      return res;
    } catch (err) {
      const status = err instanceof StoreLinkError ? err.status : undefined;
      const msg =
        err instanceof RefusalError
          ? `REFUSED: ${err.message}`
          : `FAILED-SAFE: ${name} could not complete (${status ?? "error"}): ${(err as Error).message}`;
      logEvent({ level: "error", rid, tool: name, event: "fail", status, error: (err as Error).message });
      return fail(msg);
    }
  };
}

const server = new McpServer({ name: "korral-storelink", version: "1.0.0" });

// --- Core tools (sacred) ----------------------------------------------------
server.tool("list_stores", "List Korral stores reachable via StoreLink.", {},
  tool("list_stores", () => ok(sl.listStores())));

server.tool("get_store", "Get one store's profile.", { store_id: z.string() },
  tool("get_store", ({ store_id }) => withKey(store_id, (k) => ok(sl.getStore(store_id, k)))));

server.tool("get_inventory", "Get on-hand units for a SKU at a store.",
  { store_id: z.string(), sku: z.string() },
  tool("get_inventory", ({ store_id, sku }) =>
    withKey(store_id, (k) => ok({ store_id, sku, on_hand: sl.getInventory(store_id, sku, k) }))));

server.tool("get_recent_sales", "Get SUMMARISED POS sales for a SKU over the last N hours (not raw transactions).",
  { store_id: z.string(), sku: z.string(), hours: z.number().default(24) },
  tool("get_recent_sales", ({ store_id, sku, hours }) =>
    withKey(store_id, (k) => ok(sl.getRecentSales(store_id, sku, hours, k)))));

server.tool("raise_replenishment", "Raise a replenishment order (the one write). Loudly audited.",
  { store_id: z.string(), sku: z.string(), quantity: z.number().int().positive() },
  tool("raise_replenishment", ({ store_id, sku, quantity }) =>
    withKey(store_id, (k) => {
      const order = sl.raiseReplenishment(store_id, sku, quantity, k);
      // Compose a buyer-readable audit line with live context.
      const onHand = sl.getInventory(store_id, sku, k);
      const sold = sl.getRecentSales(store_id, sku, 24, k).units_sold;
      audit(`Store ${store_id}, SKU ${sku}: on-hand ${onHand}, sold ${sold} in 24h, raised order #${order.order_id} for ${quantity} units.`);
      return ok(order);
    })));

server.tool("get_replenishment_status", "Get the status of a previously raised replenishment order.",
  { store_id: z.string(), order_id: z.number().int() },
  tool("get_replenishment_status", ({ store_id, order_id }) =>
    withKey(store_id, (k) => ok(sl.getReplenishmentStatus(store_id, order_id, k)))));

// --- Droppable tools --------------------------------------------------------
server.tool("get_sku", "Look up SKU catalog metadata.", { sku: z.string() },
  tool("get_sku", ({ sku }) => ok(sl.getSku(sku))));

server.tool("get_supplier", "Look up supplier metadata.", { supplier_id: z.string() },
  tool("get_supplier", ({ supplier_id }) => ok(sl.getSupplier(supplier_id))));

// --- Boot -------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
logEvent({ level: "info", msg: "korral-storelink MCP server ready (stdio)", secrets_dir: SECRETS_DIR });
