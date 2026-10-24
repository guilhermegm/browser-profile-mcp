// Serialized into a CDP isolated world. Keep this function self-contained.
export function renderAgentCursor({ action, x, y, from, maxDurationMs = 500 }) {
  const key = "__profileBrowserMcpCursor";
  let state = globalThis[key];
  if (action === "remove") { state?.dispose(); return; }
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  const width = document.documentElement?.clientWidth || innerWidth;
  const height = document.documentElement?.clientHeight || innerHeight;
  const start = {
    x: Math.max(0, Math.min(width - 1, Number.isFinite(from?.x) ? from.x : width / 2)),
    y: Math.max(0, Math.min(height - 1, Number.isFinite(from?.y) ? from.y : height / 2)),
  };
  const transform = (point) => `translate3d(${point.x - 2}px, ${point.y - 2}px, 0)`;

  const style = (element, properties) => {
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, "important");
  };
  const parent = document.fullscreenElement || document.documentElement;
  if (!parent) return;
  if (state && (!state.host.isConnected || state.host.parentElement !== parent)) {
    state.dispose();
    state = undefined;
  }
  if (!state) {
    const host = document.createElement("div");
    host.setAttribute("data-browser-mcp-cursor", "");
    host.setAttribute("aria-hidden", "true");
    host.inert = true;
    style(host, { all: "initial", position: "fixed", inset: "0", width: "100%", height: "100%",
      display: "block", "z-index": "2147483647", "pointer-events": "none", overflow: "hidden",
      contain: "strict", "user-select": "none" });
    const shadow = host.attachShadow({ mode: "closed" });
    const pointer = document.createElement("div");
    style(pointer, { position: "absolute", left: "0", top: "0", width: "28px", height: "34px",
      "pointer-events": "none", "will-change": "transform",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,.35))" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 28 34");
    svg.setAttribute("width", "28");
    svg.setAttribute("height", "34");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M2 2 L2 25 L8 19 L13 30 L19 27 L14 17 L24 17 Z");
    path.setAttribute("fill", "#F15B3A");
    path.setAttribute("stroke", "#ffffff");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    pointer.append(svg);
    shadow.append(pointer);
    pointer.style.setProperty("transform", transform(start));
    state = { host, shadow, pointer, fade: undefined, movement: undefined, position: start, rings: new Set() };
    state.dispose = () => {
      state.fade?.cancel();
      state.movement?.cancel();
      for (const ring of state.rings) { ring.animation.cancel(); ring.element.remove(); }
      state.rings.clear();
      host.remove();
      if (globalThis[key] === state) delete globalThis[key];
    };
    globalThis[key] = state;
    parent.append(host);
  }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const previous = state.position || start;
  const distance = Math.hypot(x - previous.x, y - previous.y);
  // Do not wait for a paint/animation callback: hidden tabs can suspend them.
  const durationMs = action === "move" && !reducedMotion && document.visibilityState === "visible" && distance > 1
    ? Math.min(Math.max(0, maxDurationMs), Math.max(260, Math.min(500, 180 + distance * .45))) : 0;
  state.fade?.cancel();
  state.movement?.cancel();
  state.movement = undefined;
  style(state.pointer, { transition: "none" });
  // Transform must be an ordinary inline style so the Web Animation can override it.
  state.pointer.style.setProperty("transform", transform({ x, y }));
  if (durationMs) {
    const movement = state.pointer.animate([{ transform: transform(previous) }, { transform: transform({ x, y }) }],
      { duration: durationMs, easing: "cubic-bezier(.22,.61,.36,1)", fill: "both" });
    state.movement = movement;
    movement.onfinish = () => {
      if (state.movement === movement) state.movement = undefined;
      movement.cancel();
    };
  }
  state.position = { x, y };

  if (action === "click") {
    // Keep rapid multi-clicks bounded; the overlay never receives pointer events.
    if (state.rings.size >= 4) {
      const oldest = state.rings.values().next().value;
      oldest.animation.cancel();
      oldest.element.remove();
      state.rings.delete(oldest);
    }
    const element = document.createElement("div");
    style(element, { position: "absolute", left: `${x - 12}px`, top: `${y - 12}px`, width: "24px", height: "24px",
      "box-sizing": "border-box", border: "3px solid #F15B3A", "border-radius": "50%",
      background: "rgba(241, 91, 58, .18)", "box-shadow": "0 0 0 1px white", "pointer-events": "none" });
    state.shadow.prepend(element);
    const animation = element.animate(reducedMotion
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ transform: "scale(.5)", opacity: .95 }, { transform: "scale(2)", opacity: 0 }],
    { duration: reducedMotion ? 200 : 500, easing: "ease-out", fill: "forwards" });
    const ring = { element, animation };
    state.rings.add(ring);
    animation.onfinish = () => { element.remove(); state.rings.delete(ring); };
  }

  const fade = state.pointer.animate([{ opacity: 1 }, { opacity: 1, offset: .85 }, { opacity: 0 }],
    { delay: durationMs, duration: 2600, fill: "forwards" });
  state.fade = fade;
  fade.onfinish = () => { if (state.fade === fade) state.dispose(); };
  return { durationMs };
}
