export const VERSION = "0.5.1";
export const COMMAND_PROTOCOL = 3;

export function clipboardShortcut(shortcut) {
  const keys = String(shortcut || "").toLowerCase().split("+");
  const modified = keys.some((key) => ["mod", "meta", "command", "cmd", "control", "ctrl"].includes(key));
  return (["c", "x", "v"].includes(keys.at(-1)) && modified) ||
    (keys.at(-1) === "delete" && keys.includes("shift")) ||
    (keys.at(-1) === "insert" && (modified || keys.includes("shift")));
}

export function usesClipboard(tool, args) {
  const step = (action) => action.action === "key" && clipboardShortcut(action.key);
  return (tool === "act" && step(args)) || (tool === "batch" && args.actions.some(step));
}

export function commandLane(tool, args) {
  if (tool === "tabs") return args.action === "list" ? "metadata" : "global";
  if (usesClipboard(tool, args)) return "global";
  return Number.isInteger(args.tabId) ? `tab:${args.tabId}` : "global";
}
