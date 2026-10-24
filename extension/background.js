import { extractContent, waitForQuiet, selectScope } from "./content.js";
import { renderAgentCursor } from "./cursor.js";
import { CommandScheduler } from "./scheduler.js";
import { COMMAND_PROTOCOL, commandLane, clipboardShortcut, usesClipboard } from "./protocol.js";
import { SecurePeer } from "./secure-channel.js";
import { bounded, CommandStopped } from "./deadline.js";
import { DebuggerSessions } from "./debugger.js";
import { collectAX, formatAX } from "./accessibility.js";
import { inspectTarget } from "./target.js";
import { setupMetadata } from "./onboarding.js";

let config;
let installationId;
let enabled = false;
let socket;
let securePeer;
let connected = false;
let agentCount;
let verifiedAgentCount;
let clipboardAllowed = false;
let status = "Name this profile to get started.";
let retryTimer;
let heartbeat;
let lastConnectionIssue;
let cleanup = Promise.resolve();
const scheduler = new CommandScheduler();
const idleTimers = new Map();
const snapshots = new Map();
const documents = new Map();
const dialogs = new Map();
const commands = new Map();
// A timed-out tabs/windows mutation can still finish inside Chrome. Keep its
// lane blocked until the original promise settles, even after reconnecting.
const mutations = new Set();
const cursorWorlds = new Map();
const helperWorlds = new Map();
const cursorPositions = new Map();
const documentKeys = new Map();
const documentRoots = new Map();
const documentGenerations = new Map();
const debuggerSessions = new DebuggerSessions(active, invalidateTab);
const DEBUGGER_IDLE_MS = 5000;
const platform = chrome.runtime.getPlatformInfo();
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
  console.error("Could not enable the side panel:", error.message);
});

function badge(text, color) {
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

function active(context) {
  if (context.signal.aborted) throw context.signal.reason || new CommandStopped("Command stopped. Inspect before retrying.");
  if (Date.now() >= context.deadline) throw new CommandStopped("Command deadline exceeded. Inspect the page before repeating an action.");
  if (!enabled || !connected || socket !== context.socket || context.socket.readyState !== WebSocket.OPEN) {
    throw new CommandStopped("Control was disconnected. Inspect the page before repeating an action.");
  }
}

function invalidateTab(tabId) {
  snapshots.delete(tabId);
  cursorWorlds.delete(tabId);
  helperWorlds.delete(tabId);
  documentKeys.delete(tabId);
  documentRoots.delete(tabId);
  documentGenerations.delete(tabId);
  documents.set(tabId, (documents.get(tabId) || 0) + 1);
  for (const command of commands.values()) command.validatedTabs.delete(tabId);
}

function tabBusy(tabId) {
  return [...commands.values()].some((command) => command.lane === "global" || command.tabId === tabId);
}

function clearIdle(lane, tabId) {
  if (lane === "global") { for (const timer of idleTimers.values()) clearTimeout(timer); idleTimers.clear(); }
  else if (tabId) { clearTimeout(idleTimers.get(tabId)); idleTimers.delete(tabId); }
}

function scheduleIdleDetach() {
  if (!connected) return;
  const current = socket;
  for (const tabId of debuggerSessions.attachedTabs()) {
    if (idleTimers.has(tabId) || tabBusy(tabId) || dialogs.has(tabId)) continue;
    idleTimers.set(tabId, setTimeout(() => {
      idleTimers.delete(tabId);
      void scheduler.run(`tab:${tabId}`, async () => {
        if (socket !== current || !connected || tabBusy(tabId) || dialogs.has(tabId)) return;
        await removeCursor(tabId);
        await debuggerSessions.release(tabId, { preserveRefs: true });
      }, { internal: true }).catch(() => {}).finally(scheduleIdleDetach);
    }, DEBUGGER_IDLE_MS));
  }
}

async function removeCursor(tabId) {
  const contextId = cursorWorlds.get(tabId);
  cursorWorlds.delete(tabId);
  if (!contextId || !debuggerSessions.isAttached(tabId)) return;
  await bounded(() => chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    contextId, expression: `(${renderAgentCursor.toString()})({action:"remove"})`, returnByValue: true,
  }), { timeoutMs: 200, label: "Cursor cleanup" }).catch(() => {});
}

async function detachAll({ preserveRefs = false } = {}) {
  const tabs = [...debuggerSessions.states.keys()];
  if (!preserveRefs) {
    snapshots.clear();
    documents.clear();
    documentKeys.clear();
    documentRoots.clear();
    documentGenerations.clear();
    cursorPositions.clear();
    helperWorlds.clear();
  }
  dialogs.clear();
  await Promise.allSettled(tabs.map(async (tabId) => {
    await removeCursor(tabId);
    await debuggerSessions.release(tabId, { preserveRefs });
  }));
}

function dropConnection(reason) {
  const priorCleanup = cleanup;
  clearTimeout(retryTimer);
  clearIdle("global");
  clearInterval(heartbeat);
  const previous = socket;
  socket = undefined;
  securePeer = undefined;
  connected = false;
  agentCount = undefined;
  verifiedAgentCount = undefined;
  for (const command of commands.values()) command.controller.abort(new CommandStopped("Control disconnected. Inspect before retrying."));
  status = reason;
  const closed = !previous || previous.readyState === WebSocket.CLOSED ? Promise.resolve() : new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    previous.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  previous?.close(1000, "Disconnected");
  cleanup = Promise.all([priorCleanup, scheduler.run("global", () => detachAll(), { internal: true }), closed]);
  badge("", "#7a827b");
}

function reconnectSoon() {
  clearTimeout(retryTimer);
  if (enabled) retryTimer = setTimeout(connect, 3000);
}

function updateAgents(message) {
  if (!Number.isInteger(message.agentCount) || message.agentCount < 0 || message.agentCount > 128 ||
      !Number.isInteger(message.verifiedAgentCount) || message.verifiedAgentCount < 0 ||
      message.verifiedAgentCount > message.agentCount) return;
  agentCount = message.agentCount;
  verifiedAgentCount = message.verifiedAgentCount;
}

