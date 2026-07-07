import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./logger.js";

// ---------------------------------------------------------------------------
// StoreLink stub: stands in for Korral's real StoreLink system. In-memory,
// realistic fake data. Every call is authenticated with a per-store key via
// the X-Korral-Store-Key header, exactly as the real integration would be.
// ---------------------------------------------------------------------------

export class StoreLinkError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "StoreLinkError";
  }
}

export interface Store {
  store_id: string;
  name: string;
  city: string;
  timezone: string;
}

const STORES: Record<string, Store> = {
  "47": { store_id: "47", name: "Korral Praha-Smíchov", city: "Praha", timezone: "Europe/Prague" },
  "102": { store_id: "102", name: "Korral Brno-Královo Pole", city: "Brno", timezone: "Europe/Prague" },
  // Store 55 exists in StoreLink but the server has NO key on file -> refusal demo.
  "55": { store_id: "55", name: "Korral Ostrava-Poruba", city: "Ostrava", timezone: "Europe/Prague" },
};

export interface Sku {
  sku: string;
  name: string;
  supplier_id: string;
  unit: string;
}

const SKUS: Record<string, Sku> = {
  "8847291": { sku: "8847291", name: "Madeta Butter 250g", supplier_id: "SUP-MADETA", unit: "each" },
};

const SUPPLIERS: Record<string, { supplier_id: string; name: string; lead_time_days: number }> = {
  "SUP-MADETA": { supplier_id: "SUP-MADETA", name: "Madeta a.s.", lead_time_days: 2 },
};

// Seeded so store 47 runs empty (triggers order) and store 102 is well-stocked.
const ON_HAND: Record<string, Record<string, number>> = {
  "47": { "8847291": 4 },
  "102": { "8847291": 40 },
  "55": { "8847291": 10 },
};

const SALES_24H: Record<string, Record<string, number>> = {
  "47": { "8847291": 12 },
  "102": { "8847291": 3 },
  "55": { "8847291": 5 },
};

// ---------------------------------------------------------------------------
// Auth: StoreLink holds an "expected" key per store. Initialised from the same
// secrets dir the server reads, so they start in sync. A rotation changes both
// the expected key here AND the on-disk key file, leaving the server's cached
// copy stale -> next call gets a 401 -> server reloads + retries.
// ---------------------------------------------------------------------------

const SECRETS_DIR = process.env.SECRETS_DIR ?? "secrets";
const ROTATE_ON_STORE = process.env.ROTATE_ON_STORE ?? ""; // demo hook: rotate this store once

const expectedKey: Record<string, string> = {};
const rotated: Record<string, boolean> = {};

function keyPath(storeId: string): string {
  return join(SECRETS_DIR, `store-${storeId}.key`);
}

// Load whatever keys exist on disk at startup as StoreLink's expected keys.
for (const id of Object.keys(STORES)) {
  const p = keyPath(id);
  if (existsSync(p)) expectedKey[id] = readFileSync(p, "utf8").trim();
}

function authenticate(storeId: string, presentedKey: string): void {
  // One-shot rotation for the demo: first call to the target store rotates.
  if (ROTATE_ON_STORE === storeId && !rotated[storeId]) {
    rotated[storeId] = true;
    const fresh = `korral-${storeId}-rotated-${expectedKey[storeId]?.slice(-4) ?? "0000"}`;
    expectedKey[storeId] = fresh;
    try {
      // Rotate the secret in place so the server can reload the new value.
      writeFileSync(keyPath(storeId), fresh + "\n");
    } catch { /* best-effort */ }
    logEvent({ level: "warn", msg: "storelink_key_rotated", store_id: storeId });
    throw new StoreLinkError(401, `key rotated for store ${storeId}`);
  }
  if (!expectedKey[storeId]) {
    throw new StoreLinkError(404, `store ${storeId} not provisioned in StoreLink`);
  }
  if (presentedKey !== expectedKey[storeId]) {
    throw new StoreLinkError(401, `invalid or rotated key for store ${storeId}`);
  }
}

// Orders (the one write). Ids start at 123 to match the demo narrative.
interface Order {
  order_id: number;
  store_id: string;
  sku: string;
  quantity: number;
  status: "raised" | "acknowledged" | "shipped";
}
const orders: Record<number, Order> = {};
let nextOrderId = 123;

// --- StoreLink API surface (all require a valid store key) -----------------

export function listStores(): Store[] {
  return Object.values(STORES);
}

export function getStore(storeId: string, key: string): Store {
  authenticate(storeId, key);
  const s = STORES[storeId];
  if (!s) throw new StoreLinkError(404, `unknown store ${storeId}`);
  return s;
}

export function getInventory(storeId: string, sku: string, key: string): number {
  authenticate(storeId, key);
  return ON_HAND[storeId]?.[sku] ?? 0;
}

export function getRecentSales(storeId: string, sku: string, hours: number, key: string) {
  authenticate(storeId, key);
  // Summarised POS — never raw transactions.
  const base = SALES_24H[storeId]?.[sku] ?? 0;
  const units = Math.round((base * hours) / 24);
  return { store_id: storeId, sku, window_hours: hours, units_sold: units };
}

export function raiseReplenishment(storeId: string, sku: string, quantity: number, key: string): Order {
  authenticate(storeId, key);
  if (!SKUS[sku]) throw new StoreLinkError(404, `unknown sku ${sku}`);
  const order: Order = { order_id: nextOrderId++, store_id: storeId, sku, quantity, status: "raised" };
  orders[order.order_id] = order;
  return order;
}

export function getReplenishmentStatus(storeId: string, orderId: number, key: string): Order {
  authenticate(storeId, key);
  const o = orders[orderId];
  if (!o || o.store_id !== storeId) throw new StoreLinkError(404, `order ${orderId} not found for store ${storeId}`);
  return o;
}

export function getSku(sku: string): Sku {
  const s = SKUS[sku];
  if (!s) throw new StoreLinkError(404, `unknown sku ${sku}`);
  return s;
}

export function getSupplier(supplierId: string) {
  const s = SUPPLIERS[supplierId];
  if (!s) throw new StoreLinkError(404, `unknown supplier ${supplierId}`);
  return s;
}
