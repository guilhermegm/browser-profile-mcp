import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { BRIDGE_FILE, STATE, PROTOCOL_VERSIONS, SLUG, getPort, readProfile } from "./settings.js";
import { VERSION, COMMAND_PROTOCOL } from "./extension/protocol.js";
import { SecureMcpTransport } from "./secure-transport.js";

// Stdout belongs exclusively to MCP. Background bridge output goes to its log file.
let remote;
let transport;
let local;
let heartbeat;
let stopping = false;

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(heartbeat);
  const deadline = setTimeout(() => process.exit(code), 2000);
  try {
    await Promise.allSettled([remote?.close(), local?.close()]);
  } finally {
    clearTimeout(deadline);
    process.exit(code);
  }
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
process.stdin.once("end", () => void stop());
process.stdin.once("close", () => void stop());

async function ensureBridge(port) {
  const base = `http://127.0.0.1:${port}`;
  async function running() {
    let response;
    try { response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(750), redirect: "error" }); }
    catch { return false; }
    let info;
    try { info = await response.json(); } catch {}
    if (!response.ok || info?.app !== "profile-browser-mcp" || info.stateDirectory !== STATE) {
      throw new Error(`Port ${port} belongs to another app, an older bridge, or another checkout. Stop the previous bridge once, or generate a pairing with a different BROWSER_MCP_PORT.`);
    }
    // These artwork-only releases have identical bridge runtimes. A second
    // agent can reuse their authenticated connection without interrupting the
    // first. Keep exceptions tied to this launcher release: a future update
    // must review compatibility rather than silently accepting older runtimes.
    const compatibleArtworkRelease = VERSION === "0.5.3" && ["0.5.1", "0.5.2"].includes(info.version);
    if (info.protocol !== COMMAND_PROTOCOL || (info.version !== VERSION && !compatibleArtworkRelease)) {
      throw new Error("An incompatible Browser Profile MCP bridge is running. Stop its agent connections, let it exit, then reconnect to load the update.");
    }
    return true;
  }
  if (await running()) return;
  if (stopping) throw new Error("MCP launcher stopped.");
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const logPath = join(STATE, "bridge.log");
  const log = openSync(logPath, "a", 0o600);
  try {
    // Detached so one agent's exit cannot stop a bridge another profile is using.
    // The managed bridge shuts itself down after all launcher sessions are gone.
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BRIDGE_FILE, "--managed"], {
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, BROWSER_MCP_PORT: String(port) },
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + 6000;
  while (!stopping && Date.now() < deadline) {
    if (await running()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Could not start the local bridge. See ${logPath}.`);
}

async function main() {
  const id = process.argv[2];
  const rest = process.argv.slice(3);
  if (!id || !SLUG.test(id) || (rest.length && (rest.length !== 2 || rest[0] !== "--port"))) {
    throw new Error("Usage: node mcp.js <profile> [--port <port>]");
  }
  const profile = readProfile(id);
  if (!profile) throw new Error(`Create this profile once with: npm run profile -- ${id}`);
  const port = getPort(rest.length ? rest[1] : process.env.BROWSER_MCP_PORT ?? profile.port ?? 9333);
  await ensureBridge(port);
  if (stopping) return;

  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent/${id}`, { maxPayload: 12 * 1024 * 1024 });
  transport = new SecureMcpTransport(socket, { role: "agent", profileId: id,
    identity: randomUUID(), secret: profile.agentToken });
  remote = new Client({ name: `browser-${id}-launcher`, version: VERSION }, {
    supportedProtocolVersions: PROTOCOL_VERSIONS,
    versionNegotiation: { mode: "legacy" },
  });
  await remote.connect(transport, { timeout: 6000 });
  if (stopping) return;

  local = new Server(remote.getServerVersion() || { name: `browser-${id}`, version: VERSION }, {
    capabilities: { tools: {} },
    supportedProtocolVersions: PROTOCOL_VERSIONS,
    instructions: remote.getInstructions(),
  });
  local.setRequestHandler("tools/list", (request) => remote.listTools(request.params));
  local.setRequestHandler("tools/call", (request, context) => remote.callTool(request.params, {
    timeout: 55_000,
    signal: context.mcpReq.signal,
  }));
  local.onclose = () => void stop();
  remote.onclose = () => {
    if (!stopping) console.error("Browser bridge disconnected. Reconnect this MCP server in your coding agent.");
    void stop(stopping ? 0 : 1);
  };
  await local.connect(new StdioServerTransport());
  if (stopping) return;

  // This keeps an idle but open coding-agent session alive on the shared bridge.
  let pinging = false;
  heartbeat = setInterval(() => {
    if (pinging || stopping) return;
    pinging = true;
    void remote.ping({ timeout: 5000 }).catch(() => {
      console.error("Browser bridge stopped responding. Reconnect this MCP server in your coding agent.");
      void stop(1);
    }).finally(() => { pinging = false; });
  }, 20_000);
}

void main().catch((error) => {
  console.error(error.message);
  void stop(1);
});