function connectionStatus() {
  if (!connected) return status;
  if (agentCount === undefined) return "Browser connected. Check your agent connection below.";
  if (!agentCount) return "Browser connected. Start a coding agent to continue.";
  if (!verifiedAgentCount) return `${agentCount} agent session${agentCount === 1 ? " is" : "s are"} attached. List tabs to confirm access.`;
  return `Tab access confirmed for ${verifiedAgentCount} of ${agentCount} attached agent session${agentCount === 1 ? "" : "s"}.`;
}

async function connect() {
  await cleanup;
  // A close event can be delayed after sleep or a worker restart. Never let a
  // dead socket prevent alarms from re-establishing the connection.
  if (socket && socket.readyState >= WebSocket.CLOSING) dropConnection("Reconnecting to local bridge…");
  await cleanup;
  if (!enabled || !config || socket) return;
  status = "Connecting to local bridge…";
  const current = new WebSocket(`ws://127.0.0.1:${config.port}/extension`);
  let lastMessageAt = Date.now();
  socket = current;
  const timeout = setTimeout(() => {
    if (socket === current && !connected) current.close(4000, "Connection timed out");
  }, 8000);
  current.onopen = () => {
    if (socket !== current) return;
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      if (socket !== current || current.readyState !== WebSocket.OPEN || !peer.authenticated) return;
      if (Date.now() - lastMessageAt > 45_000) {
        noteConnectionIssue(4000, "The local bridge stopped responding. Reconnecting automatically.");
        dropConnection("Reconnecting to local bridge…");
        reconnectSoon();
        return;
      }
      // Messages keep the MV3 worker active even with the side panel closed.
      void peer.send({ type: "ping" }).catch(() => {});
      // Reset Chrome's extension activity timer too. This does not depend on
      // panel polling or an attached debugger, including after idle detach.
      void chrome.runtime.getPlatformInfo().catch(() => {});
    }, 20_000);
  };
  const peer = new SecurePeer(current, { credentials: { role: "extension", profileId: config.profileId,
    identity: installationId, secret: config.token }, onmessage: (message) => {
    if (socket !== current) return;
    lastMessageAt = Date.now();
    if (message.type === "ready") {
      if (message.protocol !== COMMAND_PROTOCOL) { current.close(4003, "Restart the browser MCP bridge to load the update"); return; }
      clearTimeout(timeout);
      connected = true;
      status = "Browser connected.";
      updateAgents(message);
      const setup = setupMetadata(message.setup);
      if (setup && JSON.stringify(config.setup) !== JSON.stringify(setup)) {
        config = { ...config, setup };
        void chrome.storage.local.set({ config });
      }
      badge("ON", "#325a42");
      void peer.send({ type: "clipboard_status", safe: [...debuggerSessions.states.values()]
        .every((state) => state.phase === "idle") }).catch(() => {});
    } else if (message.type === "agent_status" && connected) {
      updateAgents(message);
    } else if (message.type === "setup_error" && message.code === "pairing_in_use") {
      const reason = "This pairing is assigned to another Chrome profile. Create a different pairing, or move this pairing using the instructions below.";
      enabled = false;
      void chrome.storage.local.set({ enabled });
      noteConnectionIssue(4001, reason, "pairing_in_use");
      dropConnection(reason);
    } else if (message.type === "ping") {
      void peer.send({ type: "pong" }).catch(() => {});
    } else if (message.type === "cancel") {
      const command = commands.get(message.id);
      command?.controller.abort(new CommandStopped("Command cancelled. Inspect the page before retrying."));
    } else if (message.type === "session_closed") {
      for (const owners of snapshots.values()) owners.delete(message.owner);
      for (const command of commands.values()) {
        if (command.owner === message.owner) command.controller.abort(new CommandStopped("Agent session closed. Inspect before retrying."));
      }
    } else if (message.type === "command" && connected) {
      receiveCommand(message, current);
    }
  }, onerror: (error) => { if (socket === current) noteConnectionIssue(4003, error.message); } });
  securePeer = peer;
  current.onerror = () => {};
  current.onclose = (event) => {
    clearTimeout(timeout);
    if (socket !== current) return;
    noteConnectionIssue(event.code, event.reason || "Chrome closed the connection without a reason.");
    dropConnection(event.code === 1001 || !event.reason ? "Waiting for a coding agent. Setup is available below." : event.reason);
    // A prior socket can briefly remain registered after a worker restart.
    // Code 4002 is transient; retry without changing the saved enabled flag.
    if (event.code === 4001) {
      enabled = false;
      void chrome.storage.local.set({ enabled });
    }
    reconnectSoon();
  };
}

function noteConnectionIssue(code, reason, kind) {
  lastConnectionIssue = { at: new Date().toISOString(), code, reason, ...(kind ? { kind } : {}) };
  void chrome.storage.local.set({ lastConnectionIssue }).catch(() => {});
}

function receiveCommand(message, current) {
  const controller = new AbortController();
  const lane = commandLane(message.tool, message.args);
  const command = { socket: current, owner: message.owner, lane, tabId: message.args.tabId,
    controller, signal: controller.signal, pressed: new Map(), tabs: new Set(), generations: new Map(),
    recoverTabs: new Set(), validatedTabs: new Set(), deadline: Date.now() + Math.min(message.budgetMs || 45_000, 45_000) };
  const timer = setTimeout(() => controller.abort(new CommandStopped("Command deadline exceeded. Inspect before retrying.")),
    Math.max(0, command.deadline - Date.now()));
  clearIdle(lane, command.tabId);
  commands.set(message.id, command);
  const send = (response) => {
    if (socket === current && current.readyState === WebSocket.OPEN) {
      void securePeer.send({ type: "result", id: message.id, ...response }).catch(() => {});
    }
  };
  void scheduler.run(lane, async () => {
    command.started = true;
    let response;
    try {
      await chromeCall(command, () => cleanup, "Connection cleanup");
      active(command);
      checkRecovery(lane);
      const result = await execute(message.tool, message.args, command);
      if (result.ok !== false) active(command);
      response = { ok: true, result };
    } catch (error) { response = { ok: false, error: error instanceof CommandStopped
      ? `${error.message} An action may have partly completed; inspect the page before retrying.` : error.message }; }
    // Keep the scheduler slot until input cleanup and recovery are contained.
    const recovered = await finishCommand(command);
    if (!recovered) response = { ok: false,
      error: `${response.error || "Command stopped."} This tab is still recovering; no new actions will start on it until cleanup is confirmed. Reload the extension if recovery does not finish.` };
    return { ...response, recovered };
  }, { signal: command.signal }).then(send, (error) => send({ ok: false, error: error.message, recovered: !command.started }))
    .finally(() => { clearTimeout(timer); commands.delete(message.id); scheduleIdleDetach(); });
}

