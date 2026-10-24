import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const STATE = fileURLToPath(new URL(".browser-mcp/", import.meta.url));
export const BRIDGE_FILE = fileURLToPath(new URL("bridge.js", import.meta.url));
export const LAUNCHER_FILE = fileURLToPath(new URL("mcp.js", import.meta.url));
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export function getPort(value = process.env.BROWSER_MCP_PORT || 9333) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The bridge port must be between 1 and 65535.");
  }
  return port;
}

export function readProfile(id) {
  if (typeof id !== "string" || !SLUG.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(join(STATE, `${id}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function saveProfile(profile) {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  const path = join(STATE, `${profile.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}
