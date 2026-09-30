export const MAX_GROUP_DEPTH = 8;
export const MAX_GROUP_SCRATCH_BYTES = 256 * 1024 * 1024;
const fail = (message, code = 'INVALID_ARGUMENT') => { throw Object.assign(new Error(message), { code }); };

// The flat array remains the public ID lookup and persisted ordering. Groups
// precede their complete, contiguous descendant block; siblings are bottom-up.
export function layerTree(layers) {
  const roots = [], nodes = new Map(), stack = [];
  for (const layer of layers) {
    if (nodes.has(layer.id)) fail('Layer identifiers must be unique.');
    const parentId = layer.parentId ?? null;
    if (parentId === null) stack.length = 0;
    else {
      while (stack.length && stack.at(-1).layer.id !== parentId) stack.pop();
      if (!stack.length) fail('Layer parents must be preceding groups with contiguous descendants.');
    }
    const parent = stack.at(-1) ?? null;
    const node = { layer, parent, children: [], depth: stack.length };
    (parent ? parent.children : roots).push(node); nodes.set(layer.id, node);
    if (layer.type === 'group') {
      if (stack.length >= MAX_GROUP_DEPTH) fail('Documents support at most eight nested groups.', 'LIMIT_EXCEEDED');
      stack.push(node);
    }
  }
  return { roots, nodes };
}

export function subtree(node) {
  const result = [node];
  for (const child of node.children) result.push(...subtree(child));
  return result;
}

export function ancestors(node) {
  const result = [];
  for (let parent = node?.parent; parent; parent = parent.parent) result.unshift(parent);
  return result;
}

export function flattenTree(roots) {
  const result = [];
  function visit(node, parentId) {
    if (parentId) node.layer.parentId = parentId;
    else delete node.layer.parentId;
    result.push(node.layer);
    for (const child of node.children) visit(child, node.layer.id);
  }
  for (const node of roots) visit(node, null);
  return result;
}

export const containsProtected = (node) => subtree(node).some(({ layer }) => layer.type !== 'group' && layer.type !== 'adjustment' && layer.protected);
export const groupNeedsSurface = (layer) => layer.mode === 'isolated' || layer.opacity !== 1 || Boolean(layer.mask);

// Capture before any tree edits or parentId rewrites. Group isolation changes
// the backdrop seen by descendant blend modes, even when the group is normal.
export function protectedIsolationScopes(tree) {
  const scopes = new Map();
  for (const node of tree.nodes.values()) if (node.layer.protected && node.layer.type !== 'group' && node.layer.type !== 'adjustment')
    scopes.set(node.layer.id, ancestors(node).filter(({ layer }) => layer.mode === 'isolated').map(({ layer }) => layer.id));
  return scopes;
}

export function assertProtectedIsolationUnchanged(before, tree) {
  const after = protectedIsolationScopes(tree);
  for (const [id, scope] of before) {
    const next = after.get(id);
    if (!next || scope.length !== next.length || scope.some((groupId, index) => next[index] !== groupId))
      fail('Unprotect every affected descendant explicitly before moving it across an isolated group boundary.', 'PROTECTED_LAYER');
  }
}

export function validateGroupResources(tree, width, height) {
  function visit(node, retained = 0, altered = false) {
    const { layer } = node;
    if (layer.type !== 'group') {
      if (layer.protected && altered) fail('Unprotect this layer explicitly before placing it inside a group with reduced opacity or nonnormal blending.', 'PROTECTED_LAYER');
      return;
    }
    // Retain either a pass-through before-image or an isolated parent backdrop,
    // plus an independent protection map while rendering the child surface.
    // Count hidden groups so revealing them cannot activate an invalid graph.
    if (groupNeedsSurface(layer)) retained += width * height * 5;
    if (retained > MAX_GROUP_SCRATCH_BYTES) fail('Nested isolated, masked or translucent groups exceed the 256 MiB group rendering budget. Reduce their nesting or the canvas dimensions.', 'LIMIT_EXCEEDED');
    for (const child of node.children) visit(child, retained, altered || layer.opacity !== 1 || layer.blendMode !== 'normal');
  }
  for (const node of tree.roots) visit(node);
}

// Interpolate premultiplied BEFORE/AFTER colors once for a pass-through group.
// Exact endpoints retain all original bytes, including invisible RGB.
export function mixGroup(before, after, width, opacity, coverage) {
  const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));
  for (let i = 0; i < after.length; i += 4) {
    const index = i / 4, amount = opacity * coverage(index % width, Math.floor(index / width));
    if (amount >= 1) continue;
    if (amount <= 0) { before.copy(after, i, i, i + 4); continue; }
    const a = before[i + 3] / 255, b = after[i + 3] / 255;
    const alpha = a + (b - a) * amount;
    if (alpha > 0) for (let channel = 0; channel < 3; channel++) after[i + channel] = byte((before[i + channel] * a * (1 - amount) + after[i + channel] * b * amount) / alpha);
    else for (let channel = 0; channel < 3; channel++) after[i + channel] = before[i + channel];
    after[i + 3] = byte(alpha * 255);
  }
  return after;
}