async function finishCommand(context) {
  const releases = [...context.pressed.values()].filter((release) => debuggerSessions.owns(release.tabId, context));
  const released = await Promise.allSettled(releases.map((release) => bounded(() =>
    chrome.debugger.sendCommand({ tabId: release.tabId }, release.method, release.params),
  { timeoutMs: 250, label: "Input release" })));
  released.forEach((result, index) => { if (result.status === "rejected") context.recoverTabs.add(releases[index].tabId); });
  if (context.signal.aborted) for (const tabId of context.tabs) context.recoverTabs.add(tabId);
  const recovered = await Promise.all([...context.recoverTabs].map((tabId) => debuggerSessions.release(tabId)));
  return recovered.every(Boolean);
}

function checkRecovery(lane) {
  if (lane === "metadata") return;
  for (const mutation of mutations) {
    if (lane === "global" || mutation.lane === "global" || mutation.lane === lane) {
      throw new Error("A previous Chrome tab/window change is still settling. No action started; wait before retrying.");
    }
  }
  for (const [tabId, state] of debuggerSessions.states) {
    if (!["idle", "attached"].includes(state.phase) && (lane === "global" || lane === `tab:${tabId}`)) {
      throw new Error("A tab is still recovering from a stopped command. No action started; wait or reload the extension.");
    }
  }
}

async function chromeCall(context, operation, label = "Chrome API", timeoutMs = 10_000, mutates = false) {
  active(context);
  try {
    const result = await bounded(() => {
      const pending = Promise.resolve(operation());
      if (mutates) {
        const mutation = { lane: context.lane };
        mutations.add(mutation);
        void pending.then(() => mutations.delete(mutation), () => mutations.delete(mutation));
      }
      return pending;
    }, { signal: context.signal, timeoutMs: Math.min(timeoutMs, context.deadline - Date.now()), label });
    active(context);
    return result;
  } catch (error) {
    if (error instanceof CommandStopped) context.controller.abort(error);
    throw error;
  }
}

function chromeMutation(context, operation, label) {
  return chromeCall(context, operation, label, 10_000, true);
}

