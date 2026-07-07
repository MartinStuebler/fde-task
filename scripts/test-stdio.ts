// stdio protocol guard test. Pipes initialize + tools/list into a target and
// asserts (1) the FIRST stdout line parses as JSON and (2) tools/list returns
// tools. Runs against BOTH the node server and the docker container.
import { spawn } from "node:child_process";

const INIT = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
});
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });

function run(label: string, cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    let firstLineIsJSON: boolean | null = null;
    let toolsListed = false;
    const timer = setTimeout(() => { child.kill(); }, 20000);

    child.stdout.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n").filter((l) => l.trim());
      if (firstLineIsJSON === null && lines.length >= 1) {
        try { JSON.parse(lines[0]); firstLineIsJSON = true; } catch { firstLineIsJSON = false; }
      }
      for (const l of lines) {
        try { const m = JSON.parse(l); if (m.id === 2 && m.result?.tools?.length) toolsListed = true; } catch { /* ignore */ }
      }
      if (toolsListed) { clearTimeout(timer); child.kill(); }
    });

    child.on("close", () => {
      clearTimeout(timer);
      const pass = firstLineIsJSON === true && toolsListed;
      console.log(`${pass ? "PASS" : "FAIL"} [${label}]  firstLineIsJSON=${firstLineIsJSON}  toolsListed=${toolsListed}`);
      resolve(pass);
    });
    child.on("error", (e) => { console.log(`FAIL [${label}]  spawn error: ${e.message}`); resolve(false); });

    child.stdin.write(INIT + "\n");
    child.stdin.write(LIST + "\n");
  });
}

const results: boolean[] = [];
results.push(await run("node", "tsx", ["src/server.ts"]));
results.push(await run("docker", "docker", ["run", "--rm", "-i", "fde-task"]));
process.exit(results.every(Boolean) ? 0 : 1);
