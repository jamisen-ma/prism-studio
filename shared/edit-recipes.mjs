import { z } from 'zod';

export const EDIT_RECIPE_COMMANDS = ['add_layer_filter', 'update_adjustment', 'update_text', 'set_layer_effects', 'set_layer_outline'];
export const EDIT_RECIPE_SLOT_TYPES = ['raster', 'text', 'content', 'adjustment'];
export const EDIT_RECIPE_LIMITS = Object.freeze({ maxRecipes: 16, maxSteps: 30, maxSlots: 16, maxRecipeBytes: 32768, maxLibraryBytes: 262144, maxDepth: 12, maxValues: 8192 });
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENTS' }); };

// Check direct native callers as well as transport JSON before recursive schema
// parsing. Never invoke accessors, toJSON, or custom prototype methods.
export function assertEditRecipeJson(value, { maxValues = EDIT_RECIPE_LIMITS.maxValues, maxDepth = EDIT_RECIPE_LIMITS.maxDepth } = {}) {
  const seen = new Set(); let visited = 0;
  const visit = (item, depth) => {
    if (++visited > maxValues || depth > maxDepth) fail('Recipe JSON exceeds its structural limits.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('Recipe numbers must be finite.'); return; }
    if (typeof item === 'string') { if (item.length > EDIT_RECIPE_LIMITS.maxRecipeBytes) fail('A recipe string is too large.'); return; }
    if (typeof item !== 'object') fail('Recipes accept JSON data only.');
    if (seen.has(item)) fail('Recipe JSON cannot contain cycles.');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('Recipe objects must have plain JSON prototypes.');
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.length > maxValues - visited + (array ? 1 : 0)) fail('Recipe JSON exceeds its structural limits.');
    if (array && (item.length > maxValues || keys.length !== item.length + 1)) fail('Recipe arrays must be dense JSON arrays.');
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key.length > 128 || dangerousKeys.has(key) || array && !/^(0|[1-9][0-9]*)$/.test(key)) fail('Recipe JSON contains an unsupported property.');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('Recipe JSON cannot contain accessors or hidden properties.');
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  return value;
}

export function createEditRecipeSchemas(base) {
  const strict = shape => z.object(shape).strict();
  const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/, 'Use a lowercase UUID');
  const name = z.string().regex(/^[^\u0000-\u001f\u007f]*$/, 'Control characters are not allowed').trim().min(1).max(200);
  const key = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).refine(value => !dangerousKeys.has(value), 'Reserved target slot key');
  const slotBase = { key, label: z.string().regex(/^[^\u0000-\u001f\u007f]*$/).trim().min(1).max(80).optional() };
  const slot = z.discriminatedUnion('type', [
    strict({ ...slotBase, type: z.literal('raster') }), strict({ ...slotBase, type: z.literal('text') }), strict({ ...slotBase, type: z.literal('content') }),
    strict({ ...slotBase, type: z.literal('adjustment'), kind: base.add_adjustment.shape.kind.exclude(['color_lookup']) }),
  ]);
  const stepArgs = {
    add_layer_filter: base.add_layer_filter.omit({ documentId: true, expectedRevision: true, layerId: true }).extend({ kind: base.add_layer_filter.shape.kind.exclude(['color_lookup']) }),
    update_adjustment: strict({ value: base.add_adjustment.shape.value, parameters: base.add_adjustment.shape.parameters }),
    update_text: base.update_text.pick({ fontSize: true, color: true, fontFamily: true, fontWeight: true, fontStyle: true, align: true, tracking: true, leading: true }).refine(args => Object.keys(args).length > 0, 'Choose at least one text style setting'),
    set_layer_effects: base.set_layer_effects.pick({ effects: true }),
    set_layer_outline: base.set_layer_outline.pick({ width: true, color: true }),
  };
  const step = z.discriminatedUnion('command', EDIT_RECIPE_COMMANDS.map(command => strict({ command: z.literal(command), target: key, args: stepArgs[command] })));
  const definitionSchema = strict({ name, slots: z.array(slot).min(1).max(EDIT_RECIPE_LIMITS.maxSlots), steps: z.array(step).min(1).max(EDIT_RECIPE_LIMITS.maxSteps) });
  const recordSchema = strict({ id: uuid, version: z.literal(1), ...definitionSchema.shape });
  // Missing, extra and aliased bindings are semantic report issues. Shape and
  // payload bounds still reject before staging or document access.
  const bindingsSchema = z.record(key, uuid).refine(bindings => Object.keys(bindings).length <= EDIT_RECIPE_LIMITS.maxSlots, 'At most 16 target bindings are supported');
  const identity = { documentId: base.get_document.shape.documentId, expectedRevision: z.number().int().positive().optional() };
  const commands = {
    save_edit_recipe: strict({ ...identity, recipeId: uuid.optional(), ...definitionSchema.shape }),
    get_edit_recipe: strict({ ...identity, recipeId: uuid }),
    rename_edit_recipe: strict({ ...identity, recipeId: uuid, name }),
    delete_edit_recipe: strict({ ...identity, recipeId: uuid }),
    validate_edit_recipe: strict({ ...identity, recipeId: uuid, bindings: bindingsSchema }),
    apply_edit_recipe: strict({ ...identity, expectedRevision: z.number().int().positive(), recipeId: uuid, bindings: bindingsSchema }),
  };
  return { commands, definitionSchema, recordSchema, bindingsSchema };
}

// Cross-field checks reuse ordinary commands' conditional validation. The
// factory remains independent from commands.mjs and native normalization.
export function validateEditRecipeSemantics(definition, validateCommand) {
  const slots = new Map();
  for (const slot of definition.slots) {
    if (slots.has(slot.key)) fail('Recipe target slot keys must be unique.');
    slots.set(slot.key, slot);
  }
  const used = new Set();
  for (const [index, step] of definition.steps.entries()) {
    const slot = slots.get(step.target);
    if (!slot) fail(`Recipe step ${index + 1} refers to an undeclared target slot.`);
    const allowed = step.command === 'add_layer_filter' ? slot.type === 'raster'
      : step.command === 'update_adjustment' ? slot.type === 'adjustment'
      : step.command === 'update_text' ? slot.type === 'text'
      : ['raster', 'text', 'content'].includes(slot.type);
    if (!allowed) fail(`Recipe step ${index + 1} does not match its target slot type.`);
    used.add(slot.key);
    const documentId = 'recipe-validation', layerId = 'recipe-target';
    if (step.command === 'update_adjustment') validateCommand('add_adjustment', { documentId, kind: slot.kind, ...step.args });
    else validateCommand(step.command, { documentId, layerId, ...step.args });
  }
  if (used.size !== slots.size) fail('Every declared recipe target slot must be used.');
  return definition;
}
