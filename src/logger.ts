import { appendFileSync } from "node:fs";

// Buyer-readable audit stream: plain-English, one line per action, to a file.
const AUDIT_FILE = process.env.AUDIT_LOG ?? "audit.log";

let seq = 0;
export function newRequestId(): string {
  seq += 1;
  return `req-${String(seq).padStart(4, "0")}`;
}

// FDE stream: structured JSON to stderr (stdout is reserved for the MCP protocol).
export function logEvent(evt: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...evt });
  process.stderr.write(line + "\n");
}

// Buyer stream: plain-English audit line, appended to a file AND mirrored to stderr.
export function audit(message: string): void {
  const line = `${new Date().toISOString()}  ${message}`;
  try {
    appendFileSync(AUDIT_FILE, line + "\n");
  } catch (err) {
    logEvent({ level: "error", msg: "audit_write_failed", error: String(err) });
  }
  logEvent({ level: "audit", audit: message });
}
