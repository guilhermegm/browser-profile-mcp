import { bootstrapPrompt } from "./onboarding.js";

const $ = (id) => document.getElementById(id);
let currentState;
let pairingKey;
let setupPrompt = "";
let toastTimer;
let toastCleanup;

try { $("bootstrap-profile").value = localStorage.getItem("setup-profile-name") || ""; } catch {}

function text(id, value) {
  if ($(id).textContent !== value) $(id).textContent = value;
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "The extension did not respond.");
  return result;
}

function showError(error) {
  hideToast();
  text("error", error.message);
  $("error").hidden = false;
}

function hideToast() {
  clearTimeout(toastTimer);
  clearTimeout(toastCleanup);
  $("copy-toast").classList.toggle("visible", false);
  toastCleanup = setTimeout(() => text("copy-status", ""), 180);
}

function showToast(message) {
  clearTimeout(toastTimer);
  clearTimeout(toastCleanup);
  text("copy-status", message);
  $("copy-toast").classList.toggle("visible", true);
  toastTimer = setTimeout(hideToast, 2400);
}

function rememberName(name) {
  try { localStorage.setItem("setup-profile-name", name); } catch {}
}

function renderPrompt(state) {
  const needsSetup = !state.paired || Boolean(state.pairingIssue);
  const name = needsSetup ? $("bootstrap-profile").value.trim().toLowerCase().replace(/\s+/g, "-") : state.profileId;
  setupPrompt = "";
  try {
    if (!name) {
      text("bootstrap-name-hint", "Choose a name you will recognize.");
    } else {
      setupPrompt = bootstrapPrompt({ extensionId: chrome.runtime.id, profileId: name,
        installationId: state.installationId, os: state.os });
      text("bootstrap-name-hint", "");
    }
  } catch (error) {
    text("bootstrap-name-hint", error.message);
  }
  $("copy-bootstrap").disabled = !setupPrompt;
  $("copy-another-agent").disabled = !setupPrompt;
}

async function refresh() {
  const state = await send({ type: "status" });
  currentState = state;
  const needsSetup = !state.paired || Boolean(state.pairingIssue);
  const key = state.paired ? `${state.profileId}:${state.port}` : undefined;
  if (key !== pairingKey) {
    pairingKey = key;
    if (state.paired && !state.pairingIssue) {
      $("bootstrap-profile").value = state.profileId;
      rememberName(state.profileId);
    }
  }
  for (const id of ["name-step", "prompt-step", "pair-form"]) $(id).hidden = !needsSetup;
  $("connected-step").hidden = needsSetup;
  $("pairing-conflict").hidden = !state.pairingIssue;
  const ready = state.connected && state.agentCount > 0;
  text("connection-step-label", ready ? "Setup complete" : "Step 4 of 4");
  text("connection-title", ready ? "You're connected" : !state.enabled ? "Connection paused" : "Connect your agent");
  text("connection-state", ready ? "Connected" : !state.enabled ? "Paused" : "Waiting for agent");
  text("profile-name", state.name || "");
  text("status", ready ? "Your agent can now use this profile's tabs."
    : !state.enabled ? "Click Reconnect to use this profile again."
    : "Open a new session in your coding agent, then send:");
  $("status-dot").classList.toggle("online", ready);
  $("try-task").hidden = needsSetup || !state.enabled;
  text("first-task", state.paired ? `Use browser-${state.profileId} MCP to list my open tabs.` : "");
  text("toggle", state.enabled ? "Disconnect" : "Connect");
  $("release").disabled = !state.connected;
  $("clipboard-allowed").checked = state.clipboardAllowed === true;
  $("pairing-note").hidden = !state.paired;
  $("connection-issue").hidden = !state.lastConnectionIssue;
  if (state.lastConnectionIssue) {
    const issue = state.lastConnectionIssue;
    text("connection-issue-detail", `${new Date(issue.at).toLocaleString()}: ${issue.reason}`);
  }
  renderPrompt(state);
}

async function perform(action) {
  $("error").hidden = true;
  hideToast();
  try { await action(); await refresh(); } catch (error) { showError(error); }
}

$("bootstrap-profile").addEventListener("input", () => {
  rememberName($("bootstrap-profile").value);
  if (currentState) renderPrompt(currentState);
});
$("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void perform(async () => {
    const code = $("pairing-code").value.trim();
    if (!code) throw new Error("Paste the code your agent gave you.");
    await send({ type: "pair", code });
    $("pairing-code").value = "";
  });
});

for (const id of ["copy-bootstrap", "copy-another-agent"]) {
  $(id).addEventListener("click", () => void perform(async () => {
    if (!setupPrompt) throw new Error("Name this profile first.");
    await navigator.clipboard.writeText(setupPrompt);
    showToast("Setup prompt copied");
  }));
}
$("copy-first-task").addEventListener("click", () => void perform(async () => {
  await navigator.clipboard.writeText($("first-task").textContent);
  showToast("Message copied");
}));
$("reconnect").addEventListener("click", () => void perform(() => send({ type: "reconnect" })));
$("toggle").addEventListener("click", () => void perform(() => send({ type: "toggle" })));
$("release").addEventListener("click", () => void perform(() => send({ type: "release" })));
$("forget").addEventListener("click", () => void perform(() => send({ type: "forget" })));
$("clipboard-allowed").addEventListener("change", () => void perform(() =>
  send({ type: "clipboard", allowed: $("clipboard-allowed").checked })));
void refresh().catch(showError);
setInterval(() => void refresh().catch(showError), 1500);
