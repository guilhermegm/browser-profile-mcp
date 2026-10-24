const containers = new Set(["LayoutTable", "LayoutTableRow", "LayoutTableCell", "table", "rowgroup", "row", "cell",
  "grid", "gridcell", "group", "section", "main", "region", "article", "list", "listitem", "paragraph",
  "blockquote", "navigation", "banner", "contentinfo", "complementary"]);

// Walk just the requested subtree. Browser requests, retained nodes and depth
// are bounded independently of the compact output limit.
export async function collectAX(send, { backendNodeId, maxNodes = 300, maxDepth = 24 }) {
  let root;
  if (backendNodeId) {
    const result = await send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false });
    root = result.nodes.find((node) => node.backendDOMNodeId === backendNodeId) || result.nodes[0];
  } else root = (await send("Accessibility.getRootAXNode", {})).node;
  if (!root) throw new Error("No accessible content was found in this scope.");
  const nodes = new Map([[root.nodeId, root]]);
  const queue = [{ node: root, depth: 0 }];
  const seen = new Set();
  const nodeBudget = Math.min(4000, maxNodes * 4 + 100);
  const requestBudget = 48;
  let requests = 1;
  let truncated = false;
  while (queue.length) {
    const wave = [];
    while (queue.length && wave.length < 4) {
      const item = queue.shift();
      if (seen.has(item.node.nodeId)) continue;
      seen.add(item.node.nodeId);
      if (!item.node.childIds?.length) continue;
      if (item.depth >= maxDepth || nodes.size >= nodeBudget || requests >= requestBudget) {
        truncated = true;
        continue;
      }
      const missing = item.node.childIds.some((id) => !nodes.has(id));
      if (missing) { requests++; wave.push(item); }
      else for (const id of item.node.childIds) queue.push({ node: nodes.get(id), depth: item.depth + 1 });
    }
    await Promise.all(wave.map(async (item) => {
      const result = await send("Accessibility.getChildAXNodes", { id: item.node.nodeId });
      for (const child of result.nodes) {
        if (nodes.size >= nodeBudget && !nodes.has(child.nodeId)) { truncated = true; continue; }
        nodes.set(child.nodeId, child);
      }
      for (const id of item.node.childIds) {
        if (nodes.has(id)) queue.push({ node: nodes.get(id), depth: item.depth + 1 });
        else truncated = true;
      }
    }));
  }
  return { nodes: [...nodes.values()], truncated, acquisition: { requests, nodes: nodes.size, nodeBudget, requestBudget, maxDepth } };
}

export function formatAX(nodes, { maxNodes = 300, compact = true, flat = false } = {}) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const refs = new Map();
  const lines = [];
  const prefix = crypto.randomUUID().slice(0, 8);
  const stack = flat ? nodes.map((node) => ({ node, depth: 0, parentName: "" })).reverse()
    : nodes.length ? [{ node: nodes[0], depth: 0, parentName: "" }] : [];
  const seen = new Set();
  let length = 0;
  let truncated = false;
  while (stack.length) {
    const { node, depth, parentName } = stack.pop();
    if (!node || seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    const role = node.role?.value || "";
    const name = String(node.name?.value || "").slice(0, 600);
    const focusable = (node.properties || []).some((item) => item.name === "focusable" && item.value?.value);
    const structural = !flat && compact && containers.has(role) && !focusable && node.childIds?.length;
    const duplicate = compact && role === "StaticText" && name === parentName;
    const decorative = compact && (role === "LineBreak" || (role === "StaticText" && !name.trim()));
    const useful = !structural && !duplicate && !decorative && !node.ignored &&
      !["none", "generic", "InlineTextBox"].includes(role) && (name || node.value || node.childIds?.length || role === "textbox");
    if (useful) {
      if (lines.length >= maxNodes || length > 50_000) { truncated = true; break; }
      let ref;
      if (node.backendDOMNodeId) { ref = `r${prefix}_${refs.size + 1}`; refs.set(ref, node.backendDOMNodeId); }
      const properties = (node.properties || []).filter((item) => ["checked", "selected", "expanded", "disabled", "required", "level"].includes(item.name));
      const protectedValue = (node.properties || []).some((item) => item.name === "protected" && item.value?.value);
      const value = node.value && !protectedValue ? ` value=${JSON.stringify(String(node.value.value).slice(0, 400))}` : "";
      const flags = properties.map((item) => ` ${item.name}=${JSON.stringify(item.value?.value)}`).join("");
      const line = `${"  ".repeat(Math.min(depth, 12))}${ref ? `[${ref}] ` : ""}${role}${name ? ` ${JSON.stringify(name)}` : ""}${value}${flags}`;
      lines.push(line); length += line.length;
    }
    if (!flat) for (const id of [...(node.childIds || [])].reverse()) {
      stack.push({ node: byId.get(id), depth: depth + (useful ? 1 : 0), parentName: useful ? name : parentName });
    }
  }
  return { snapshot: lines.join("\n"), refs, truncated };
}
