// Called on the live DOM node through CDP. Coordinates are for the main viewport.
export function inspectTarget() {
  if (window !== window.top) return { error: "Use screenshot coordinates for controls inside embedded frames." };
  const element = this.nodeType === 1 ? this : this.parentElement;
  if (!element?.isConnected) return { error: "The target was removed. Inspect the page again." };
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" ||
      element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") {
    return { error: "The target is hidden or disabled. Inspect the page again." };
  }
  const width = document.documentElement.clientWidth || innerWidth;
  const height = document.documentElement.clientHeight || innerHeight;
  let point;
  for (const rect of element.getClientRects()) {
    const left = Math.max(0, rect.left), right = Math.min(width, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(height, rect.bottom);
    if (right > left && bottom > top) { point = { x: (left + right) / 2, y: (top + bottom) / 2 }; break; }
  }
  if (!point) return { error: "The target has no visible box. Inspect the page again." };
  let hit = document.elementFromPoint(point.x, point.y);
  const root = element.getRootNode();
  if (root !== document && root.elementFromPoint) {
    let ancestor = element;
    while (ancestor && ancestor !== hit) ancestor = ancestor.parentNode || ancestor.host;
    if (ancestor) hit = root.elementFromPoint(point.x, point.y);
  }
  return { point, hit: hit === element || element.contains(hit) };
}
