import { VERSION } from "./protocol.js";

const REPOSITORY = "https://github.com/guilhermegm/browser-profile-mcp";

// Shared by the setup CLI and side panel. These values contain no credentials.
export function setupMetadata(value) {
  const path = (text) => typeof text === "string" && text.length > 0 && text.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/.test(text);
  if (!value || !path(value.node) || !path(value.launcher) || typeof value.platform !== "string") return undefined;
  return { node: value.node, launcher: value.launcher, platform: value.platform === "win32" ? "win32" : "posix" };
}

export function profileSetupCommand(id, port, reset = false) {
  return `npm run profile -- ${id} --port ${port}${reset ? " --reset" : ""}`;
}

export function agentSetup(id, port, metadata) {
  const setup = setupMetadata(metadata);
  if (!setup) return undefined;
  const quote = setup.platform === "win32"
    ? (value) => `'${value.replace(/'/g, "''")}'`
    : (value) => `'${value.replace(/'/g, "'\\''")}'`;
  const launcher = [setup.node, setup.launcher, id, "--port", String(port)].map(quote).join(" ");
  const server = `browser-${id}`;
  return {
    server,
    terminal: setup.platform === "win32" ? "PowerShell" : "a terminal",
    codex: `codex mcp add ${server} -- ${launcher}`,
    claudeLocal: `claude mcp add --transport stdio --scope local ${server} -- ${launcher}`,
    claudeUser: `claude mcp add --transport stdio --scope user ${server} -- ${launcher}`,
    codexConfig: `[mcp_servers.${server}]\ncommand = ${JSON.stringify(setup.node)}\nargs = ${JSON.stringify([setup.launcher, id, "--port", String(port)])}\nstartup_timeout_sec = 20\ntool_timeout_sec = 60`,
  };
}

export function firstTask(id) {
  return `Use browser-${id} MCP to list my open tabs. Report the profile name and tab titles only. Do not open, navigate, or change any tabs.`;
}

export function bootstrapPrompt({ extensionId, profileId = 'work', installationId, os } = {}) {
  if (!/^[a-p]{32}$/.test(extensionId || '')) throw new Error('The extension identity is not available yet.');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profileId)) throw new Error('Use 1–40 lowercase letters, numbers, or hyphens, starting with a letter or number.');
  const folders = os === 'win' ? "%LOCALAPPDATA%\\Google\\Chrome\\User Data"
    : os === 'mac' ? '~/Library/Application Support/Google/Chrome'
    : ['linux', 'cros', 'openbsd'].includes(os) ? '~/.config/google-chrome' : "this computer's Chrome user-data directory";
  const identity = /^[a-f0-9-]{36}$/.test(installationId || '') ? ` This extension installation is ${installationId}.` : '';
  const release = `${REPOSITORY}/releases/download/v${VERSION}`;
  return `Set up Browser Profile MCP so you can control my existing Chrome profile named "${profileId}" from the coding-agent client I am using now. Do the setup with your terminal/file tools.${identity}

Official source: ${REPOSITORY}. Reuse an existing Browser Profile MCP helper registered with this client. Otherwise download ${release}/browser-profile-mcp-bridge-v${VERSION}.zip and ${release}/SHA256SUMS, verify the ZIP's SHA-256 checksum, and extract it into a stable user-writable installation location. It contains source code and dependency manifests; Node.js 20+ is required. Do not invent an npm package or use a third-party download.

The same helper source is bundled inside my installed Chrome extension, ID ${extensionId}, in its local-helper/ folder. If the release download is unavailable, locate it under ${folders} (Default/Extensions or Profile*/Extensions). For an unpacked installation, use the path recorded for this extension ID in Chrome's extension installation metadata. If this repository is already open, use extension/local-helper/. Copy the complete helper folder into a stable installation location before using it. Read only the extension metadata needed to locate it; do not inspect cookies, history, or page data.

Preserve existing pairings and client configuration. Check Node.js 20+ and npm; help install them if missing. In the helper folder run npm ci --omit=dev --ignore-scripts. Prefer an existing pairing bound to this extension installation; otherwise create one with node bridge.js profile ${profileId}. If that name is bound to a different installation, choose an unused name; never reset it. If its port is occupied by another app/checkout, choose a free port with --port and retain it in the registration.

Register the printed stdio launcher once in this client's user-level MCP configuration so it works across my projects on this computer. Use absolute helper paths. Preserve unrelated configuration and update an existing matching entry instead of creating duplicates. Migrate a matching project-local entry if needed so it does not override the new registration. Return the pairing code clearly for me to paste into the extension, the actual browser-<name> server name, and whether I need a new agent session. Do not ask me to choose a configuration scope, locate a project folder, or manually assemble commands. Do not launch another Chrome, run browser tests, or access my tabs during setup. After I paste the code, I will ask you to list my tabs.`;
}
