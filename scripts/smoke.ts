// Smoke client: plays the Duvo agent WITHOUT an LLM. Launches the MCP server
// over stdio, runs the replenishment case for stores 47 and 102, applies the
// agent-side "gap > 6" rule, then shows the no-key refusal. Proves end-to-end.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const GAP_THRESHOLD = 6; // lives in the AGENT, not in a tool
const SKU = "8847291";

const child = spawn("tsx", ["src/server.ts"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: child.stdout });

let id = 0;
const pending = new Map<number, (v: any) => void>();
rl.on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
});

function rpc(method: string, params?: unknown): Promise<any> {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}
function notify(method: string, params?: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? "";
  const isError = res.result?.isError ?? false;
  return { text, isError };
}

function line(s: string) { console.log(s); }

async function runStore(storeId: string) {
  line(`\n=== Store ${storeId} — SKU ${SKU} ===`);
  const inv = await call("get_inventory", { store_id: storeId, sku: SKU });
  const sales = await call("get_recent_sales", { store_id: storeId, sku: SKU, hours: 24 });
  const onHand = JSON.parse(inv.text).on_hand;
  const sold = JSON.parse(sales.text).units_sold;
  const gap = sold - onHand; // agent's own math
  line(`on-hand=${onHand}  sold24h=${sold}  gap=${gap}  (threshold=${GAP_THRESHOLD})`);
  if (gap > GAP_THRESHOLD) {
    const order = await call("raise_replenishment", { store_id: storeId, sku: SKU, quantity: gap });
    line(`DECISION: order raised -> ${order.text.replace(/\n/g, " ")}`);
  } else {
    line(`DECISION: no order needed (gap ${gap} <= ${GAP_THRESHOLD}).`);
  }
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  notify("notifications/initialized");

  const tools = await rpc("tools/list");
  line(`Tools exposed: ${tools.result.tools.map((t: any) => t.name).join(", ")}`);

  await runStore("47");   // triggers an order
  await runStore("102");  // no order needed

  line(`\n=== Store 55 — no key on file (refusal demo) ===`);
  const refused = await call("get_inventory", { store_id: "55", sku: SKU });
  line(`isError=${refused.isError}  ${refused.text}`);

  child.kill();
  process.exit(0);
}

main();