function pairing(code) {
  let result;
  try {
    if (code.length > 16384) throw new Error("Pairing code is too long.");
    const input = code.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(input.padEnd(Math.ceil(input.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
    result = JSON.parse(new TextDecoder().decode(bytes));
  } catch { throw new Error("Invalid pairing code. Copy the full code from npm run profile -- <name>."); }
  if (result.version !== 1 || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(result.profileId) ||
      !/^[a-f0-9]{64}$/.test(result.token) || typeof result.name !== "string" || result.name.length > 80 ||
      !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error("This pairing code is invalid or uses an unsupported version.");
  }
  return { profileId: result.profileId, name: result.name, port: result.port, token: result.token,
    ...(setupMetadata(result.setup) ? { setup: setupMetadata(result.setup) } : {}) };
}

const initialized = (async () => {
  const stored = await chrome.storage.local.get(["config", "installationId", "enabled", "lastConnectionIssue", "clipboardAllowed"]);
  installationId = stored.installationId || crypto.randomUUID();
  config = stored.config;
  enabled = Boolean(stored.enabled && config);
  lastConnectionIssue = stored.lastConnectionIssue;
  clipboardAllowed = stored.clipboardAllowed === true;
  await chrome.storage.local.set({ installationId });
  await chrome.alarms.create("reconnect", { periodInMinutes: 1 });
  if (config) status = lastConnectionIssue?.kind === "pairing_in_use" && !enabled
    ? lastConnectionIssue.reason : "Connection paused. Click Connect to resume.";
  connect();
})();

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // The side panel is the sole control surface; page/content-script messages are refused.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("sidepanel.html")) return;
  void (async () => {
    await initialized;
    if (message.type === "pair") {
      const next = pairing(message.code);
      dropConnection("Pairing…");
      if (config?.profileId !== next.profileId || config?.token !== next.token) clipboardAllowed = false;
      config = next;
      enabled = true;
      lastConnectionIssue = undefined;
      await chrome.storage.local.remove("lastConnectionIssue");
      await chrome.storage.local.set({ config, enabled, clipboardAllowed });
      connect();
    } else if (message.type === "toggle") {
      enabled = !enabled && Boolean(config);
      await chrome.storage.local.set({ enabled });
      if (enabled) connect();
      else dropConnection("Connection paused. Click Connect to resume.");
    } else if (message.type === "reconnect") {
      if (!config) throw new Error("Paste your pairing code first.");
      enabled = true;
      await chrome.storage.local.set({ enabled });
      dropConnection("Reconnecting…");
      await cleanup;
      connect();
    } else if (message.type === "forget") {
      enabled = false;
      dropConnection("Name this profile to get started.");
      config = undefined;
      clipboardAllowed = false;
      lastConnectionIssue = undefined;
      await chrome.storage.local.remove(["config", "lastConnectionIssue"]);
      await chrome.storage.local.set({ enabled, clipboardAllowed });
    } else if (message.type === "release") {
      dropConnection("Stopping current actions…");
      await cleanup;
      connect();
    } else if (message.type === "clipboard") {
      if (!config || typeof message.allowed !== "boolean") throw new Error("Pair a profile before changing clipboard shortcuts.");
      clipboardAllowed = message.allowed;
      await chrome.storage.local.set({ clipboardAllowed });
    } else if (message.type !== "status") {
      throw new Error("Unknown side panel command.");
    }
    return { ok: true, paired: Boolean(config), profileId: config?.profileId, name: config?.name,
      installationId, os: (await platform).os,
      port: config?.port, setup: config?.setup, enabled, connected, status: connectionStatus(),
      agentCount, verifiedAgentCount, pairingIssue: lastConnectionIssue?.kind === "pairing_in_use", lastConnectionIssue, clipboardAllowed };
  })().then(respond, (error) => respond({ ok: false, error: error.message }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") void initialized.then(connect);
});
// Explicit startup/install events wake the worker without opening any UI.
chrome.runtime.onStartup.addListener(() => { void initialized.then(connect); });
chrome.runtime.onInstalled.addListener(() => { void initialized.then(connect); });
chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  const wasAttached = debuggerSessions.forget(tabId);
  dialogs.delete(tabId);
  if (wasAttached && reason === "canceled_by_user" && enabled) {
    enabled = false;
    void chrome.storage.local.set({ enabled });
    dropConnection("Control stopped in Chrome. Click Connect to resume.");
  }
});
chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const withinMainDocument = method === "Page.navigatedWithinDocument" &&
    documentKeys.get(tabId)?.startsWith(`${params.frameId}:`);
  if (method === "DOM.documentUpdated" || withinMainDocument ||
      (method === "Page.frameNavigated" && !params.frame.parentId)) {
    // Enabling DOM after a reattach emits an initial update. Validate the actual
    // document identity in attach() before deciding whether saved refs expired.
    if (!debuggerSessions.initializing(tabId)) invalidateTab(tabId);
  }
  if (method === "Page.javascriptDialogOpening") dialogs.set(tabId, params);
  if (method === "Page.javascriptDialogClosed") {
    dialogs.delete(tabId);
    scheduleIdleDetach();
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Page events are unavailable while the debugger is idle. Invalidate saved
  // refs on manual navigation, including SPA URL changes during that gap.
  if ((documentKeys.has(tabId) || snapshots.has(tabId)) && (change.status === "loading" || change.url)) {
    invalidateTab(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerSessions.forget(tabId);
  debuggerSessions.states.delete(tabId);
  clearTimeout(idleTimers.get(tabId)); idleTimers.delete(tabId);
  cursorWorlds.delete(tabId);
  helperWorlds.delete(tabId);
  cursorPositions.delete(tabId);
  documentKeys.delete(tabId);
  documentRoots.delete(tabId);
  documentGenerations.delete(tabId);
  snapshots.delete(tabId);
  documents.delete(tabId);
  dialogs.delete(tabId);
});

function pageUrl(value, allowBlank = false) {
  if (allowBlank && value === "about:blank") return value;
  let url;
  try { url = new URL(value); } catch { throw new Error("Provide a complete http:// or https:// URL."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) web pages can be controlled.");
  return url.href;
}

function tabInfo(tab) {
  const url = tab.pendingUrl || tab.url || "";
  return { tabId: tab.id, windowId: tab.windowId, title: tab.title || "", url, active: tab.active,
    loading: tab.status === "loading", controllable: /^(https?:\/\/|about:blank$)/.test(url) &&
      !/^https?:\/\/(chromewebstore\.google\.com(?:\/|$)|chrome\.google\.com\/webstore(?:\/|$))/.test(url) };
}

async function ownTab(tabId, context) {
  if (!Number.isInteger(tabId) || tabId < 1) throw new Error("Provide a tabId returned by tabs.");
  const tab = (await chromeCall(context, () => chrome.tabs.query({}), "Tab lookup")).find((item) => item.id === tabId && !item.incognito);
  if (!tab) throw new Error("That tab is closed or does not belong to this Chrome profile.");
  context.tabs.add(tabId);
  return tab;
}

async function cdp(tabId, method, params, context, timeoutMs) {
  active(context);
  let inputKey;
  if (method === "Input.dispatchMouseEvent" && ["mousePressed", "mouseReleased"].includes(params.type)) {
    inputKey = `mouse:${params.button}`;
    if (params.type === "mousePressed") context.pressed.set(inputKey, { tabId, method,
      params: { ...params, type: "mouseReleased", buttons: 0 } });
  }
  if (method === "Input.dispatchKeyEvent" && ["keyDown", "rawKeyDown", "keyUp"].includes(params.type)) {
    inputKey = `key:${params.code || params.key}`;
    if (params.type !== "keyUp") context.pressed.set(inputKey, { tabId, method,
      params: { type: "keyUp", key: params.key, code: params.code,
        modifiers: params.modifiers, windowsVirtualKeyCode: params.windowsVirtualKeyCode } });
  }
  const result = await debuggerSessions.command(tabId, method, params, context, timeoutMs);
  if (inputKey && ["mouseReleased", "keyUp"].includes(params.type)) context.pressed.delete(inputKey);
  active(context);
  return result;
}

async function attach(tabId, context) {
  await debuggerSessions.attach(tabId, context);
  // Dialog tracking is needed even for coordinate actions and lightweight reads.
  // DOM and Accessibility remain lazy; Page events are inexpensive and shared.
  await debuggerSessions.enable(tabId, ["Page"], context);
}

async function isolatedWorld(tabId, context) {
  const generation = debuggerSessions.state(tabId).generation;
  const cached = helperWorlds.get(tabId);
  if (cached?.generation === generation) return cached.id;
  const { frameTree } = await cdp(tabId, "Page.getFrameTree", {}, context);
  const { executionContextId } = await cdp(tabId, "Page.createIsolatedWorld", {
    frameId: frameTree.frame.id, worldName: "profile-browser-mcp-helpers",
  }, context);
  helperWorlds.set(tabId, { id: executionContextId, generation });
  return executionContextId;
}

async function resolveIsolatedNode(tabId, backendNodeId, context) {
  return cdp(tabId, "DOM.resolveNode", { backendNodeId,
    executionContextId: await isolatedWorld(tabId, context) }, context);
}

async function rememberDocument(tabId, context) {
  const generation = debuggerSessions.state(tabId).generation;
  if (documentKeys.has(tabId) && documentGenerations.get(tabId) === generation) {
    context.validatedTabs.add(tabId);
    return;
  }
  await debuggerSessions.enable(tabId, ["Page", "DOM"], context);
  // Backend DOM IDs survive a CDP detach while their nodes live. Check the
  // loader and document too, since another renderer can reuse numeric IDs.
  const [{ root }, { frameTree }] = await Promise.all([
    cdp(tabId, "DOM.getDocument", { depth: 0 }, context),
    cdp(tabId, "Page.getFrameTree", {}, context),
  ]);
  const key = `${frameTree.frame.id}:${frameTree.frame.loaderId}:${root.backendNodeId}`;
  if (documentKeys.get(tabId) !== key) invalidateTab(tabId);
  documentKeys.set(tabId, key);
  documentRoots.set(tabId, root.backendNodeId);
  documentGenerations.set(tabId, generation);
  context.validatedTabs.add(tabId);
}

async function waitForLoad(tabId, context) {
  // Loading is bounded; SPAs and streaming pages may never reach 'complete'.
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    active(context);
    const tab = await ownTab(tabId, context);
    if (tab.status === "complete") return tabInfo(tab);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return { ...tabInfo(await ownTab(tabId, context)), note: "Page is still loading. Take a fresh snapshot when needed." };
}

async function nodeFor(tabId, ref, context) {
  await rememberDocument(tabId, context);
  const node = snapshots.get(tabId)?.get(context.owner)?.get(ref);
  if (!node) throw new Error("Unknown or expired element ref. Take a fresh snapshot of this tab.");
  return node;
}

function saveRefs(tabId, owner, refs, append = false) {
  if (!snapshots.has(tabId)) snapshots.set(tabId, new Map());
  const owners = snapshots.get(tabId);
  const previous = append ? owners.get(owner) || new Map() : new Map();
  if (previous.size + refs.size > 4096) throw new Error("Element ref budget reached. Take a fresh scoped snapshot.");
  for (const [ref, node] of refs) previous.set(ref, node);
  owners.delete(owner);
  owners.set(owner, previous);
  if (owners.size > 128) owners.delete(owners.keys().next().value);
}

async function scopeNode(tabId, options, context) {
  if (options.ref && options.selector) throw new Error("Choose either a scope selector or ref.");
  if (options.ref) return nodeFor(tabId, options.ref, context);
  if (!options.selector) return documentRoots.get(tabId);
  let objectId;
  try {
    const evaluated = await cdp(tabId, "Runtime.evaluate", {
      contextId: await isolatedWorld(tabId, context),
      expression: `(${selectScope.toString()})(${JSON.stringify(options.selector)})`, returnByValue: false,
    }, context);
    if (evaluated.exceptionDetails || !evaluated.result.objectId) {
      throw new Error(evaluated.exceptionDetails?.exception?.description || "Could not resolve the scope selector.");
    }
    objectId = evaluated.result.objectId;
    return (await cdp(tabId, "DOM.describeNode", { objectId, depth: 0 }, context)).node.backendNodeId;
  } finally {
    if (objectId) await cdp(tabId, "Runtime.releaseObject", { objectId }, context).catch(() => {});
  }
}

async function snapshot(tabId, options, context) {
  await rememberDocument(tabId, context);
  await debuggerSessions.enable(tabId, ["Accessibility"], context);
  const version = documents.get(tabId) || 0;
  const backendNodeId = options.selector || options.ref ? await scopeNode(tabId, options, context) : undefined;
  const acquired = await collectAX((method, params) => cdp(tabId, method, params, context),
    { backendNodeId, maxNodes: options.maxNodes || 300, maxDepth: options.maxDepth || 24 });
  if ((documents.get(tabId) || 0) !== version) throw new Error("The page navigated while reading. Take another snapshot.");
  const formatted = formatAX(acquired.nodes, { maxNodes: options.maxNodes || 300, compact: options.compact !== false });
  saveRefs(tabId, context.owner, formatted.refs);
  return { ...tabInfo(await ownTab(tabId, context)), snapshot: formatted.snapshot, compact: options.compact !== false,
    truncated: acquired.truncated || formatted.truncated, acquisition: acquired.acquisition,
    scope: options.selector || options.ref || "document",
    note: "Refs replace only your session's refs on this tab. Navigation/recovery invalidates them. If truncated, scope more narrowly or use find. Frames/canvas may need screenshots." };
}

async function find(tabId, options, context) {
  if (!options.name && !options.role) throw new Error("Provide an exact accessible name or role.");
  await rememberDocument(tabId, context);
  await debuggerSessions.enable(tabId, ["Accessibility"], context);
  const version = documents.get(tabId) || 0;
  const backendNodeId = await scopeNode(tabId, options, context);
  const { nodes } = await cdp(tabId, "Accessibility.queryAXTree", {
    backendNodeId, ...(options.name ? { accessibleName: options.name } : {}), ...(options.role ? { role: options.role } : {}),
  }, context);
  if ((documents.get(tabId) || 0) !== version) throw new Error("The page navigated while searching. Search again.");
  const matches = nodes.filter((node) => !node.ignored && node.backendDOMNodeId);
  const maxResults = options.maxResults || 20;
  const formatted = formatAX(matches.slice(0, maxResults), { flat: true, maxNodes: maxResults });
  saveRefs(tabId, context.owner, formatted.refs, true);
  return { ...tabInfo(await ownTab(tabId, context)), snapshot: formatted.snapshot, matches: formatted.refs.size,
    totalMatches: matches.length, truncated: matches.length > maxResults || formatted.truncated,
    note: "Find adds these refs to your session's existing refs for this tab. Prefer exact names and a narrow scope for large pages." };
}

async function readContent(tabId, options, context) {
  if (options.selector && options.ref) throw new Error("Choose either a content selector or ref.");
  const version = documents.get(tabId) || 0;
  let objectId;
  let result;
  try {
    if (options.ref) {
      const { object } = await resolveIsolatedNode(tabId, await nodeFor(tabId, options.ref, context), context);
      objectId = object.objectId;
      result = await cdp(tabId, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: extractContent.toString(), arguments: [{ value: options }], returnByValue: true,
      }, context);
    } else {
      result = await cdp(tabId, "Runtime.evaluate", {
        contextId: await isolatedWorld(tabId, context),
        expression: `(${extractContent.toString()})(${JSON.stringify(options)})`, returnByValue: true,
      }, context);
    }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Could not read page content.");
    if ((documents.get(tabId) || 0) !== version) throw new Error("The page navigated while reading. Read it again.");
    return { ...tabInfo(await ownTab(tabId, context)), ...result.result.value };
  } finally {
    if (objectId && socket === context.socket) {
      await cdp(tabId, "Runtime.releaseObject", { objectId }, context).catch(() => {});
    }
  }
}

async function observe(tabId, options, context) {
  if (dialogs.has(tabId)) throw new Error("A page dialog is open. Use act with action 'dialog' before reading.");
  let settled = null;
  const settleMs = Math.min(options.settleMs ?? 800, Math.max(0, context.deadline - Date.now() - 500));
  if (settleMs > 0) {
    try {
      const result = await cdp(tabId, "Runtime.evaluate", {
        contextId: await isolatedWorld(tabId, context),
        expression: `(${waitForQuiet.toString()})(${settleMs}, ${JSON.stringify(options.selector || null)})`, awaitPromise: true, returnByValue: true,
      }, context, settleMs + 250);
      settled = !result.exceptionDetails && result.result.value === true;
    } catch {
      // Navigation can destroy the execution context while the observer is running.
      active(context);
      settled = false;
    }
  }
  const content = options.mode === "snapshot"
    ? await snapshot(tabId, options, context)
    : await readContent(tabId, options, context);
  return { ...content, settled };
}

async function viewport(tabId, context) {
  const metrics = await cdp(tabId, "Page.getLayoutMetrics", {}, context);
  return metrics.cssVisualViewport || metrics.visualViewport;
}

async function showCursor(tabId, position, action, context) {
  active(context);
  try {
    let contextId = cursorWorlds.get(tabId);
    if (!contextId) {
      const { frameTree } = await cdp(tabId, "Page.getFrameTree", {}, context);
      const world = await cdp(tabId, "Page.createIsolatedWorld", {
        frameId: frameTree.frame.id, worldName: "profile-browser-mcp-cursor",
      }, context);
      contextId = world.executionContextId;
      cursorWorlds.set(tabId, contextId);
    }
    const render = async (phase) => {
      const options = { action: phase, ...position, from: cursorPositions.get(tabId),
        maxDurationMs: Math.max(0, Math.min(500, context.deadline - Date.now() - 150)) };
      const result = await cdp(tabId, "Runtime.evaluate", {
        contextId, expression: `(${renderAgentCursor.toString()})(${JSON.stringify(options)})`, returnByValue: true,
      }, context);
      if (result.exceptionDetails) throw new Error("Could not render the agent cursor.");
      return result.result.value;
    };
    if (action === "click") { await render("click"); return; }
    const movement = await render("move");
    const durationMs = Math.max(0, Math.min(500, movement?.durationMs || 0));
    // Let the user follow the pointer before dispatching the real input. A worker
    // timer keeps this bounded even if the page becomes hidden during the glide.
    if (durationMs) await new Promise((resolve) => setTimeout(resolve, durationMs));
    active(context);
    cursorPositions.set(tabId, { ...position });
  } catch {
    // A failed overlay must not replay input; cancellation still stops the action.
    cursorWorlds.delete(tabId);
    active(context);
  }
}

async function coordinatePoint(tabId, args, context) {
  const view = await viewport(tabId, context);
  const x = args.x ?? (args.action === "scroll" ? view.clientWidth / 2 : undefined);
  const y = args.y ?? (args.action === "scroll" ? view.clientHeight / 2 : undefined);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= view.clientWidth || y >= view.clientHeight) {
    throw new Error(`Provide a ref or viewport coordinates: x between 0 and ${view.clientWidth}, y between 0 and ${view.clientHeight}, in CSS pixels.`);
  }
  return { x, y };
}

async function withPointer(tabId, args, context, operation) {
  if (!args.ref) {
    const position = await coordinatePoint(tabId, args, context);
    await showCursor(tabId, position, "move", context);
    return operation(position);
  }
  const backendNodeId = await nodeFor(tabId, args.ref, context);
  let objectId;
  try {
    const { object } = await resolveIsolatedNode(tabId, backendNodeId, context);
    objectId = object.objectId;
    const inspect = async () => {
      const result = await cdp(tabId, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: inspectTarget.toString(), returnByValue: true,
      }, context);
      const target = result.result.value;
      if (result.exceptionDetails || target?.error || !target?.point) {
        throw new Error(target?.error || "The target changed. Inspect the page again.");
      }
      return target;
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, context);
      const before = await inspect();
      await showCursor(tabId, before.point, "move", context);
      const after = await inspect();
      if (Math.hypot(before.point.x - after.point.x, before.point.y - after.point.y) > 1) continue;
      if (!after.hit) throw new Error("Another element covers the target. No click was sent; inspect the page again.");
      // Same live node, fresh geometry, and a hit test after the visible glide.
      const verify = async () => {
        const latest = await inspect();
        if (!latest.hit || Math.hypot(latest.point.x - after.point.x, latest.point.y - after.point.y) > 1) {
          throw new Error("The target changed after hovering. No click was sent; inspect the page again.");
        }
      };
      return await operation(after.point, verify);
    }
    throw new Error("The target kept moving. No click was sent; inspect the page again.");
  } finally {
    if (objectId) await cdp(tabId, "Runtime.releaseObject", { objectId }, context).catch(() => {});
  }
}

