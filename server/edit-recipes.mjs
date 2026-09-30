import { createHash, randomUUID } from 'node:crypto';
import { validateEditRecipeDefinition, validateEditRecipeRecord, validateEditRecipeBindings } from '../shared/commands.mjs';
import { EDIT_RECIPE_COMMANDS, EDIT_RECIPE_LIMITS, EDIT_RECIPE_SLOT_TYPES } from '../shared/edit-recipes.mjs';
import { normalizeParameters } from './color.mjs';
import { normalizeLayerFilter } from './layer-filters.mjs';
import { normalizeEffects } from './layer-effects.mjs';

export { EDIT_RECIPE_COMMANDS, EDIT_RECIPE_LIMITS, EDIT_RECIPE_SLOT_TYPES };
export const EDIT_RECIPE_APIS = Object.freeze(['save_edit_recipe', 'get_edit_recipe', 'rename_edit_recipe', 'delete_edit_recipe', 'validate_edit_recipe', 'apply_edit_recipe']);
export const EDIT_RECIPE_LIBRARY_COMMANDS = Object.freeze(['save_edit_recipe', 'rename_edit_recipe', 'delete_edit_recipe']);
const CONTENT = new Set(['raster', 'solid', 'text', 'shape', 'path', 'gradient']);
const CONFIG_ID = '00000000-0000-0000-0000-000000000000';
const EXPECTED_FAILURES = new Set(['INVALID_ARGUMENT', 'INVALID_ARGUMENTS', 'INVALID_TARGET', 'NOT_FOUND', 'PROTECTED_LAYER', 'FILTER_STACK_ACTIVE', 'LIMIT_EXCEEDED', 'UNSUPPORTED']);
const fail = (message, code = 'INVALID_ARGUMENTS') => { throw Object.assign(new Error(message), { code }); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const serialize = value => JSON.stringify(canonical(value));
const bytes = value => Buffer.byteLength(serialize(value), 'utf8');

/** Save full color configurations while preserving intentional partial text
 * updates and explicit tracking/leading reset instructions. No caller aliases. */
export function normalizeEditRecipe(record) {
  const input = validateEditRecipeRecord(record), slots = new Map(input.slots.map(slot => [slot.key, slot]));
  if (input.slots.some(slot => slot.kind === 'color_lookup') || input.steps.some(step => step.args?.kind === 'color_lookup')) fail('Color Lookup assets are not supported in edit recipes. Use a portable Prism project or explicitly exclude filters.');
  const steps = input.steps.map(step => {
    let args;
    if (step.command === 'add_layer_filter') {
      const { id, ...settings } = normalizeLayerFilter({ id: CONFIG_ID, ...step.args }, { defaults: true });
      args = settings;
    } else if (step.command === 'update_adjustment') {
      const parameters = normalizeParameters(slots.get(step.target).kind, step.args.parameters);
      args = { value: step.args.value, ...(parameters ? { parameters } : {}) };
    } else if (step.command === 'set_layer_effects') args = { effects: normalizeEffects(step.args.effects) };
    else if (step.command === 'set_layer_outline') args = { width: step.args.width, color: (step.args.color ?? '#ffffff').toLowerCase() };
    else {
      args = structuredClone(step.args);
      if (args.color !== undefined) args.color = args.color.toLowerCase();
    }
    return { command: step.command, target: step.target, args };
  });
  const result = { id: input.id, version: 1, name: input.name, slots: structuredClone(input.slots), steps };
  // Defaults can expand a compact input. Bound the stored canonical result too.
  validateEditRecipeRecord(result);
  if (bytes(result) > EDIT_RECIPE_LIMITS.maxRecipeBytes) fail('The normalized recipe exceeds its 32 KiB metadata limit.', 'LIMIT_EXCEEDED');
  return result;
}

export function normalizeEditRecipes(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) fail('Edit recipes must be a plain array.');
  if (input.length > EDIT_RECIPE_LIMITS.maxRecipes) fail('Documents support at most 16 edit recipes. Overwrite or delete an existing recipe.', 'LIMIT_EXCEEDED');
  if (Reflect.ownKeys(input).length !== input.length + 1) fail('Edit recipes must be a dense JSON array without extra properties.');
  const ids = new Set(), recipes = [];
  for (let index = 0; index < input.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(input, String(index));
    if (!entry || !Object.hasOwn(entry, 'value') || !entry.enumerable) fail('Edit recipes must contain enumerable JSON data values.');
    const recipe = normalizeEditRecipe(entry.value);
    if (ids.has(recipe.id)) fail('Saved recipe identifiers must be unique.');
    ids.add(recipe.id); recipes.push(recipe);
  }
  if (bytes(recipes) > EDIT_RECIPE_LIMITS.maxLibraryBytes) fail('The saved recipe library exceeds its 256 KiB metadata limit.', 'LIMIT_EXCEEDED');
  return recipes;
}

export function validateEditRecipes(graph) { normalizeEditRecipes(graph.editRecipes); }
export function editRecipeHash(record) { return createHash('sha256').update(serialize(normalizeEditRecipe(record))).digest('hex'); }

export function findEditRecipe(graph, recipeId) {
  const recipe = normalizeEditRecipes(graph.editRecipes).find(recipe => recipe.id === recipeId);
  if (!recipe) fail('Saved edit recipe was not found.', 'NOT_FOUND');
  return recipe;
}

