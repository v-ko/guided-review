import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { createPageServer } from "./http.js";
import { serveMcp } from "./mcp.js";
import { Session } from "./session.js";

// stdout carries MCP messages only; everything else goes to stderr.
function log(line: string): void {
  process.stderr.write(line + "\n");
}

async function main(): Promise<void> {
  const root = path.resolve(__dirname, "../../..");
  const dir = path.resolve(
    process.env.LAYOUT_SUGGEST_DIR ??
      path.join(root, "experiments/layout-suggest/session"),
  );
  const port = Number(process.env.LAYOUT_SUGGEST_PORT ?? 8765);
  const session = new Session(dir);
  await session.start();
  const server = createPageServer(session, root, log);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const page = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  log(`Layout suggestions page: ${page}`);
  serveMcp(
    session,
    { page, document: session.documentPath },
    process.stdin,
    process.stdout,
    log,
  );
  process.stdin.on("end", () => process.exit(0));
}

main().catch((error: unknown) => {
  log(`Layout suggestions failed to start: ${String(error)}`);
  process.exit(1);
});