async function pressKey(tabId, shortcut, context) {
  if (typeof shortcut !== "string" || !shortcut) throw new Error("Provide key, for example Enter, Tab, or Mod+a.");
  if (clipboardShortcut(shortcut) && !clipboardAllowed) {
    throw new Error("System clipboard shortcuts are disabled. Enable 'Allow system clipboard shortcuts' in this profile's side panel first.");
  }
  const parts = shortcut.split("+");
  const os = (await chromeCall(context, () => platform, "Platform info")).os;
  let key = parts.pop();
  let modifiers = 0;
  for (let modifier of parts) {
    modifier = modifier.toLowerCase();
    if (modifier === "mod") modifier = os === "mac" ? "meta" : "control";
    const bit = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 }[modifier];
    if (!bit) throw new Error(`Unknown key modifier: ${modifier}`);
    modifiers |= bit;
  }
  if ((modifiers & 8) && /^[a-z]$/.test(key)) key = key.toUpperCase();
  const special = {
    Enter: ["Enter", 13, "\r"], Tab: ["Tab", 9], Escape: ["Escape", 27],
    Backspace: ["Backspace", 8], Delete: ["Delete", 46],
    ArrowLeft: ["ArrowLeft", 37], ArrowUp: ["ArrowUp", 38], ArrowRight: ["ArrowRight", 39], ArrowDown: ["ArrowDown", 40],
    Home: ["Home", 36], End: ["End", 35], PageUp: ["PageUp", 33], PageDown: ["PageDown", 34],
    Space: ["Space", 32, " "],
  };
  let code, windowsVirtualKeyCode, text;
  if (special[key]) {
    [code, windowsVirtualKeyCode, text] = special[key];
    if (key === "Space") key = " ";
  } else if ([...key].length === 1) {
    code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : undefined;
    windowsVirtualKeyCode = key.toUpperCase().charCodeAt(0);
    text = key;
  } else throw new Error("Unsupported key. Use Enter, Tab, Escape, arrow keys, or a single character with modifiers.");
  const event = { key, modifiers, windowsVirtualKeyCode };
  if (code) event.code = code;
  const hasText = !(modifiers & 6) && Boolean(text);
  const editing = { KeyA: "selectAll", KeyC: "copy", KeyX: "cut", KeyV: "paste", KeyZ: modifiers & 8 ? "redo" : "undo" };
  // macOS editing shortcuts need the corresponding Blink command when sent by CDP.
  const commands = os === "mac" && (modifiers & 4) && !(modifiers & 3) && editing[code] ? [editing[code]] : [];
  await cdp(tabId, "Input.dispatchKeyEvent", {
    ...event, type: hasText ? "keyDown" : "rawKeyDown", commands,
    ...(hasText ? { text, unmodifiedText: text } : {}),
  }, context);
  await cdp(tabId, "Input.dispatchKeyEvent", { ...event, type: "keyUp" }, context);
}