export function updatedEditRecipes(graph, command, args) {
  const recipes = normalizeEditRecipes(graph.editRecipes);
  const index = args.recipeId === undefined ? -1 : recipes.findIndex(recipe => recipe.id === args.recipeId);
  if (args.recipeId !== undefined && index < 0) fail('Saved edit recipe was not found.', 'NOT_FOUND');
  if (command === 'save_edit_recipe') {
    if (index < 0 && recipes.length >= EDIT_RECIPE_LIMITS.maxRecipes) fail('Documents support at most 16 edit recipes. Overwrite or delete an existing recipe.', 'LIMIT_EXCEEDED');
    const definition = validateEditRecipeDefinition({ name: args.name, slots: args.slots, steps: args.steps });
    const recipe = normalizeEditRecipe({ id: index < 0 ? randomUUID() : recipes[index].id, version: 1, ...definition });
    if (index < 0) recipes.push(recipe); else recipes[index] = recipe;
    return { recipes: normalizeEditRecipes(recipes), recipeId: recipe.id, label: index < 0 ? 'Save edit recipe' : 'Update edit recipe' };
  }
  if (index < 0) fail('Choose a saved edit recipe.', 'NOT_FOUND');
  if (command === 'rename_edit_recipe') recipes[index] = normalizeEditRecipe({ ...recipes[index], name: args.name });
  else if (command === 'delete_edit_recipe') recipes.splice(index, 1);
  else fail('Unsupported edit recipe library command.', 'UNSUPPORTED');
  return { recipes: normalizeEditRecipes(recipes), recipeId: args.recipeId, label: command === 'rename_edit_recipe' ? 'Rename edit recipe' : 'Delete edit recipe' };
}

function bindingIssues(graph, recipe, bindings) {
  const issues = [], keys = new Set(recipe.slots.map(slot => slot.key)), layers = new Map(graph.layers.map(layer => [layer.id, layer])), used = new Set();
  const add = (code, message, target) => issues.push({ code, message, target });
  for (const key of Object.keys(bindings)) if (!keys.has(key)) add('INVALID_ARGUMENTS', 'This binding does not name a declared recipe slot.', key);
  for (const slot of recipe.slots) {
    if (!Object.hasOwn(bindings, slot.key)) { add('INVALID_ARGUMENTS', 'Choose a layer for this recipe slot.', slot.key); continue; }
    const id = bindings[slot.key], layer = layers.get(id);
    if (used.has(id)) add('INVALID_ARGUMENTS', 'Different recipe slots must bind to different layers. Reuse one slot for several steps on the same layer.', slot.key);
    used.add(id);
    if (!layer) { add('NOT_FOUND', 'The bound layer was not found in this document.', slot.key); continue; }
    if (slot.type === 'content' ? !CONTENT.has(layer.type) : layer.type !== slot.type) add('INVALID_TARGET', `This recipe slot requires a ${slot.type} layer.`, slot.key);
    else if (slot.type === 'adjustment' && layer.kind !== slot.kind) add('INVALID_TARGET', `This recipe slot requires a ${slot.kind} adjustment layer.`, slot.key);
  }
  return issues;
}

/** Stage only the five approved metadata commands on one owned graph. The
 * native caller supplies its exact mutation and prospective commit validators.
 * Neither a candidate graph nor generated filter IDs enter the public report. */
export async function stageEditRecipe({ graph, recipe: input, bindings: rawBindings, documentId, revision, mutate, validateGraph, validateCommit }) {
  const recipe = normalizeEditRecipe(input), bindings = canonical(validateEditRecipeBindings(rawBindings));
  validateGraph(graph);
  const report = { documentId, revision, recipeId: recipe.id, recipeVersion: 1, recipeHash: editRecipeHash(recipe), bindings,
    validation: 'metadata-only', valid: false, stepCount: recipe.steps.length, issues: [], issuesOmitted: 0, changes: [] };
  const issues = bindingIssues(graph, recipe, bindings);
  if (issues.length) return { report: { ...report, issues: issues.slice(0, EDIT_RECIPE_LIMITS.maxSlots), issuesOmitted: Math.max(0, issues.length - EDIT_RECIPE_LIMITS.maxSlots) } };
  const candidate = structuredClone(graph), changes = [];
  for (let stepIndex = 0; stepIndex < recipe.steps.length; stepIndex++) {
    const step = recipe.steps[stepIndex];
    if (!EDIT_RECIPE_COMMANDS.includes(step.command)) fail('Unsupported recipe command.', 'UNSUPPORTED');
    try {
      const args = structuredClone(step.args);
      // Single Curves recipes keep their old canonical body/hash. Execution
      // explicitly replaces banked targets and resets omitted Linear; complete
      // bank recipes already reset all nested fields without legacy markers.
      if (step.command === 'update_adjustment' && recipe.slots.find(slot => slot.key === step.target)?.kind === 'curves' && args.parameters?.mode !== 'banks')
        args.parameters = { ...args.parameters, mode: 'single', interpolation: args.parameters?.interpolation ?? 'linear' };
      await mutate(candidate, step.command, { ...args, layerId: bindings[step.target] });
      validateGraph(candidate);
      changes.push({ stepIndex, command: step.command, target: step.target, layerId: bindings[step.target] });
    } catch (cause) {
      if (!EXPECTED_FAILURES.has(cause?.code)) throw cause;
      return { report: { ...report, issues: [{ code: cause.code, message: cause.message, stepIndex, target: step.target }] } };
    }
  }
  const label = `Apply recipe: ${recipe.name.slice(0, 186)}`;
  try { validateCommit(candidate, label); }
  catch (cause) {
    if (!EXPECTED_FAILURES.has(cause?.code)) throw cause;
    return { report: { ...report, issues: [{ code: cause.code, message: cause.message }] } };
  }
  return { graph: candidate, label, report: { ...report, valid: true, changes } };
}
