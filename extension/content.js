// Runs in the inspected page through CDP. Keep these functions self-contained.
export function selectScope(selector) {
  if (!selector) return document.documentElement;
  const root = [...document.querySelectorAll(selector)].find((element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0 &&
      !element.closest('[aria-hidden="true"]');
  });
  if (!root) throw new Error("No visible element matches the scope selector.");
  return root;
}

export function extractContent(options) {
  const visible = (element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" &&
      element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]');
  };
  let root = this?.nodeType === 1 ? this : this?.nodeType === 3 ? this.parentElement : undefined;
  let scope = options.ref ? `ref:${options.ref}` : options.selector;
  if (!root && options.selector) {
    root = [...document.querySelectorAll(options.selector)].find(visible);
    if (!root) throw new Error("No visible element matches the content selector.");
  }
  if (!root) {
    for (const selector of ["main, [role=main]", "article, [role=article]"]) {
      root = [...document.querySelectorAll(selector)].find(visible);
      if (root) { scope = selector; break; }
    }
    if (!root) { root = document.body; scope = "body"; }
  }
  if (!root || !visible(root)) throw new Error("The content area is not visible. Inspect the page again.");
  // innerText omits CSS-hidden content and does not extract form field values.
  const text = String(root.innerText || "").replace(/\r/g, "")
    .split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const maxChars = options.maxChars || 12_000;
  return { text: text.slice(0, maxChars), scope, truncated: text.length > maxChars, totalChars: text.length };
}

// Wait for a short quiet period, with a strict upper bound for busy SPAs.
export function waitForQuiet(maxMs, selector) {
  return new Promise((resolve) => {
    let quietTimer;
    const finish = (settled) => {
      clearTimeout(quietTimer);
      clearTimeout(deadline);
      observer.disconnect();
      resolve(settled);
    };
    const schedule = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), 120);
    };
    const observer = new MutationObserver(schedule);
    const deadline = setTimeout(() => finish(false), maxMs);
    const root = selector ? document.querySelector(selector) || document : document;
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    schedule();
  });
}