async function act(tabId, args, context) {
  if (args.action === "click" || args.action === "hover") {
    await withPointer(tabId, args, context, async (position, verify) => {
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", ...position }, context);
      if (args.action === "click") {
        await showCursor(tabId, position, "click", context);
        if (verify) await verify();
        const button = args.button || "left";
        const buttons = { left: 1, right: 2, middle: 4 }[button];
        for (let count = 1; count <= (args.clickCount || 1); count++) {
          await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...position, button, buttons, clickCount: count }, context);
          await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button, buttons: 0, clickCount: count }, context);
        }
      }
    });
  } else if (args.action === "type") {
    if (typeof args.text !== "string") throw new Error("Provide text to type.");
    if (args.ref) {
      const backendNodeId = await nodeFor(tabId, args.ref, context);
      await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, context);
      await cdp(tabId, "DOM.focus", { backendNodeId }, context);
    }
    if (args.clear) {
      await pressKey(tabId, "Mod+a", context);
      await pressKey(tabId, "Backspace", context);
    }
    if (args.text) await cdp(tabId, "Input.insertText", { text: args.text }, context);
  } else if (args.action === "key") {
    await pressKey(tabId, args.key, context);
  } else if (args.action === "scroll") {
    await withPointer(tabId, args, context, (position) => cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel", ...position, deltaX: args.deltaX || 0, deltaY: args.deltaY ?? 600,
    }, context));
  } else if (args.action === "select") {
    if (!args.ref || typeof args.value !== "string") throw new Error("Provide a select element's ref and an option value.");
    const { object } = await resolveIsolatedNode(tabId, await nodeFor(tabId, args.ref, context), context);
    try {
      const result = await cdp(tabId, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function(value) {
          if (this.tagName !== 'SELECT') throw new Error('This ref is not a native select element.');
          if (!this.isConnected) throw new Error('This select was removed. Inspect the page again.');
          if (this.disabled) throw new Error('This select is disabled.');
          const options = [...this.options].filter(option => !option.disabled);
          const option = options.find(option => option.value === value) || options.find(option => option.label === value);
          if (!option) throw new Error('Choose an option value or label: ' + JSON.stringify(options.slice(0, 100).map(option => ({ value: option.value, label: option.label }))));
          this.value = option.value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return this.value;
        }`,
        arguments: [{ value: args.value }], returnByValue: true,
      }, context);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Could not select this option.");
    } finally {
      if (socket === context.socket) await cdp(tabId, "Runtime.releaseObject", { objectId: object.objectId }, context).catch(() => {});
    }
  } else if (args.action === "dialog") {
    if (typeof args.accept !== "boolean") throw new Error("Provide accept: true or false for the browser dialog.");
    await cdp(tabId, "Page.handleJavaScriptDialog", { accept: args.accept, promptText: args.text || "" }, context);
    dialogs.delete(tabId);
  } else throw new Error("Unknown browser action.");
  const result = { tabId, action: args.action, done: true };
  if (args.read) {
    try { result.read = await observe(tabId, args.read, context); }
    catch (error) {
      return { ...result, ok: false, error: error.message,
        note: "The action completed, but its follow-up read failed. Inspect the page; do not repeat the action automatically." };
    }
  } else result.note = "Use read or snapshot to inspect the result, or include read in the action to get it in one call.";
  return result;
}

async function batch(tabId, args, context) {
  if (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > 8) {
    throw new Error("A batch must contain between one and eight actions on one tab.");
  }
  const results = [];
  const end = Math.min(context.deadline - 1000, Date.now() + 20_000);
  const batchContext = Object.create(context);
  batchContext.deadline = end;
  for (const [index, step] of args.actions.entries()) {
    try {
      active(context);
      if (Date.now() >= end) throw new Error("Batch time limit reached; remaining actions were not started.");
      const dialog = dialogs.get(tabId);
      if (dialog && step.action !== "dialog") throw new Error("A page dialog is open. Inspect it before continuing.");
      const result = await act(tabId, step, batchContext);
      if (!step.read) delete result.note;
      results.push(result);
      if (result.ok === false) {
        return { tabId, ok: false, completed: results.length, failedStep: index + 1, results,
          error: result.error, note: "Stopped after the completed action's read failed. No remaining actions ran. Do not replay completed actions." };
      }
    } catch (error) {
      return { tabId, ok: false, completed: results.length, failedStep: index + 1, results, error: error.message,
        note: "Stopped at the first failure. The failed action may have partly completed. Inspect before retrying; no later actions ran." };
    }
  }
  const result = { tabId, ok: true, completed: results.length, results };
  try { result.read = await observe(tabId, args.read || { mode: "text" }, batchContext); }
  catch (error) {
    return { ...result, ok: false, error: error.message,
      note: "All actions completed, but the final read failed. Inspect the page; do not replay this batch." };
  }
  return result;
}

async function execute(tool, args, context) {
  active(context);
  if (usesClipboard(tool, args) && !clipboardAllowed) {
    throw new Error("System clipboard shortcuts are disabled. Enable 'Allow system clipboard shortcuts' in this profile's side panel first. No actions started.");
  }
  if (tool === "tabs") {
    if (args.action === "list") return { tabs: (await chromeCall(context, () => chrome.tabs.query({}), "Tab listing"))
      .filter((tab) => !tab.incognito).map(tabInfo) };
    if (args.action === "create") {
      const url = pageUrl(args.url || "about:blank", true);
      const windows = await chromeCall(context, () => chrome.windows.getAll({ windowTypes: ["normal"] }), "Window listing");
      const window = windows.find((item) => !item.incognito && item.focused) || windows.find((item) => !item.incognito);
      if (!window) throw new Error("Open a regular window in this profile first. The controller never opens a browser window.");
      active(context);
      const tab = await chromeMutation(context, () => chrome.tabs.create({ windowId: window.id, url, active: false }), "Tab creation");
      return { tab: tabInfo(tab) };
    }
    const tab = await ownTab(args.tabId, context);
    active(context);
    if (args.action === "close") {
      const siblings = await chromeCall(context, () => chrome.tabs.query({ windowId: tab.windowId }), "Window tab lookup");
      if (siblings.length === 1) throw new Error("Keep at least one tab in this window. The controller will not close your last tab.");
      active(context);
      await chromeMutation(context, () => chrome.tabs.remove(tab.id), "Tab closure");
      return { closed: tab.id };
    }
    if (args.action === "focus") {
      await chromeMutation(context, () => chrome.tabs.update(tab.id, { active: true }), "Tab focus");
      active(context);
      await chromeMutation(context, () => chrome.windows.update(tab.windowId, { focused: true }), "Window focus");
      return { tab: tabInfo(await ownTab(tab.id, context)) };
    }
    throw new Error("Unknown tabs action.");
  }
  const tab = await ownTab(args.tabId, context);
  if (tool === "navigate") {
    const url = pageUrl(args.url);
    if (!tabInfo(tab).controllable) throw new Error("Use a regular webpage tab, or create one with tabs.");
    invalidateTab(tab.id);
    active(context);
    await chromeMutation(context, () => chrome.tabs.update(tab.id, { url }), "Navigation");
    return { tab: await waitForLoad(tab.id, context) };
  }
  if (!tabInfo(tab).controllable) throw new Error("Chrome internal pages, the Chrome Web Store, and extension pages cannot be controlled. Use a regular website tab.");
  await attach(tab.id, context);
  const dialog = dialogs.get(tab.id);
  if (dialog && !(tool === "act" && args.action === "dialog") && !(tool === "batch" && args.actions?.[0]?.action === "dialog")) {
    throw new Error(`A ${dialog.type} dialog is open: ${dialog.message}. Use act with action 'dialog' and accept true/false.`);
  }
  if (tool === "snapshot") return snapshot(tab.id, args, context);
  if (tool === "find") return find(tab.id, args, context);
  if (tool === "read") return readContent(tab.id, args, context);
  if (tool === "act") return act(tab.id, args, context);
  if (tool === "batch") return batch(tab.id, args, context);
  if (tool === "screenshot") {
    const view = await viewport(tab.id, context);
    const ratio = await cdp(tab.id, "Runtime.evaluate", { contextId: await isolatedWorld(tab.id, context),
      expression: "window.devicePixelRatio || 1", returnByValue: true }, context);
    const { data } = await cdp(tab.id, "Page.captureScreenshot", {
      format: "jpeg", quality: 80, fromSurface: true, captureBeyondViewport: false,
      clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale: 1 / (ratio.result.value || 1) },
    }, context);
    return { data, mimeType: "image/jpeg", width: view.clientWidth, height: view.clientHeight };
  }
  throw new Error("Unknown browser tool.");
}
