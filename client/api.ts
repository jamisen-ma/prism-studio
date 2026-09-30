import type { ColorRangeSettings, COLOR_RANGE_LIMITS, COLOR_RANGE_PREVIEW_LIMITS } from '../shared/color-range.mjs';
import type { ColorLookupParameters, COLOR_LOOKUP_LIMITS } from '../shared/color-lookup.mjs';
import type { DenseMaskDescriptor, ChannelSelectionChannel, DENSE_MASK_LIMITS, CHANNEL_PREVIEW_LIMITS } from '../shared/dense-mask.mjs';
export type { DenseMaskDescriptor, ChannelSelectionChannel } from '../shared/dense-mask.mjs';
export type { ColorLookupParameters } from '../shared/color-lookup.mjs';
export type EditRecipeCommand = 'add_layer_filter' | 'update_adjustment' | 'update_text' | 'set_layer_effects' | 'set_layer_outline';
export type EditRecipeSlot = { key: string; label?: string; type: 'raster' | 'text' | 'content' | 'adjustment'; kind?: string };
export type EditRecipeStep = { command: EditRecipeCommand; target: string; args: Record<string, unknown> };
export type EditRecipeDefinition = { version: 1; name: string; slots: EditRecipeSlot[]; steps: EditRecipeStep[] };
export type EditRecipe = EditRecipeDefinition & { id: string };
export type EditRecipeReport = { documentId: string; revision: number; recipeId: string; recipeVersion: 1; recipeHash: string; validation: 'metadata-only'; valid: boolean; stepCount: number; bindings: Record<string, string>; changes: { stepIndex: number; command: string; target: string; layerId: string }[]; issues: { code: string; message: string; target?: string; stepIndex?: number }[]; issuesOmitted?: number };
export type BackendId = 'native' | 'photoshop';
export type DocumentResizeMethod = 'nearest' | 'cubic' | 'mitchell' | 'lanczos3';
export type Point = { x: number; y: number; pressure?: number };
export type LegacyMask = { shape?: 'rectangle' | 'ellipse' | 'polygon' | 'bitmap'; x: number; y: number; width: number; height: number; points?: Point[]; feather?: number; invert?: boolean; runs?: number[]; clip?: { x: number; y: number; width: number; height: number } };
export type Mask = LegacyMask | DenseMaskDescriptor;
export type PositionedMask = { shape: 'positioned'; sourceWidth: number; sourceHeight: number; x: number; y: number; source: Mask; domain?: { x: number; y: number; width: number; height: number } };
export type AdditionalMask = Mask | PositionedMask;
export type SourceFilterMask = (Omit<LegacyMask, "shape" | "points" | "clip"> & { shape: "rectangle" | "ellipse" | "bitmap" }) | DenseMaskDescriptor;
export type FilterMask = { sourceWidth: number; sourceHeight: number; coverage: SourceFilterMask; density: number; enabled: boolean };
export const isPositionedMask = (mask: AdditionalMask | null | undefined): mask is PositionedMask => mask?.shape === 'positioned';
export const maskSource = (mask: AdditionalMask): Mask => isPositionedMask(mask) ? mask.source : mask;
export type LevelsParameters = { black: number; white: number; gamma: number; outputBlack: number; outputWhite: number };
export type SingleCurvesParameters = { interpolation?: 'linear' | 'smooth'; points: Point[]; channel?: 'rgb' | 'red' | 'green' | 'blue' };
export type CurveBankName = 'master' | 'red' | 'green' | 'blue';
export type CurveBankParameters = { points: Point[]; interpolation: 'linear' | 'smooth' };
export type BankedCurvesParameters = { mode: 'banks'; banks: Record<CurveBankName, CurveBankParameters> };
export type CurvesParameters = SingleCurvesParameters | BankedCurvesParameters;
export type MixerRow = [number, number, number, number];
export type ChannelMixerParameters = { monochrome: boolean; red: MixerRow; green: MixerRow; blue: MixerRow; gray: MixerRow };
export type GradientMapParameters = { stops: { offset: number; color: string }[]; reverse: boolean };
export type ColorBalanceRow = [number, number, number];
export type ColorBalanceParameters = { shadows: ColorBalanceRow; midtones: ColorBalanceRow; highlights: ColorBalanceRow; preserveLuminosity: boolean };
export type BlackWhiteParameters = { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tintColor: string; tintAmount: number };
export type SelectiveColorRange = 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas' | 'whites' | 'neutrals' | 'blacks';
export type SelectiveColorRow = [number, number, number, number];
export type SelectiveColorParameters = { method: 'relative' | 'absolute' } & Record<SelectiveColorRange, SelectiveColorRow>;
export type HueSaturationRange = 'master' | 'reds' | 'yellows' | 'greens' | 'cyans' | 'blues' | 'magentas';
export type HueSaturationRow = [number, number, number];
export type HueSaturationParameters = Record<HueSaturationRange, HueSaturationRow>;
export type PhotoFilterParameters = { color: string; density: number; preserveLuminosity: boolean };
export type AdjustmentParameters = PhotoFilterParameters | ColorLookupParameters | HueSaturationParameters | SelectiveColorParameters | LevelsParameters | CurvesParameters | ChannelMixerParameters | GradientMapParameters | ColorBalanceParameters | BlackWhiteParameters;
export type UnsharpMaskParameters = { amount: number; sigma: number; threshold: number };
export type NoiseParameters = { amount: number; distribution: 'uniform' | 'gaussian'; monochromatic: boolean; seed: number };
export type LocalToneParameters = { shadows: number; highlights: number; shadowWidth: number; highlightWidth: number; sigma: number };
export type LayerFilterParameters = AdjustmentParameters | UnsharpMaskParameters | NoiseParameters | LocalToneParameters;
export type ShapeSpec = { shape: 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | 'star' | 'line'; x: number; y: number; width: number; height: number; fill: string | null; stroke: string | null; strokeWidth: number; radius?: number; sides?: number; innerRadius?: number };
export type PathNode = { x: number; y: number; in?: Point; out?: Point };
export type PathSpec = { nodes: PathNode[]; closed: boolean; fill: string | null; stroke: string | null; strokeWidth: number };
export type GradientSpec = { kind: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond'; start: Point; end: Point; stops: { offset: number; color: string; opacity?: number }[] };
export type LayerEffects = { shadow?: { color: string; opacity: number; blur: number; x: number; y: number }; glow?: { color: string; opacity: number; blur: number } };
export type SavedLayerStyle = { id: string; name: string; outline?: { width: number; color: string }; effects?: LayerEffects };
export type LayerFilter = { id: string; kind: string; value: number; parameters?: LayerFilterParameters; blendMode?: string; enabled: boolean; opacity: number };
export type Layer = { fillOpacity?: number; id: string; name: string; type: string; visible: boolean; opacity: number; blendMode: string; kind?: string; value?: number; parameters?: AdjustmentParameters; mask?: AdditionalMask | null; maskDensity?: number; children?: Layer[]; parentId?: string | null; clipBaseId?: string; mode?: 'pass-through' | 'isolated'; role?: string; provenance?: { jobId?: string; [key: string]: unknown }; width?: number; height?: number; protected?: boolean; outline?: { width: number; color: string }; cutout?: { model: string; sourceLayerId: string }; effects?: LayerEffects | null; filters?: LayerFilter[]; filterMask?: FilterMask; sourceAsset?: string; alphaAsset?: string; placement?: { x: number; y: number; width: number; height: number }; text?: string; x?: number; y?: number; fontSize?: number; tracking?: number; leading?: number; color?: string; fontFamily?: 'sans-serif' | 'serif' | 'monospace' | 'Fraunces'; fontWeight?: 'normal' | 'bold'; fontStyle?: 'normal' | 'italic'; align?: 'left' | 'center' | 'right'; vector?: ShapeSpec | PathSpec; gradient?: GradientSpec; transforms?: Record<string, unknown>[] };
export type Guide = { id: string; axis: 'horizontal' | 'vertical'; position: number };
export type SavedSelection = { id: string; name: string; mask: Mask };
export type Document = { id: string; name: string; width: number; height: number; revision: number; backend: BackendId; layers: Layer[]; editRecipes?: EditRecipe[]; sourceDocument?: { format: 'psd'; asset: string; bytes: number; name: string }; guides?: Guide[]; savedSelections?: SavedSelection[]; layerStyles?: SavedLayerStyle[]; layerOrder?: 'bottom-to-top' | 'top-to-bottom'; selection?: Mask | { left: number; top: number; right: number; bottom: number } | null; history: { id: string; label: string; timestamp: string; active?: boolean; future?: boolean }[]; canUndo: boolean; canRedo: boolean };
export type Histogram = { red: number[]; green: number[]; blue: number[]; luminance: number[]; pixelCount: number };
export type Backend = { colorRangePolicy?: 'sampled-rgb-chebyshev-alpha-v1'; colorRangeLimits?: Partial<typeof COLOR_RANGE_LIMITS>; colorRangePreviewLimits?: Partial<typeof COLOR_RANGE_PREVIEW_LIMITS>; layerFillPolicy?: 'content-alpha-outside-effects-v1'; layerFillContentTypes?: string[]; denseMaskPolicy?: 'framed-raw-alpha8-v1'; denseMaskLimits?: Partial<typeof DENSE_MASK_LIMITS>; channelSelectionPolicy?: 'composite-byte-alpha-v1'; channelSelectionChannels?: string[]; channelPreviewLimits?: Partial<typeof CHANNEL_PREVIEW_LIMITS>; photoFilterPolicy?: 'rgb-transmission-luma-fit-v1'; colorLookupPolicy?: 'cube3d-f64-trilinear-srgb-v1'; colorLookupFormats?: string[]; colorLookupInputSpaces?: string[]; colorLookupLimits?: Partial<typeof COLOR_LOOKUP_LIMITS>; curvesBanksPolicy?: 'master-byte-then-channel-byte-v1'; curvesBankNames?: string[]; hueSaturationPolicy?: 'rgb-hue-triangle-hsl-v1'; hueSaturationRanges?: string[]; selectiveColorPolicy?: 'rgb-partition-cmyk-v1'; selectiveColorMethods?: string[]; selectiveColorRanges?: string[]; curvesInterpolationPolicy?: 'shape-preserving-pchip-v1'; curvesInterpolationModes?: string[]; layerDistortPolicy?: 'fixed-frame-projective-bilinear-v1'; layerDistortCoordinates?: 'stage-pixel-edges'; layerDistortContentTypes?: string[]; documentResizeMethods?: DocumentResizeMethod[]; documentResizeDefault?: DocumentResizeMethod; id: BackendId; label: string; connected: boolean; commands: string[]; limitations: string[]; editRecipeVersion?: number; editRecipeCommands?: EditRecipeCommand[]; editRecipeSlotTypes?: EditRecipeSlot['type'][]; adjustmentKinds?: string[]; layerFilterKinds?: string[]; layerFilterCoordinates?: 'source'; layerFilterSpatialPolicy?: 'alpha-weighted-gaussian-rgb-v1'; layerFilterHighPassPolicy?: 'alpha-weighted-residual-128-v1'; layerFilterUnsharpPolicy?: 'rgb-residual-threshold-v1'; layerFilterNoisePolicy?: 'seeded-rgb-discrete-v1'; layerFilterLocalTonePolicy?: 'alpha-weighted-local-tone-v1'; layerFilterBlendPolicy?: 'candidate-rgb-v1'; layerFilterBlendModes?: string[]; layerFilterBaking?: 'source-rgb'; layerFilterMaskPolicy?: 'source-stack-alpha8-v1'; layerFilterMaskCoordinates?: 'source'; layerFilterMaskSources?: string[]; layerFilterMaskShapes?: string[]; layerFilterMaskProperties?: string[]; layerFilterMaskCaptureGeometry?: 'integer-copy-v1'; layerStyleProperties?: string[]; layerMaskProperties?: string[]; layerMaskPositioning?: 'independent-translation'; layerMaskPositionUnits?: 'document-pixels'; layerMaskPositionOperations?: ('set' | 'rasterize')[]; layerSelectionSources?: ('content' | 'layer-mask')[]; layerSelectionMaskModes?: ('raw' | 'effective')[]; layerSelectionContentTypes?: string[]; retouchSampleModes?: ('current' | 'current-and-below' | 'all')[]; retouchSamplingTools?: string[]; retouchIgnoreAdjustments?: boolean; retouchCurrentAndBelowScope?: 'root-target'; repairLayerPlacement?: 'above-root-raster'; textSpacingProperties?: ('tracking' | 'leading')[]; textTrackingUnits?: 'thousandths-em'; textLeadingUnits?: 'source-pixels'; maskPreviewSources?: ('selection' | 'layer-mask' | 'filter-mask')[]; maskPreviewMaskModes?: ('raw' | 'effective')[]; groupModes?: string[]; groupBlendModes?: string[]; guideAxes?: Guide['axis'][]; guideCoordinates?: 'document-pixels'; clippingLayerTypes?: string[]; clippingBlendPolicy?: 'grouped-base'; morphologyOperations?: string[]; exportFormats?: string[]; exportOptions?: string[]; exportDensityFormats?: string[]; projectFormats?: string[]; layeredExportFormats?: string[]; layeredImportFormats?: string[]; psdImportPolicy?: string; projectBundleVersion?: number; limits?: { maxDistortCorner?: number; maxDistortWork?: number; maxDistortWorkingBytes?: number; maxFilterMaskWorkingBytes?: number; maxFilterMaskCaptureWork?: number; maxFilterBakeWorkingBytes?: number; maxFilterBakeAssetBytes?: number; maxLayerMaskPosition?: number; maxLayerMaskSourcePixels?: number; maxEditRecipes?: number; maxEditRecipeSteps?: number; maxEditRecipeSlots?: number; maxEditRecipeBytes?: number; maxEditRecipeLibraryBytes?: number; maxMaskPreviewEdge?: number; maxMaskPreviewBytes?: number; maxMaskPreviewWorkingBytes?: number; maxProjectBundleBytes?: number; maxPsdImportBytes?: number; maxFiltersPerLayer?: number; maxFiltersPerDocument?: number; maxMorphologyRadius?: number; maxLayerStyles?: number; maxGuides?: number }; blendModes?: string[] };
export type SegmentationStatus = { installed: boolean; disabled?: boolean; model: string; local: boolean; running: boolean; limitations: string[] };
export type Status = { segmentation?: SegmentationStatus; version: string; backends: Backend[]; bridge: { connected: boolean; appVersion?: string; pluginVersion?: string } };
export type Setup = { bridgeUrl: string; pluginPath: string; mcpCommand: string; mcpArgs: string[]; token: string };
export type MaskPreview = { documentId: string; revision: number; source: 'selection' | 'layer-mask' | 'filter-mask'; coordinates?: 'source'; layerId?: string; maskMode?: 'raw' | 'effective'; mimeType: 'image/png'; data: string; width: number; height: number; sourceWidth: number; sourceHeight: number; sampling: 'nearest-pixel-center'; maxEdge: number };
export type ColorRangePreview = ColorRangeSettings & { documentId: string; revision: number; sourceWidth: number; sourceHeight: number; width: number; height: number; coveragePolicy: 'sampled-rgb-chebyshev-alpha-v1'; sampling: 'nearest-pixel-center'; maxEdge: number; mimeType: 'image/png'; data: string };
export type ChannelPreview = { documentId: string; revision: number; sourceWidth: number; sourceHeight: number; width: number; height: number; channel: ChannelSelectionChannel; invert: boolean; coveragePolicy: 'composite-byte-alpha-v1'; sampling: 'nearest-pixel-center'; maxEdge: number; mimeType: 'image/png'; data: string };
export type PsdIssue = { code: string; message: string; layerId?: string; layerName?: string };
export type PsdImportIssue = { code: string; message: string; layerIndex?: number; layerName?: string; recordKey?: string; resourceId?: number };
export type PsdImportReport = {
  format: 'psd'; importerVersion: 1; subsetId: 'rgb8-flat-raster-v1';
  input: { sha256: string; bytes: number }; supported: boolean; validation: 'complete' | 'rejected';
  color?: { policy: 'known-srgb' | 'assumed-srgb'; profileSha256?: string };
  options: { assumeSrgb: boolean }; requiresSrgbAssumption?: boolean;
  document?: { width: number; height: number; layerCount: number; bitsPerChannel: number; colorMode: string; fileVersion?: number; compression?: string[] };
  layers?: { index: number; name: string }[];
  preserves: string[]; omits: string[]; issues: PsdImportIssue[]; warnings: PsdImportIssue[];
  issuesOmitted?: number; warningsOmitted?: number;
  comparison?: { reference: 'stored-merged-rgb'; comparedWith: 'native-flat-recomposition'; maxChannelDifference: number; differingChannels: number; transparentPixels: number; alphaComparable: boolean };
};
export type PsdImportOptions = { assumeSrgb: boolean; sourceName: string; name?: string; expectedSha256: string; importerVersion: 1; requestId: string };
export type PsdReport = { format: 'psd'; version: number; documentId: string; revision: number; supported: boolean; requiresPixelValidation: boolean; bitsPerChannel: number; colorMode: string; mergedComposite: string; layerCount: number; estimatedBytes: number | null; maxBytes: number; issues: PsdIssue[]; warnings: PsdIssue[] };

export type HostedInfo = { email: string; segmentation: boolean; codex: boolean; limits: { maxUploadBytes: number; maxDocuments: number; maxStorageBytes: number } };
export type SignInInfo = { signupOpen: boolean; signupCodeRequired: boolean };
// Set only by a hosted multi-user server (PRISM_HOSTED=1); null in local mode.
let hostedInfo: HostedInfo | null = null;
export const hostedSession = () => hostedInfo;

let tokenPromise: Promise<string> | null = null;
async function session() {
  if (!tokenPromise) tokenPromise = fetch('/api/session').then(async (response) => {
    if (response.status === 401) {
      const result = await response.json().catch(() => null);
      if (result?.hosted) throw Object.assign(new Error('Sign in to continue.'), { code: 'SIGN_IN_REQUIRED', signIn: result.hosted as SignInInfo });
    }
    if (!response.ok) throw new Error('Cannot connect to the local companion. Run npm run dev and refresh.');
    const result = await response.json();
    hostedInfo = result.hosted ?? null;
    return result.token as string;
  }).catch((error) => { tokenPromise = null; throw error; });
  return tokenPromise;
}
export async function startSession() { await session(); return hostedInfo; }

export async function authenticate(mode: 'signin' | 'signup', body: { email: string; password: string; inviteCode?: string }) {
  const response = await fetch(`/api/auth/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.token) throw new Error(result?.error?.message || `Sign-in failed (${response.status}).`);
  hostedInfo = result.hosted; tokenPromise = Promise.resolve(result.token as string);
  return hostedInfo;
}
export async function signOut() {
  await api('/api/auth/signout', {});
  hostedInfo = null; tokenPromise = null;
}
export const accountUsage = () => api<HostedInfo & { usage: { storageBytes: number; documents: number } }>('/api/account');
export async function deleteDocument(documentId: string) {
  const token = await session();
  const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `The document could not be deleted (${response.status}).`);
}

export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = await session();
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    signal,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 401 && hostedInfo) { window.location.reload(); throw new Error('Your session ended. Sign in again.'); }
  const data = await response.json();
  if (!response.ok || data.ok === false) throw Object.assign(new Error(data.error?.message || `The request failed (${response.status}).`), { code: data.error?.code });
  return data as T;
}

export async function command<T>(backend: BackendId, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) {
  return commandWithRequestId<T>(backend, name, args, crypto.randomUUID(), signal);
}
export async function commandWithRequestId<T>(backend: BackendId, name: string, args: Record<string, unknown>, requestId: string, signal?: AbortSignal) {
  const response = await api<{ ok: true; result: T }>('/api/command', { backend, command: name, args, requestId }, signal);
  return response.result;
}

async function binaryError(response: Response) {
  const data = await response.json().catch(() => null);
  return new Error(data?.error?.message || `Project transfer failed (${response.status}).`);
}

export async function exportProjectBundle(document: Document) {
  const token = await session();
  const response = await fetch(`/api/projects/${encodeURIComponent(document.id)}/export?expectedRevision=${document.revision}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw await binaryError(response);
  if (!response.headers.get('content-type')?.startsWith('application/x-prism-project')) throw new Error('The companion did not return an editable Prism project.');
  const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || `${document.name}.prism`;
  return { data: await response.blob(), filename };
}

export async function inspectPsdExport(document: Pick<Document, 'id' | 'revision'>) {
  return api<PsdReport>(`/api/psd/${encodeURIComponent(document.id)}/inspect?expectedRevision=${document.revision}`);
}

export async function exportLayeredPsd(document: Pick<Document, 'id' | 'revision' | 'name'>) {
  const token = await session();
  const response = await fetch(`/api/psd/${encodeURIComponent(document.id)}/export?expectedRevision=${document.revision}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Object.assign(new Error(data?.error?.message || `PSD export failed (${response.status}).`), { code: data?.error?.code, report: data?.report as PsdReport | undefined });
  }
  if (!response.headers.get('content-type')?.startsWith('image/vnd.adobe.photoshop')) throw new Error('The companion did not return a layered PSD.');
  if (response.headers.get('x-prism-document-id') !== document.id || Number(response.headers.get('x-prism-revision')) !== document.revision) throw new Error('The PSD response does not match the inspected document revision. Refresh compatibility before downloading.');
  const maxBytes = 64 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('The PSD exceeds the 64 MiB download limit.');
  const data = await response.blob();
  if (!data.size || data.size > maxBytes) throw new Error('The PSD must be nonempty and no larger than 64 MiB.');
  const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || `${document.name}.psd`;
  return { data, filename };
}

export async function importProjectBundle(file: File, requestId: string) {
  const token = await session();
  const response = await fetch('/api/projects/import', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-prism-project', 'X-Prism-Request-Id': requestId }, body: file });
  if (!response.ok) throw await binaryError(response);
  const result = await response.json() as { document?: Document; historyIncluded?: boolean; error?: { message: string } };
  if (!result.document) throw new Error(result.error?.message || 'The companion did not return the imported project.');
  return result as { document: Document; historyIncluded: false };
}

async function psdImportResponse(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) throw Object.assign(new Error(data?.error?.message || `PSD transfer failed (${response.status}).`), { code: data?.error?.code, status: response.status, report: data?.report as PsdImportReport | undefined });
  if (!data) throw new Error('The companion did not return a PSD compatibility result. Retry the same file.');
  return data;
}

export async function inspectPsdImport(file: File, assumeSrgb: boolean, signal: AbortSignal) {
  const token = await session();
  const query = new URLSearchParams({ assumeSrgb: String(assumeSrgb), sourceName: file.name });
  const response = await fetch(`/api/psd/inspect-import?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/vnd.adobe.photoshop' }, body: file, signal });
  return await psdImportResponse(response) as PsdImportReport;
}

export async function importLayeredPsd(file: File, options: PsdImportOptions) {
  const token = await session();
  const query = new URLSearchParams({ assumeSrgb: String(options.assumeSrgb), sourceName: options.sourceName, ...(options.name ? { name: options.name } : {}) });
  const response = await fetch(`/api/psd/import?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/vnd.adobe.photoshop', 'X-Prism-Request-Id': options.requestId, 'X-Prism-Expected-Sha256': options.expectedSha256, 'X-Prism-Importer-Version': String(options.importerVersion) }, body: file });
  const result = await psdImportResponse(response) as { document?: Document; report?: PsdImportReport; historyIncluded?: boolean };
  if (!result.document || !result.report || result.historyIncluded !== false || result.document.sourceDocument?.asset !== options.expectedSha256 || result.report.input?.sha256 !== options.expectedSha256) throw new Error('The PSD import response did not match this file. Retry the same request to recover its result.');
  return { document: result.document, report: result.report, historyIncluded: false as const };
}

export async function downloadOriginalPsd(document: Document) {
  const archive = document.sourceDocument;
  if (archive?.format !== 'psd') throw new Error('This document has no retained original PSD.');
  const token = await session();
  const response = await fetch(`/api/psd/${encodeURIComponent(document.id)}/original?expectedRevision=${document.revision}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) await psdImportResponse(response);
  if (!response.headers.get('content-type')?.startsWith('application/octet-stream') || response.headers.get('x-prism-source-sha256') !== archive.asset || response.headers.get('x-prism-document-id') !== document.id || Number(response.headers.get('x-prism-revision')) !== document.revision) throw new Error('The original PSD response does not match the selected document. Refresh and try again.');
  const bytes = Number(response.headers.get('content-length'));
  if (bytes !== archive.bytes || bytes < 1 || bytes > 64 * 1024 * 1024) throw new Error('The original PSD has an unexpected file size.');
  const data = await response.blob();
  if (data.size !== archive.bytes) throw new Error('The original PSD download was incomplete. Try again.');
  const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || archive.name;
  return { data, filename };
}

export function downloadBlob(data: Blob, filename: string) {
  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('This file could not be read.'));
    reader.readAsDataURL(file);
  });
}

export async function sampleImage() {
  const response = await fetch('/sample-art.svg');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}

export function downloadBase64(data: string, mimeType: string, filename: string) {
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  downloadBlob(new Blob([bytes], { type: mimeType }), filename);
}

export function canEditCutoutAlpha(layer: Layer | undefined, document: Document | null) {
  return Boolean(document && layer?.type === 'raster' && layer.alphaAsset && !layer.filters?.length && !layer.placement && !layer.transforms?.length && layer.width === document.width && layer.height === document.height);
}
