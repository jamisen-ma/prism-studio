import { ChatPanel } from './ChatPanel';
import { useChat, type ChatTurn } from './chat';
import { ColorRangeSelection } from './ColorRangeSelection';
import { colorRangeSupport } from './color-range';
import { LayerFill } from './LayerFill';
import { isFillContent, layerFillReason } from './layer-fill';
import { ChannelSelection } from './ChannelSelection';
import { useChannelSelection } from './useChannelSelection';
import { channelSupport, denseCapabilityKey, denseCommandMasks, supportsMask } from './dense-mask';
import { ColorLookup } from './ColorLookup';
import { isBankedCurves } from './curves';
import { supportsFilterBake } from './filter-bake';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronDown,
  ChevronRight, CircleHelp, Copy, Crop, Download, Ellipsis, Eye, EyeOff, FileImage,
  FolderOpen, Hand, History, ImagePlus, Layers, Link2, LoaderCircle, Maximize,
  Minus, MousePointer2, PanelRightClose, Plus, Redo2, Save, Scan, Settings2,
  SlidersHorizontal, Sparkles, SquareDashed, Sun, Trash2, Type, Undo2, Upload, X,
  ZoomIn, ZoomOut, CircleAlert, ExternalLink, Palette, Focus, Scissors, ShieldCheck,
  Paintbrush, Eraser, Stamp, Bandage, CircleDashed, Lasso, Flame, Move, Search, PenTool, Square, PaintBucket, Pipette, Wand,
} from 'lucide-react';
import { AccountMenu } from './Hosted';
import { api, deleteDocument, hostedSession, canEditCutoutAlpha, command, commandWithRequestId, downloadBase64, downloadBlob, downloadOriginalPsd, exportProjectBundle, importProjectBundle, fileBase64, sampleImage, type BackendId, type Document, type Layer, type Mask, type Setup, type Status } from './api';
import { BrushOptions, CanvasProOverlay, isBrushTool, isPaintTool, isSelectionTool, SelectionOptions, SelectionOverlay, useCanvasTools, type BrushSettings, type CanvasTool } from './CanvasTools';
import { AdjustmentProperties, ColorWorkbench, LayerMaskProperties, PARAMETERIZED_COLOR_KINDS, SCALAR_ADJUSTMENTS, TransformForm, validAdjustmentValue } from './ProPanels';
import { ToolBrowser, type CatalogEntry } from './ToolBrowser';
import toolCatalog from '../shared/tool-catalog.json';
import { DEFAULT_GRADIENT, DEFAULT_PATH, DEFAULT_SHAPE, GradientProperties, PathProperties, ShapeProperties, useVectorCanvas, VectorOverlay, VectorToolOptions } from './VectorTools';
import { CLICK_COMMANDS, CLICK_TOOLS, rasterPointerDown, RasterOptions } from './RasterTools';
import { useColorSample } from './useColorSample';
import { GenerationPanel } from './GenerationPanel';
import { ResizePanel, type ResizeDraft } from './ResizePanel';
import { resizeCapabilityKey } from './resize-methods';
import { maskPositionCapabilities } from './MaskPosition';
import { CutoutPanel, CutoutLayerProperties } from './CutoutPanel';
import { captureGesture, releaseGesturePointer, type GestureContext, type PointerCapture } from './gesture';
import { useMoveTool, MoveOptions, MoveGuide } from './MoveTool';
import { CanvasRulers, GuideOverlay, GuidesPanel, useGuideView } from './Guides';
import { LayerEffects } from './LayerEffects';
import { LayerFilters } from './LayerFilters';
import { DistortOverlay, DistortPanel, useDistort } from './Distort';
import { ExportPanel } from './ExportPanel';
import { PsdImport, usePsdImport } from './PsdImport';
import { LayerStack } from './LayerStack';
import { SavedSelections } from './SavedSelections';
import { LayerSelection } from './LayerSelection';
import { MaskInspection, type MaskInspectionTarget } from './MaskInspection';
import { TextCreationForm, TextProperties } from './TextTools';
import { CanvasTextEditor, textLayerAt, type TextDraft } from './CanvasText';
import { EditRecipes, useRecipeApplication } from './EditRecipes';
import { DEFAULT_RETOUCH, effectiveRetouch, RetouchOptions, retouchCapabilities, repairSourceReason, type RetouchSampling } from './RetouchTools';
import { clippingChainFor, reorderSplitsClippingChain } from './clipping';
import { displayLayers, hasProtectedContent } from './layer-tree';
import { useGenerationJobs, type GenerationJob } from './generation';
import './pro-tools.css';
import './color-swatches.css';

type Tool = CanvasTool;
type Tab = 'chat' | 'layers' | 'selections' | 'adjustments' | 'history' | 'guides';
type Rect = Mask;
type Modal = 'setup' | 'new' | 'resize' | 'text' | 'export' | 'help' | 'transform' | 'tools' | 'generate' | 'cutouts' | 'psdImport' | 'maskInspection' | 'recipes' | null;
type Toast = { message: string; error?: boolean; retry?: () => void };
const ADJUSTMENTS = SCALAR_ADJUSTMENTS;
const TOOL_LABELS: Record<Tool, string> = { pointer: 'Inspect', move: 'Move', select: 'Rectangle selection', ellipse: 'Ellipse selection', lasso: 'Lasso selection', crop: 'Crop', text: 'Text', hand: 'Hand', brush: 'Brush', eraser: 'Eraser', clone: 'Clone stamp', heal: 'Healing brush', dodge: 'Dodge', burn: 'Burn', pencil: 'Pencil', blur: 'Blur brush', sharpen: 'Sharpen brush', smudge: 'Smudge', sponge: 'Sponge', red_eye: 'Red eye correction', color_replace: 'Color replacement', shape: 'Vector shape', pen: 'Pen', gradient: 'Gradient', path_edit: 'Direct selection', magic_wand: 'Magic wand', bucket: 'Paint bucket', magic_eraser: 'Magic eraser', eyedropper: 'Eyedropper', selection_brush: 'Selection brush', mask_brush: 'Mask brush', cutout_brush: 'Subject cutout brush', row_select: 'Single row selection', column_select: 'Single column selection' };
const TOOL_HINTS: Record<Tool, string> = { pointer: 'Your canvas. Your next idea.', move: 'Drag the selected layer · integer pixel translation', select: 'Drag to select a rectangular area', ellipse: 'Drag to select an elliptical area', lasso: 'Draw around an area; release to close the selection', crop: 'Drag on the image, then apply your crop', text: 'Click to type, or drag to draw a text box · ⌘Enter or click outside to commit', hand: 'Drag to pan around your canvas', brush: 'Paint on a raster layer · [ ] to resize', eraser: 'Erase pixels to transparency · [ ] to resize', clone: 'Option / Alt-click to sample, then paint', heal: 'Sampled texture blending · Option / Alt-click to sample', dodge: 'Paint to lighten · pressure controls coverage', burn: 'Paint to darken · pressure controls coverage', pencil: 'Paint with a crisp, hard tip', blur: 'Soften detail where you paint', sharpen: 'Increase local detail where you paint', smudge: 'Drag pixels along your stroke', sponge: 'Positive strength saturates; negative desaturates', red_eye: 'Paint over red pupils to neutralize them', color_replace: 'Replace colors close to your starting sample', shape: 'Drag to create an editable vector shape', pen: 'Click to add anchors; drag for Bézier handles; Enter to finish', gradient: 'Drag to set the direction of a new gradient layer', path_edit: 'Drag path anchors to reshape an editable path', magic_wand: 'Click to select a color-connected region', bucket: 'Click to fill a matching color region', magic_eraser: 'Click to erase a matching color region', eyedropper: 'Click to sample the visible composite', selection_brush: 'Paint the area you want to select', mask_brush: 'Paint the selected layer’s mask', cutout_brush: 'Add restores original subject pixels; subtract removes background coverage', row_select: 'Click to select one row of pixels', column_select: 'Click to select one column of pixels' };
const NON_DOCUMENT_COMMANDS = new Set(['create_document', 'import_image']);
const DOCUMENT_READ_COMMANDS = new Set(['save_document', 'export_document']);
function documentSelection(document: Document): Rect | null {
  const selection = document.selection;
  if (!selection) return null;
  if ('left' in selection) return { x: selection.left, y: selection.top, width: selection.right - selection.left, height: selection.bottom - selection.top };
  return selection;
}

function PrismMark({ small = false }: { small?: boolean }) {
  return <span className={`prism-mark ${small ? 'small' : ''}`}><svg viewBox="0 0 32 32" fill="none"><path d="M16 5 28 27H4L16 5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="m16 5 1 22M4 27l16-15" stroke="currentColor" strokeWidth="1.3" opacity=".65" /></svg></span>;
}

function ButtonIcon({ children, label, onClick, disabled = false, active = false, className = '' }: { children: React.ReactNode; label: string; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string }) {
  return <button type="button" className={`icon-button ${active ? 'active' : ''} ${className}`} title={label} aria-label={label} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function App() {
  const [backend, setBackend] = useState<BackendId>('native');
  const [status, setStatus] = useState<Status | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('Opening your workspace');
  const [connectionError, setConnectionError] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [tool, setTool] = useState<Tool>('move');
  const [tab, setTab] = useState<Tab>('chat');
  const [selectedLayerId, setSelectedLayerId] = useState('');
  const [selection, setSelection] = useState<Rect | null>(null);
  const [cropDraft, setCropDraft] = useState<Rect | null>(null);
  const [retouchSampling, setRetouchSampling] = useState<RetouchSampling>(DEFAULT_RETOUCH);
  const retouchContextRef = useRef({ tool, documentId: '', revision: 0, layerId: '' });
  const [brush, setBrush] = useState<BrushSettings>({ size: 48, hardness: 0.7, opacity: 0.8, flow: 1, color: '#d9b7ff', strength: 50, tolerance: 48, mode: 'add' });
  const [shapeSettings, setShapeSettings] = useState(DEFAULT_SHAPE);
  const [pathSettings, setPathSettings] = useState(DEFAULT_PATH);
  const [gradientSettings, setGradientSettings] = useState(DEFAULT_GRADIENT);
  const [contiguous, setContiguous] = useState(true);
  // Paint Bucket / Magic Eraser keep their own opacity (Photoshop defaults them to 100%), separate from the brush.
  const [fillOpacity, setFillOpacity] = useState(1);
  const [sampleRadius, setSampleRadius] = useState(0);
  const [selectionFeather, setSelectionFeather] = useState(0);
  const [selectionInvert, setSelectionInvert] = useState(false);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [fitZoom, setFitZoom] = useState(0.4);
  const [guideView, setGuideView] = useGuideView();
  const [modal, setModalState] = useState<Modal>(null);
  const modalRef = useRef<Modal>(null);
  const setModal = useCallback((value: Modal | ((current: Modal) => Modal)) => { const next = typeof value === 'function' ? value(modalRef.current) : value; modalRef.current = next; setModalState(next); }, []);
  const [resizeSession, setResizeSession] = useState(0);
  const resizeSessionRef = useRef(0);
  const [maskInspectionTarget, setMaskInspectionTarget] = useState<MaskInspectionTarget | null>(null);
  const [exportKind, setExportKind] = useState<'image' | 'project'>('image');
  const [resizeMode, setResizeMode] = useState<'scale' | 'canvas'>('scale');
  const [resizeReview, setResizeReview] = useState<{ documentId: string; draft: ResizeDraft; layerId: string } | null>(null);
  const [cutoutAction, setCutoutAction] = useState<'extract' | 'select' | 'place'>('extract');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [setupError, setSetupError] = useState('');
  const [setupTab, setSetupTab] = useState<'photoshop' | 'mcp'>('mcp');
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState('');
  const [fileMenu, setFileMenu] = useState(false);
  const [backendMenu, setBackendMenu] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [generationFocusId, setGenerationFocusId] = useState('');
  const [adjustmentValues, setAdjustmentValues] = useState<Record<string, number>>({});
  const [activeAdjustment, setActiveAdjustment] = useState('exposure');
  const [newName, setNewName] = useState('Untitled canvas');
  const [sizeWidth, setSizeWidth] = useState(1600);
  const [sizeHeight, setSizeHeight] = useState(1200);
  const [newColor, setNewColor] = useState('#f4f0e8');
  const [textValue, setTextValue] = useState('A new perspective.');
  const [textSize, setTextSize] = useState(64);
  const [textColor, setTextColor] = useState('#ffffff');
  // Photoshop-style foreground/background pair. The foreground feeds brush, bucket, text, shape fill and the
  // gradient start; the background feeds the gradient end. X swaps, D resets to black/white.
  const [backgroundColor, setBackgroundColor] = useState('#000000');
  const setForegroundColor = useCallback((color: string) => {
    setTextColor(color); setBrush(current => ({ ...current, color }));
    setShapeSettings(current => current.fill ? { ...current, fill: color } : current);
    setGradientSettings(current => ({ ...current, stops: [{ ...current.stops[0], color }, ...current.stops.slice(1)] }));
  }, []);
  const setBackgroundSwatch = useCallback((color: string) => {
    setBackgroundColor(color);
    setGradientSettings(current => ({ ...current, stops: [...current.stops.slice(0, -1), { ...current.stops.at(-1)!, color }] }));
  }, []);
  const foregroundColor = isPaintTool(tool) ? brush.color : textColor;
  const swatchRef = useRef({ foreground: foregroundColor, background: backgroundColor });
  swatchRef.current = { foreground: foregroundColor, background: backgroundColor };
  const swapColors = useCallback(() => { const { foreground, background } = swatchRef.current; setForegroundColor(background); setBackgroundSwatch(foreground); }, [setForegroundColor, setBackgroundSwatch]);
  const resetColors = useCallback(() => { setForegroundColor('#000000'); setBackgroundSwatch('#ffffff'); }, [setForegroundColor, setBackgroundSwatch]);
  const [textFamily, setTextFamily] = useState<NonNullable<Layer['fontFamily']>>('sans-serif');
  const [textWeight, setTextWeight] = useState<'normal' | 'bold'>('normal');
  const [textStyle, setTextStyle] = useState<'normal' | 'italic'>('normal');
  const [textPosition, setTextPosition] = useState({ x: 100, y: 100 });
  const [textAlign, setTextAlign] = useState<'left' | 'center' | 'right'>('left');
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null);
  const [textDrag, setTextDrag] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const textCommit = useRef<(() => Promise<void>) | null>(null);
  const textHit = useRef<ReturnType<typeof textLayerAt>>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const psdInputRef = useRef<HTMLInputElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<Document | null>(null);
  const busyRef = useRef(busy);
  const backendRef = useRef(backend);
  const startPoint = useRef<{ x: number; y: number; tool: Tool; context: GestureContext; feather: number; invert: boolean; pointer: PointerCapture } | null>(null);
  const cropContext = useRef<GestureContext | null>(null);
  const selectedLayerRef = useRef(selectedLayerId); selectedLayerRef.current = selectedLayerId;
  const panStart = useRef<{ x: number; y: number; left: number; top: number; pointer: PointerCapture } | null>(null);
  const springHand = useRef<Tool | null>(null);
  const refreshVersion = useRef(0);
  const pendingGenerationDocument = useRef<{ documentId: string; layerId?: string } | null>(null);
  const interactingRef = useRef(false);
  docRef.current = doc; busyRef.current = busy; backendRef.current = backend;
  const activeBackend = status?.backends.find((item) => item.id === backend);
  const denseEpochKey = `${backend}:${doc?.id}:${denseCapabilityKey(activeBackend)}`;
  const denseEpoch = useRef({ key: denseEpochKey, value: 0 }); if (denseEpoch.current.key !== denseEpochKey) denseEpoch.current = { key: denseEpochKey, value: denseEpoch.current.value + 1 };
  const activeBackendRef = useRef(activeBackend); activeBackendRef.current = activeBackend;
  const captureResizeCapabilityGuard = (mode: 'scale' | 'canvas') => { const id = backendRef.current; const key = resizeCapabilityKey(activeBackendRef.current, id, mode); return () => backendRef.current === id && resizeCapabilityKey(activeBackendRef.current, id, mode) === key; };
  const connected = Boolean(activeBackend?.connected);
  const canBakeFilters = doc?.backend === backend && supportsFilterBake(activeBackend);
  const visibleLayers = displayLayers(doc);
  const selectedLayer = visibleLayers.find((layer) => layer.id === selectedLayerId);
  const siblingLayers = backend === 'native' ? (doc?.layers || []).filter(layer => (layer.parentId || null) === (selectedLayer?.parentId || null)) : selectedLayer?.parentId ? visibleLayers.find(layer => layer.id === selectedLayer.parentId)?.children || [] : doc?.layers || [];
  const selectedProtected = backend === 'native' ? hasProtectedContent(doc?.layers || [], selectedLayer) : Boolean(selectedLayer?.protected);
  const selectedClipping = Boolean(doc && clippingChainFor(doc.layers, selectedLayer));
  const selectedStackIndex = siblingLayers.findIndex((layer) => layer.id === selectedLayerId);
  const stackDirection = doc?.layerOrder === 'bottom-to-top' || backend === 'native' ? 1 : -1;
  const layerUpIndex = selectedStackIndex + stackDirection;
  const layerDownIndex = selectedStackIndex - stackDirection;
  const availableAdjustments = backend === 'photoshop' ? ADJUSTMENTS.filter((item) => ['exposure', 'brightness', 'contrast', 'saturation'].includes(item.id)) : ADJUSTMENTS.filter((item) => !item.nativeOnly || activeBackend?.adjustmentKinds?.includes(item.id));
  const adjustmentValue = (id: string) => adjustmentValues[id] ?? ADJUSTMENTS.find(item => item.id === id)?.initial ?? 0;
  const canvasSelection = tool === 'crop' ? cropDraft : selection;
  const activeSelection = doc ? documentSelection(doc) : null;
  const can = (name: string) => Boolean(activeBackend?.commands.includes(name));
  const canRecipes = backend === 'native' && activeBackend?.editRecipeVersion === 1 && can('get_edit_recipe');
  const canProjectBundle = backend === 'native' && Boolean(activeBackend?.projectFormats?.includes('prism'));
  const canPsdImport = backend === 'native' && Boolean(activeBackend?.layeredImportFormats?.includes('psd')) && activeBackend?.psdImportPolicy === 'rgb8-flat-raster-v1';
  const hasGuides = backend === 'native' && can('add_guide') && activeBackend?.guideCoordinates === 'document-pixels' && Boolean(activeBackend.guideAxes?.length);
  const rulersVisible = Boolean(hasGuides && doc && guideView.rulers);
  const hasSelectionLibrary = backend === 'native' && can('save_selection');
  const hasLayerSelection = backend === 'native' && can('load_layer_selection') && Boolean(activeBackend?.layerSelectionSources?.length && activeBackend?.layerSelectionMaskModes?.length && activeBackend?.layerSelectionContentTypes?.length);
  const canInspectCoverage = backend === 'native' && can('get_mask_preview');
  const canInspectSelection = canInspectCoverage && Boolean(activeBackend?.maskPreviewSources?.includes('selection'));
  const canInspectLayerMask = canInspectCoverage && Boolean(activeBackend?.maskPreviewSources?.includes('layer-mask') && activeBackend.maskPreviewMaskModes?.length);
  const hasChannelSelection = backend === 'native' && Boolean(activeBackend?.channelSelectionPolicy || can('load_channel_selection') || can('get_channel_preview'));
  const hasColorRange = backend === 'native';
  const hasSelectionPanel = hasSelectionLibrary || hasLayerSelection || canInspectSelection || hasChannelSelection || hasColorRange;
  const maskPositionSupport = maskPositionCapabilities(activeBackend);
  const hasMaskInspector = can('set_layer_mask') || can('mask_from_selection') || can('modify_layer_mask') || can('morph_layer_mask') || canInspectLayerMask || maskPositionSupport.set || maskPositionSupport.rasterize || selectedLayer?.mask?.shape === 'positioned';
  const maskInspectorKey = `${backend}:${doc?.id}:${selectedLayerId}:${JSON.stringify([denseCapabilityKey(activeBackend),activeBackend?.commands, activeBackend?.layerMaskPositioning, activeBackend?.layerMaskPositionUnits, activeBackend?.layerMaskPositionOperations, activeBackend?.limits?.maxLayerMaskPosition, activeBackend?.layerMaskProperties, activeBackend?.morphologyOperations])}`;
  const maskContextKey = `${maskInspectorKey}:${doc?.revision}`;
  useEffect(() => { if (resizeReview && (backend !== 'native' || doc?.id !== resizeReview.documentId)) setResizeReview(null); }, [backend, doc?.id, resizeReview]);
  useEffect(() => { if (resizeReview && !modal && tab === 'layers' && selectedLayerId === resizeReview.layerId) { const node = window.document.querySelector<HTMLElement>('.mask-position') || window.document.querySelector<HTMLElement>('.layer-mask-properties'); node?.focus(); node?.scrollIntoView({ block: 'nearest' }); } }, [resizeReview, modal, tab, selectedLayerId]);
  useEffect(() => {
    if (modal === 'maskInspection' && maskInspectionTarget && (!doc || backend !== maskInspectionTarget.backend || doc.id !== maskInspectionTarget.documentId || (maskInspectionTarget.source !== 'selection' && selectedLayerId !== maskInspectionTarget.layerId))) setModal(null);
  }, [modal, maskInspectionTarget, backend, doc?.id, selectedLayerId]);
  useEffect(() => { if (tab === 'guides' && !hasGuides) setTab('layers'); }, [tab, hasGuides]);
  useEffect(() => { if (tab === 'selections' && !hasSelectionPanel) setTab('layers'); }, [tab, hasSelectionPanel]);

  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const sampleColor = useColorSample({
    document: doc, backend, tool, radius: sampleRadius, brushColor: brush.color, textColor,
    available: connected && can('sample_color'), busy: Boolean(busy), notify,
    isDocumentCurrent: captured => !busyRef.current && backendRef.current === captured.backend && docRef.current?.id === captured.id && docRef.current.revision === captured.revision && Boolean(activeBackendRef.current?.connected && activeBackendRef.current.commands.includes('sample_color')),
    setColor: setForegroundColor, setBackground: setBackgroundSwatch, backgroundColor,
  });
  useEffect(() => { if (toast && !toast.retry) { const timer = setTimeout(() => setToast(null), toast.error ? 9000 : 3800); return () => clearTimeout(timer); } }, [toast]);

  const updateDocument = useCallback(async (next: Document, targetBackend: BackendId, acceptPreview?: () => boolean) => {
    if (backendRef.current !== targetBackend) return;
    docRef.current = next;
    setDoc(next);
    setSelection(documentSelection(next));
    setCropDraft(null);
    setDocuments((current) => { const found = current.find((item) => item.id === next.id); return found ? current.map((item) => item.id === next.id ? next : item) : [...current, next]; });
    const layers = displayLayers(next);
    setSelectedLayerId((current) => layers.some((layer) => layer.id === current) ? current : layers[0]?.id || '');
    const version = ++refreshVersion.current;
    const result = await command<{ data: string; mimeType: string }>(targetBackend, 'get_preview', { documentId: next.id, maxWidth: 2000 });
    if (version === refreshVersion.current && backendRef.current === targetBackend && acceptPreview?.() !== false) setPreview(`data:${result.mimeType};base64,${result.data}`);
  }, []);

  const reconcileRecipeDocument = async (next: Document) => {
    if (backendRef.current === 'native' && docRef.current?.id === next.id && docRef.current.revision <= next.revision) await updateDocument(next, 'native');
  };
  const recipeApplication = useRecipeApplication({ backend, document: doc, notify, reconcile: reconcileRecipeDocument, setBusy: label => { busyRef.current = label; setBusy(label); } });
  const recipeMutation = async (name: string, args: Record<string, unknown>) => {
    if (busyRef.current) return null;
    if (backendRef.current !== 'native' || !docRef.current || docRef.current.id !== args.documentId || docRef.current.revision !== args.expectedRevision) throw Error('The recipe document changed. Refresh before saving library changes.');
    busyRef.current = 'Updating recipe library'; setBusy('Updating recipe library');
    try { const result = await command<{ document?: Document; recipeId?: string }>('native', name, args); if (result.document) { const fresh = await command<{ document: Document }>('native', 'get_document', { documentId: result.document.id }); await reconcileRecipeDocument(fresh.document); } return result; }
    finally { busyRef.current = ''; setBusy(''); }
  };
  const refreshRecipeDocument = async () => { const current = docRef.current; if (backendRef.current !== 'native' || !current) return; const fresh = await command<{ document: Document }>('native', 'get_document', { documentId: current.id }); await reconcileRecipeDocument(fresh.document); };
  useEffect(() => { if (modal === 'recipes' && (!doc || !canRecipes)) setModal(null); }, [modal, doc?.id, canRecipes]);

  const psdImport = usePsdImport({ enabled: canPsdImport && connected, active: modal === 'psdImport', policy: activeBackend?.psdImportPolicy || '', maxBytes: activeBackend?.limits?.maxPsdImportBytes || 64 * 1024 * 1024, onImported: async (document, report) => {
    if (backendRef.current === 'native') { await updateDocument(document, 'native'); setZoom('fit'); setTab('layers'); }
    setModal(value => value === 'psdImport' ? null : value);
    notify(`PSD imported as a new document. History starts here.${report.warnings?.length ? ` ${report.warnings.length} compatibility warning${report.warnings.length === 1 ? '' : 's'} were shown in the review.` : ''}`);
  } });
  const openMaskInspection = (source: 'selection' | 'layer-mask' | 'filter-mask', layerId?: string) => {
    const current = docRef.current;
    if (!current || backendRef.current !== 'native' || busyRef.current || !connected) return;
    setMaskInspectionTarget({ backend: 'native', documentId: current.id, source, ...(layerId ? { layerId } : {}) }); setModal('maskInspection');
  };
  const closeModal = () => {
    if (modal === 'psdImport') { if (psdImport.importing) return; if (!psdImport.frozen || psdImport.canReplaceRejected) psdImport.discard(); }
    setModal(null);
  };
  const reviewPsd = (file: File) => {
    if (busyRef.current || psdImport.importing) return;
    try {
      if (psdImport.frozen && !psdImport.canReplaceRejected) { setModal('psdImport'); notify('Resolve the retained PSD import before choosing a different file.', true); return; }
      if (psdImport.begin(file)) { setFileMenu(false); setModal('psdImport'); }
    } catch (error) { notify(error instanceof Error ? error.message : 'The PSD file could not be reviewed.', true); }
  };
  const downloadSourcePsd = async () => {
    const current = docRef.current;
    if (!current || !canPsdImport || busyRef.current) return;
    setFileMenu(false); setBusy('Downloading original PSD'); busyRef.current = 'Downloading original PSD';
    try { const result = await downloadOriginalPsd(current); downloadBlob(result.data, result.filename); notify('Original PSD archive download started. This is the imported file, not a new export.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'The original PSD could not be downloaded.', true); }
    finally { setBusy(''); busyRef.current = ''; }
  };

  const loadWorkspace = useCallback(async (targetBackend: BackendId) => {
    setBusy('Opening your workspace');
    setConnectionError('');
    setDoc(null); docRef.current = null; setPreview(''); setDocuments([]); setSelection(null);
    try {
      const nextStatus = await api<Status>('/api/status');
      setStatus(nextStatus);
      if (!nextStatus.backends.find((item) => item.id === targetBackend)?.connected) return;
      const result = await command<{ documents: Document[] }>(targetBackend, 'list_documents');
      if (backendRef.current !== targetBackend) return;
      setDocuments(result.documents);
      const requested = targetBackend === 'native' ? pendingGenerationDocument.current : null;
      let lastActive: string | null = null; try { lastActive = localStorage.getItem(`prism.activeDocument.${targetBackend}`); } catch { /* storage unavailable */ }
      let next = result.documents.find((item) => item.id === requested?.documentId) || result.documents.find((item) => item.id === lastActive) || result.documents[0];
      if (!next && targetBackend === 'native') {
        setBusy('Preparing your first canvas');
        const imported = await command<{ document: Document }>('native', 'import_image', { name: 'Solstice — study 001', data: await sampleImage(), mimeType: 'image/png' });
        next = imported.document;
      }
      if (next) {
        await updateDocument(next, targetBackend);
        if (requested?.layerId && next.id === requested.documentId) setSelectedLayerId(requested.layerId);
        if (requested) pendingGenerationDocument.current = null;
      }
    } catch (error) { setConnectionError(error instanceof Error ? error.message : 'The companion is unavailable.'); }
    finally { setBusy(''); }
  }, [updateDocument]);

  // Reopen the document the person was last working on after a reload.
  useEffect(() => { if (doc?.id && doc.backend === backend) try { localStorage.setItem(`prism.activeDocument.${backend}`, doc.id); } catch { /* storage unavailable */ } }, [doc?.id, doc?.backend, backend]);
  useEffect(() => { if (backend === 'photoshop') { setActiveAdjustment('exposure'); setTool('pointer'); } void loadWorkspace(backend); }, [backend, loadWorkspace]);
  const chatRunningRef = useRef(false);
  useEffect(() => {
    const timer = setInterval(async () => {
      if (busyRef.current || interactingRef.current) return;
      try {
        const nextStatus = await api<Status>('/api/status');
        setStatus(nextStatus);
        setConnectionError('');
        const current = docRef.current;
        const target = backendRef.current;
        if (nextStatus.backends.find((item) => item.id === target)?.connected) {
          const result = await command<{ documents: Document[] }>(target, 'list_documents');
          if (busyRef.current || backendRef.current !== target) return;
          setDocuments(result.documents);
          const next = result.documents.find((item) => item.id === current?.id) || result.documents[0];
          // While a chat request runs, keep the canvas on the pre-edit image; the result is shown when it finishes.
          if (next && (!current || next.id !== current.id || next.revision !== current.revision) && !(chatRunningRef.current && target === 'native' && current)) await updateDocument(next, target);
          else if (!next && current) { setDoc(null); docRef.current = null; setPreview(''); setSelection(null); }
        }
      } catch {
        setConnectionError('The local companion disconnected. Start it again, then reconnect to your workspace.');
        setStatus((previous) => previous ? { ...previous, backends: previous.backends.map((item) => ({ ...item, connected: false })) } : previous);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [updateDocument]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !doc) return;
    const updateFit = () => setFitZoom(Math.min((viewport.clientWidth - 100) / doc.width, (viewport.clientHeight - 100) / doc.height, 1));
    const observer = new ResizeObserver(updateFit);
    observer.observe(viewport); updateFit();
    return () => observer.disconnect();
  }, [doc?.width, doc?.height, inspectorOpen, tab]);

  const run = useCallback(async (name: string, args: Record<string, unknown> = {}, label = 'Updating canvas', gesture?: GestureContext) => {
    const rangeEdit = Boolean(gesture?.channelSelection?.producer === 'color-range' && name === 'load_color_range_selection');
    const channelEdit = rangeEdit || Boolean(gesture?.channelSelection && gesture.channelSelection.producer !== 'color-range' && name === 'load_channel_selection');
    const fillEdit = Boolean(gesture?.fill && name === 'set_layer_fill');
    const distortEdit = Boolean(gesture?.distort && ['add_layer_distort', 'update_layer_distort', 'delete_layer_distort'].includes(name));
    const filterMaskEdit = ['set_layer_filter_mask', 'modify_layer_filter_mask', 'clear_layer_filter_mask'].includes(name);
    const maskEdit = filterMaskEdit || ['set_layer_mask_position', 'apply_layer_mask_position', 'modify_layer_mask', 'set_layer_mask', 'mask_from_selection', 'morph_layer_mask'].includes(name);
    const lookupEdit = Boolean(gesture?.lookup && ['import_color_lookup', 'get_document'].includes(name));
    const lookupReview = lookupEdit && name === 'get_document';
    const addedLookup = lookupEdit && name === 'import_color_lookup' && args.target === 'adjustment' && !args.layerId;
    const colorEdit = ['add_adjustment', 'update_adjustment', 'add_layer_filter', 'update_layer_filter', 'import_color_lookup'].includes(name);
    const preciseColorEdit = Boolean(colorEdit && gesture?.preciseColor);
    const stackEdit = ['bake_layer_filters', 'clear_layer_filters', 'reorder_layer_filter', 'delete_layer_filter'].includes(name);
    const retouchEdit = Boolean(gesture?.retouch && name === 'paint_stroke' && (args.tool === 'clone' || args.tool === 'heal'));
    const guardedResult = Boolean(gesture && (fillEdit || lookupEdit || distortEdit || maskEdit || stackEdit || colorEdit || retouchEdit || name === 'create_repair_layer'));
    if (busyRef.current) { if (gesture) notify(fillEdit ? 'Fill was not sent because another edit is running. Your draft is retained.' : distortEdit ? 'Distortion was not sent because another edit is running. Your draft is retained.' : stackEdit ? 'Filter stack edit cancelled because another edit is running. Wait for it to finish, then try again.' : colorEdit ? 'Color edit cancelled because another edit is running. Wait for it to finish, then try again.' : maskEdit ? filterMaskEdit ? 'Effect mask edit cancelled because another edit is running. Wait for it to finish, then try again.' : 'Mask edit cancelled because another edit is running. Wait for it to finish, then try again.' : name === 'create_repair_layer' ? 'Repair layer creation cancelled because another edit is running. Wait for it to finish, then try again.' : name === 'load_layer_selection' ? 'Selection loading cancelled because another edit is running. Wait for it to finish, then try again.' : ['add_text', 'update_text'].includes(name) ? 'Text update cancelled because another edit is running. Wait for it to finish, then try again.' : 'Gesture cancelled because another edit is running. Wait for it to finish, then start again.', true); return null; }
    const target = backendRef.current;
    const current = docRef.current;
    const consumedDense = current ? denseCommandMasks(name, args, current) : [];
    if (consumedDense.some(mask => !supportsMask(mask, activeBackendRef.current))) { notify('This connection cannot use this pixel mask for the edit. The current masks and draft are retained.', true); return null; }
    const capturedDenseEpoch = denseEpoch.current.value;
    const denseOwned = () => !consumedDense.length || denseEpoch.current.value === capturedDenseEpoch;
    const maskedStackEdit = Boolean((colorEdit || stackEdit) && current?.layers.find(layer => layer.id === gesture?.targetLayerId)?.filterMask);
    const resizeResult = Boolean(current && ['resize_document', 'resize_canvas'].includes(name));
    const documentResize = resizeResult && gesture?.scope === 'document' && gesture.resize ? gesture.resize : undefined;
    if (gesture && (gesture.backend !== target || gesture.documentId !== current?.id || (!documentResize && !channelEdit && gesture.targetLayerId !== (selectedLayerRef.current || undefined)) || (documentResize && (current?.width !== documentResize.sourceWidth || current?.height !== documentResize.sourceHeight || current?.revision !== gesture.expectedRevision)) || gesture.isCurrent?.() === false)) { notify(fillEdit ? 'Fill was not sent because its layer or capabilities changed. Reload saved Fill before applying.' : distortEdit ? 'Distortion was not sent because its document, layer, stage or capabilities changed. Reload the saved stage before applying.' : documentResize ? 'Resize cancelled because the document or available methods changed. Review your dimensions and method, then try again.' : stackEdit ? 'Filter stack edit cancelled because the document, layer or capabilities changed. Review the current stack and try again.' : colorEdit ? 'Color edit cancelled because the document, layer or filter changed. Review the current target and try again.' : maskEdit ? filterMaskEdit ? 'Effect mask edit cancelled because the document, layer or capabilities changed. Review the current filter stack and try again.' : 'Mask edit cancelled because the document or layer changed. Review the current mask and try again.' : name === 'create_repair_layer' ? 'Repair layer creation cancelled because the document or source layer changed. Review the current source and try again.' : name === 'load_layer_selection' ? 'Selection loading cancelled because the document or layer changed. Review the current target and try again.' : ['add_text', 'update_text'].includes(name) ? 'Text update cancelled because the document or layer changed. Review the current target and try again.' : 'Gesture cancelled because the document or layer changed. Start again on the current canvas.', true); return null; }
    if (channelEdit && (!current || current.revision !== gesture!.expectedRevision || current.width !== gesture!.channelSelection!.width || current.height !== gesture!.channelSelection!.height || !(rangeEdit ? colorRangeSupport(activeBackendRef.current, current).load : channelSupport(activeBackendRef.current, current).load))) { notify('The document or selection support changed. Review the current selection before loading.', true); return null; }
    if (fillEdit && gesture && (!current || current.revision !== gesture.expectedRevision || args.layerId !== gesture.targetLayerId || args.fillOpacity !== gesture.fill!.value || !current.layers.some(layer => layer.id === gesture.targetLayerId && !layerFillReason(current, layer, activeBackendRef.current)))) { notify('The layer or Fill support changed. Reload saved Fill before applying.', true); return null; }
    setBusy(label); busyRef.current = label;
    try {
      if (channelEdit && gesture?.channelSelection?.onDispatch() === false) return null;
      if (retouchEdit && gesture?.retouch && (current?.revision !== gesture.expectedRevision || current.width !== gesture.retouch.width || current.height !== gesture.retouch.height || !gesture.retouch.onDispatch())) return null;
      const documentArgs = !current || NON_DOCUMENT_COMMANDS.has(name) ? {} : lookupReview || DOCUMENT_READ_COMMANDS.has(name) ? { documentId: current.id } : { documentId: current.id, expectedRevision: current.revision };
      if (lookupEdit && gesture?.lookup?.onDispatch?.() === false) return null;
      const submitted = { ...documentArgs, ...args, ...(gesture ? { documentId: gesture.documentId, ...(!lookupReview ? { expectedRevision: gesture.expectedRevision } : {}) } : {}) };
      const invoke = gesture?.lookup ? <T,>() => commandWithRequestId<T>(target, name, submitted, gesture.lookup!.requestId) : <T,>() => command<T>(target, name, submitted);
      const result = await invoke<{ document?: Document; layerId?: string; filterId?: string; data?: string; mimeType?: string; filename?: string }>();
      if (lookupEdit && !gesture?.lookup?.acceptResult(result)) throw new Error('The lookup response did not match its captured target. Refresh and inspect before continuing.');
      if (result.document) {
        if (!denseOwned() || consumedDense.length && (docRef.current?.id !== current?.id || docRef.current?.revision !== current?.revision)) return null;
        if (channelEdit && gesture && (backendRef.current !== gesture.backend || docRef.current?.id !== gesture.documentId || docRef.current.revision !== gesture.expectedRevision || gesture.isCurrent?.() === false || result.document.id !== gesture.documentId || result.document.backend !== gesture.backend || result.document.revision !== gesture.expectedRevision + 1 || result.document.width !== gesture.channelSelection!.width || result.document.height !== gesture.channelSelection!.height)) return null;
        if (resizeResult && current && (backendRef.current !== target || docRef.current?.id !== current.id || docRef.current.revision !== current.revision || (documentResize && (docRef.current.width !== documentResize.sourceWidth || docRef.current.height !== documentResize.sourceHeight || gesture?.isCurrent?.() === false || result.document.id !== current.id || result.document.backend !== target || result.document.width !== documentResize.width || result.document.height !== documentResize.height)))) return null;
        if (guardedResult && gesture && (backendRef.current !== gesture.backend || docRef.current?.id !== gesture.documentId || docRef.current?.revision !== gesture.expectedRevision || (selectedLayerRef.current || undefined) !== gesture.targetLayerId || gesture.isCurrent?.() === false)) return null;
        if (preciseColorEdit && gesture?.preciseColor && (result.document.id !== gesture.documentId || result.document.backend !== gesture.backend || result.document.revision !== gesture.expectedRevision + 1 || gesture.preciseColor.acceptDocument?.(result.document) === false)) return null;
        if (fillEdit && gesture?.fill && !gesture.fill.acceptDocument(result.document)) return null;
        if (distortEdit && gesture?.distort && !gesture.distort.acceptDocument(result.document)) return null;
        if (retouchEdit && gesture?.retouch && (result.document.id !== gesture.documentId || result.document.backend !== gesture.backend || result.document.revision !== gesture.expectedRevision + 1 || result.document.width !== gesture.retouch.width || result.document.height !== gesture.retouch.height || !result.document.layers.some(layer => layer.id === gesture.targetLayerId && layer.type === 'raster') || !gesture.retouch.acceptDocument(result.document))) return null;
        const acceptedPreview = channelEdit && gesture ? () => denseOwned() && gesture.isCurrent?.() !== false && backendRef.current === gesture.backend && docRef.current?.id === gesture.documentId && docRef.current.revision === result.document?.revision : documentResize ? () => gesture?.isCurrent?.() !== false && docRef.current?.id === current?.id && docRef.current?.revision === result.document?.revision : (fillEdit || lookupEdit || distortEdit || filterMaskEdit || maskedStackEdit || retouchEdit || preciseColorEdit) && gesture ? () => backendRef.current === gesture.backend && docRef.current?.id === gesture.documentId && docRef.current.revision === result.document?.revision && ((selectedLayerRef.current || undefined) === gesture.targetLayerId || preciseColorEdit && (name === 'add_adjustment' || addedLookup) && gesture.targetLayerId === undefined && selectedLayerRef.current === displayLayers(result.document)[0]?.id) && gesture.isCurrent?.() !== false : undefined;
        await updateDocument(result.document, target, consumedDense.length ? () => denseOwned() && acceptedPreview?.() !== false && docRef.current?.id === result.document?.id && docRef.current?.revision === result.document?.revision : acceptedPreview);
        if (!denseOwned() || channelEdit && gesture && (gesture.isCurrent?.() === false || backendRef.current !== gesture.backend || docRef.current?.id !== gesture.documentId || docRef.current.revision !== result.document.revision)) return null;
        if (resizeResult && current && (backendRef.current !== target || docRef.current?.id !== current.id || docRef.current.revision !== result.document.revision || (documentResize && (docRef.current.width !== documentResize.width || docRef.current.height !== documentResize.height || gesture?.isCurrent?.() === false)))) return null;
        if (guardedResult && gesture && (backendRef.current !== gesture.backend || docRef.current?.id !== gesture.documentId || docRef.current?.revision !== result.document.revision || ((selectedLayerRef.current || undefined) !== gesture.targetLayerId && !((name === 'add_adjustment' || addedLookup) && gesture.targetLayerId === undefined && selectedLayerRef.current === displayLayers(result.document)[0]?.id)) || gesture.isCurrent?.() === false)) return null;
        if (addedLookup && result.layerId) { setSelectedLayerId(result.layerId); selectedLayerRef.current = result.layerId; }
        else if (['add_paint_layer', 'add_text', 'add_adjustment', 'add_shape', 'add_path', 'add_gradient', 'place_layer'].includes(name) || name === 'paint_stroke' && !args.layerId) {
          const existing = new Set(displayLayers(current).map(layer => layer.id));
          setSelectedLayerId(displayLayers(result.document).find(layer => !existing.has(layer.id))?.id || '');
        }
      }
      return result;
    } catch (error) {
      if (!denseOwned()) return null;
      if (channelEdit && gesture?.channelSelection) {
        gesture.channelSelection.onFailure((error as { code?: string }).code);
        if (gesture.isCurrent?.() !== false) notify((error as { code?: string }).code === 'REVISION_CONFLICT' ? 'The document changed before selection loading. Review the current selection, then load explicitly.' : error instanceof Error ? error.message : 'The selection result could not be confirmed. Review the current selection.', true);
      } else if (fillEdit && gesture) {
        const owned = () => gesture.isCurrent?.() !== false && backendRef.current === gesture.backend && docRef.current?.id === gesture.documentId && selectedLayerRef.current === gesture.targetLayerId;
        if (owned()) {
          try { const fresh = await command<{ document: Document }>(gesture.backend, 'get_document', { documentId: gesture.documentId }); if (owned() && fresh.document.id === gesture.documentId && fresh.document.backend === gesture.backend && docRef.current && docRef.current.revision <= fresh.document.revision) await updateDocument(fresh.document, gesture.backend, () => owned() && docRef.current?.revision === fresh.document.revision); } catch { /* Retain the draft without replaying a Fill mutation. */ }
          if (owned()) notify(`${error instanceof Error ? error.message : 'Fill could not be confirmed.'} Review the current layer and reload saved Fill before applying again.`, true);
        }
      } else if (lookupEdit && gesture?.lookup) {
        const owned = () => gesture.isCurrent?.() !== false && backendRef.current === gesture.backend && docRef.current?.id === gesture.documentId && ((selectedLayerRef.current || undefined) === gesture.targetLayerId || addedLookup && gesture.targetLayerId === undefined);
        if (owned() && (error as { code?: string }).code === 'REVISION_CONFLICT') {
          try { const fresh = await command<{ document: Document }>(gesture.backend, 'get_document', { documentId: gesture.documentId }); if (owned() && docRef.current && docRef.current.revision <= fresh.document.revision) await updateDocument(fresh.document, gesture.backend, () => owned() && docRef.current?.revision === fresh.document.revision); } catch { /* Inspect explicitly; never reupload automatically. */ }
        }
        if (owned()) gesture.lookup.onFailure({ message: error instanceof Error ? error.message : 'The lookup result could not be confirmed.', code: (error as { code?: string }).code });
      } else if (distortEdit && gesture) {
        const owned = () => gesture.isCurrent?.() !== false && backendRef.current === gesture.backend && docRef.current?.id === gesture.documentId && (selectedLayerRef.current || undefined) === gesture.targetLayerId;
        if (owned() && (error as { code?: string }).code === 'REVISION_CONFLICT') {
          try { const fresh = await command<{ document: Document }>(gesture.backend, 'get_document', { documentId: gesture.documentId }); if (owned() && docRef.current && docRef.current.revision <= fresh.document.revision) await updateDocument(fresh.document, gesture.backend, () => owned() && docRef.current?.revision === fresh.document.revision); } catch { /* Keep the stale draft without replaying the command. */ }
        }
        if (owned()) notify((error as { code?: string }).code === 'REVISION_CONFLICT' ? 'The document changed before distortion was saved. Reload the saved stage to review its current coordinates; this draft has not been replayed.' : error instanceof Error ? error.message : 'Distortion could not be applied. Your draft is retained.', true);
      } else if (preciseColorEdit && gesture) {
        const owned = () => gesture.isCurrent?.() !== false && backendRef.current === gesture.backend && docRef.current?.id === gesture.documentId && (selectedLayerRef.current || undefined) === gesture.targetLayerId;
        if (owned() && (error as { code?: string }).code === 'REVISION_CONFLICT') {
          try { const fresh = await command<{ document: Document }>(gesture.backend, 'get_document', { documentId: gesture.documentId }); if (owned() && docRef.current && docRef.current.revision <= fresh.document.revision) await updateDocument(fresh.document, gesture.backend, () => owned() && docRef.current?.revision === fresh.document.revision); } catch { /* No automatic replay across a changed color context. */ }
        }
        if (owned()) notify(error instanceof Error ? error.message : 'The color settings could not be saved. Review its current settings before applying again.', true);
      } else if (retouchEdit && gesture) {
        // Polling reconciles committed or stale native work after busy clears. Do not
        // run the older unowned refresh path across a new retouch session.
        if (gesture.isCurrent?.() !== false) notify(`${(error as { code?: string }).code === 'REVISION_CONFLICT' ? 'The document changed while you were drawing.' : error instanceof Error ? error.message : 'The retouch stroke could not be completed.'} Sample the source again before continuing.`, true);
      } else if (gesture && (error as { code?: string }).code === 'REVISION_CONFLICT') {
        if (docRef.current?.id === gesture.documentId && backendRef.current === gesture.backend) {
          try { const fresh = await command<{ document: Document }>(gesture.backend, 'get_document', { documentId: gesture.documentId }); if (docRef.current?.id === gesture.documentId && backendRef.current === gesture.backend && docRef.current.revision <= fresh.document.revision) await updateDocument(fresh.document, gesture.backend); } catch { /* Keep the rejected gesture discarded if refresh is temporarily unavailable. */ }
        }
        notify(resizeResult ? 'The document changed before resizing. Review the current canvas and any positioned masks, then apply your saved dimensions and method again.' : stackEdit ? `The document changed before filters were ${name === 'bake_layer_filters' ? 'baked' : name === 'clear_layer_filters' ? 'cleared' : name === 'reorder_layer_filter' ? 'reordered' : 'deleted'}. Review the current stack and try again.` : colorEdit ? 'The document changed before this color edit was saved. Review the current settings and try again.' : maskEdit ? filterMaskEdit ? 'The document changed before this effect mask edit was saved. Review the current filter stack and try again.' : 'The document changed before this mask edit was saved. Review the current mask and try again.' : name === 'create_repair_layer' ? 'The document changed before the repair layer was created. Review the current source and try again.' : name === 'load_layer_selection' ? 'The document changed before the selection was loaded. Review the current canvas and try again.' : ['add_text', 'update_text'].includes(name) ? 'The document changed before the text was saved. Review the current layer and try again.' : 'The document changed while you were drawing. Gesture cancelled; review the current canvas and start again.', true);
      } else if ((stackEdit || filterMaskEdit) && gesture && ['FILTER_BAKE_PROTECTED_CONTEXT', 'PROTECTED_LAYER', 'NO_FILTERS', 'NO_FILTER_MASK', 'FILTER_MASK_CAPTURE_GEOMETRY', 'NO_SELECTION'].includes((error as { code?: string }).code || '')) {
        if (docRef.current?.id === gesture.documentId && backendRef.current === gesture.backend) {
          try { const fresh = await command<{ document: Document }>(gesture.backend, 'get_document', { documentId: gesture.documentId }); if (docRef.current?.id === gesture.documentId && backendRef.current === gesture.backend && docRef.current.revision <= fresh.document.revision) await updateDocument(fresh.document, gesture.backend); } catch { /* Preserve the rejection without retrying the operation. */ }
          notify(error instanceof Error ? error.message : 'The filter stack could not be changed. Review the current layer.', true);
        }
      } else if (['resize_document', 'resize_canvas'].includes(name) && ['MASK_POSITION_REQUIRES_RASTERIZE', 'REVISION_CONFLICT'].includes((error as { code?: string }).code || '') && current) {
        if (backendRef.current === target && docRef.current?.id === current.id) {
          try { const fresh = await command<{ document: Document }>(target, 'get_document', { documentId: current.id }); if (backendRef.current === target && docRef.current?.id === current.id && docRef.current.revision <= fresh.document.revision) await updateDocument(fresh.document, target); } catch { /* Keep the draft and server rejection visible for retry. */ }
          notify((error as { code?: string }).code === 'MASK_POSITION_REQUIRES_RASTERIZE' ? 'Review the positioned masks listed in Resize. Rasterize each mask position in Layers, then return to your saved dimensions.' : 'The document changed before resizing. Review the current canvas and any positioned masks, then apply your saved dimensions again.', true);
        }
      } else notify(error instanceof Error ? error.message : 'That edit could not be completed.', true);
      return null;
    }
    finally { setBusy(''); busyRef.current = ''; }
  }, [notify, updateDocument]);

  const channelSelection = useChannelSelection({ document: doc, backend, capabilities: activeBackend, busy: Boolean(busy), run, install: async (next, target, accept) => { const owned = () => backendRef.current === target && docRef.current?.id === next.id && docRef.current.revision === next.revision && accept?.() !== false; await updateDocument(next, target, owned); return owned(); }, notify });

  const generationApplied = useCallback(async (job: GenerationJob) => {
    const result = await command<{ documents: Document[] }>('native', 'list_documents');
    if (backendRef.current === 'native') {
      setDocuments(result.documents);
      const updated = result.documents.find((item) => item.id === job.documentId);
      if (updated && docRef.current?.id === job.documentId && !busyRef.current) {
        await updateDocument(updated, 'native');
        if (job.layerId) setSelectedLayerId(job.layerId);
      }
    }
    notify('Generated image ready.');
  }, [notify, updateDocument]);
  const generation = useGenerationJobs({ open: modal === 'generate', onApplied: generationApplied });
  const chatViewKey = `${backend}:${doc?.id}`;
  const chatViewEpoch = useRef({ key: chatViewKey, value: 0 });
  if (chatViewEpoch.current.key !== chatViewKey) chatViewEpoch.current = { key: chatViewKey, value: chatViewEpoch.current.value + 1 };
  const [pendingChatResult, setPendingChatResult] = useState<ChatTurn | null>(null);
  // Only show the finished result; intermediate documents and edits stay off the canvas while Codex works.
  const chatFinished = useCallback(async (turn: ChatTurn) => { if (turn.status !== 'queued' && turn.status !== 'running') setPendingChatResult(turn); }, []);
  const chat = useChat({ open: inspectorOpen && tab === 'chat', onFinished: chatFinished });
  const chatRunning = chat.turns.some(turn => turn.status === 'queued' || turn.status === 'running');
  chatRunningRef.current = chatRunning;

  useEffect(() => {
    if (!pendingChatResult || backend !== 'native' || busy) return;
    const turn = pendingChatResult, targetId = turn.resultDocumentId || turn.documentId;
    if (!targetId) return;
    let cancelled = false, failures = 0, timer: ReturnType<typeof setTimeout>;
    const refreshResult = async () => {
      if (cancelled) return;
      if (busyRef.current || interactingRef.current) { timer = setTimeout(() => void refreshResult(), 150); return; }
      const current = docRef.current, version = chatViewEpoch.current.value;
      const owned = () => !cancelled && backendRef.current === 'native' && chatViewEpoch.current.value === version && docRef.current?.id === current?.id && !busyRef.current && !interactingRef.current;
      try {
        const [listed, result] = await Promise.all([
          command<{ documents: Document[] }>('native', 'list_documents'),
          command<{ document: Document }>('native', 'get_document', { documentId: targetId }),
        ]);
        if (!owned()) { if (!cancelled) timer = setTimeout(() => void refreshResult(), 150); return; }
        setDocuments(listed.documents);
        if (result.document.backend !== 'native' || result.document.id !== targetId || current?.id === targetId && result.document.revision < current.revision) return;
        const changedDocument = current?.id !== targetId;
        if (changedDocument) { setZoom('fit'); setTool('pointer'); setPreview(''); }
        await updateDocument(result.document, 'native', () => !cancelled && backendRef.current === 'native' && docRef.current?.id === targetId && docRef.current.revision === result.document.revision);
        if (!cancelled) setPendingChatResult(value => value?.id === turn.id && value.updatedAt === turn.updatedAt ? null : value);
      } catch {
        // Keep the result pending across a transient local preview failure.
        if (!cancelled && ++failures < 3) timer = setTimeout(() => void refreshResult(), 1500);
        else if (!cancelled) { setPendingChatResult(null); notify('The chat result could not be displayed. You can reopen it from the conversation.', true); }
      }
    };
    void refreshResult();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pendingChatResult, backend, busy, updateDocument, notify]);


  const openGenerationResult = async (documentId: string, layerId?: string) => {
    if (backendRef.current !== 'native') {
      pendingGenerationDocument.current = { documentId, layerId };
      backendRef.current = 'native'; setBackend('native'); setModal(null); setZoom('fit'); return;
    }
    if (busyRef.current) throw new Error('Wait for the current canvas operation to finish, then open this result.');
    setBusy('Opening generated image'); busyRef.current = 'Opening generated image';
    try {
      const result = await command<{ document: Document }>('native', 'get_document', { documentId });
      await updateDocument(result.document, 'native');
      if (layerId) setSelectedLayerId(layerId);
      setZoom('fit'); setTool('pointer'); setTab('layers'); setModal(null);
    } finally { setBusy(''); busyRef.current = ''; }
  };

  const distort = useDistort({ document: doc, layer: selectedLayer, capabilities: activeBackend, busy: Boolean(busy), run, tool, visible: tab === 'layers' && inspectorOpen && !modal, viewKey: `${zoom}:${fitZoom}:${rulersVisible}`, imageRef, canBegin: () => !interactingRef.current && !panStart.current, notify });

  const proCanvas = useCanvasTools({ document: doc, layer: selectedLayer, tool, brush, sampling: retouchSampling, capabilities: activeBackend, busy: Boolean(busy), enabled: isPaintTool(tool) ? can('paint_stroke') : tool === 'selection_brush' ? can('paint_selection') : tool === 'mask_brush' ? can('paint_mask') : tool === 'cutout_brush' ? can('paint_cutout_mask') : can('select_region'), selectionFeather, selectionInvert, run, notify });
  const retouchCapabilityKey = JSON.stringify([backend, activeBackend?.retouchSampleModes, activeBackend?.retouchSamplingTools, activeBackend?.retouchIgnoreAdjustments, activeBackend?.retouchCurrentAndBelowScope]);
  useEffect(() => {
    setRetouchSampling(previous => { const next = effectiveRetouch(previous, activeBackend, tool === 'heal' ? 'heal' : 'clone'); return next.sampleMode === previous.sampleMode && next.ignoreAdjustments === previous.ignoreAdjustments ? previous : next; });
  }, [retouchCapabilityKey, tool === 'heal']);
  retouchContextRef.current = { tool, documentId: doc?.id || '', revision: doc?.revision || 0, layerId: selectedLayerId };
  const changeRetouchSampling = (next: RetouchSampling) => { proCanvas.clearSource(); setRetouchSampling(next); };
  const createRepairLayer = async () => {
    const current = docRef.current, sourceId = selectedLayerRef.current, scope = retouchCapabilities(activeBackend, tool);
    const source = current?.layers.find(layer => layer.id === sourceId);
    if (!current || busyRef.current || !scope.repair || !scope.modes.includes('current-and-below') || !scope.ignore || repairSourceReason(current, source)) return;
    const context = captureGesture(current, sourceId), startedTool = tool;
    proCanvas.clearSource();
    const result = await run('create_repair_layer', { sourceLayerId: sourceId, name: `Repair · ${source!.name}`.slice(0, 200) }, 'Creating repair layer', context);
    const latest = retouchContextRef.current;
    if (!result?.document || !result.layerId || backendRef.current !== context.backend || docRef.current?.id !== context.documentId || docRef.current?.revision !== result.document.revision || selectedLayerRef.current !== sourceId || latest.tool !== startedTool) return;
    setSelectedLayerId(result.layerId); selectedLayerRef.current = result.layerId;
    proCanvas.clearSource(); setRetouchSampling({ sampleMode: 'current-and-below', ignoreAdjustments: true });
    notify('Repair layer created. Current & below sampling ignores adjustment layers. Option / Alt-click to choose a source.');
  };
  const vectorCanvas = useVectorCanvas({ document: doc, layer: selectedLayer, tool, busy: Boolean(busy), can, run, shape: shapeSettings, path: pathSettings, gradient: gradientSettings, notify });
  const moveCanvas = useMoveTool({ document: doc, layer: selectedLayer, tool, busy: Boolean(busy), enabled: !distort.active && can('transform_layer') && can('get_layer_preview'), run, notify, snapEnabled: Boolean(hasGuides && guideView.snap), showGuides: guideView.guides, viewKey: `${zoom === 'fit' ? fitZoom : zoom}:${rulersVisible}` });
  interactingRef.current = distort.dragging || proCanvas.dragging || vectorCanvas.dragging || moveCanvas.dragging || Boolean(startPoint.current);
  useEffect(() => { if (tool !== 'sponge') setBrush((current) => current.strength < 0 ? { ...current, strength: Math.abs(current.strength) } : current); }, [tool]);
  useEffect(() => { if (activeSelection) { setSelectionFeather(activeSelection.feather || 0); setSelectionInvert(Boolean(activeSelection.invert)); } }, [doc?.id, doc?.revision]);

  const importFile = async (file: File) => {
    if (/\.ps[db]$/i.test(file.name)) { reviewPsd(file); return; }
    if (file.name.toLowerCase().endsWith('.prism')) { await importProject(file); return; }
    if (!can('import_image')) { notify(backend === 'native' ? 'The local editor is not ready to import. Reconnect your workspace and try again.' : 'Open the image in your connected Photoshop workspace, or return to Prism Native to import it locally.', true); return; }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/tiff'].includes(file.type)) { notify('Choose a PNG, JPEG, WebP, or TIFF image.', true); return; }
    if (file.size > 24 * 1024 * 1024) { notify('Choose an image smaller than 24 MB for this version.', true); return; }
    const result = await run('import_image', { name: file.name, data: await fileBase64(file), mimeType: file.type }, 'Importing image');
    if (result) { setZoom('fit'); notify('Image imported. Make it yours.'); }
  };

  const importProject = async (file: File, requestId = crypto.randomUUID()) => {
    if (busyRef.current) return;
    if (!canProjectBundle || backendRef.current !== 'native') { notify('Open editable .prism files in the Native workspace.', true); return; }
    if (!file.name.toLowerCase().endsWith('.prism')) { notify('Choose an editable .prism project file.', true); return; }
    const limit = activeBackend?.limits?.maxProjectBundleBytes || 256 * 1024 * 1024;
    if (!file.size || file.size > limit) { notify(`Choose a nonempty project file up to ${Math.floor(limit / 1024 / 1024)} MiB.`, true); return; }
    setToast(null); setFileMenu(false); setBusy('Opening editable project'); busyRef.current = 'Opening editable project';
    try {
      const result = await importProjectBundle(file, requestId);
      await updateDocument(result.document, 'native'); setZoom('fit'); setModal(null);
      notify('Project opened as a new document. Its editable state is preserved; history starts here.');
    } catch (error) { setToast({ message: error instanceof Error ? error.message : 'The project could not be opened.', error: true, retry: () => void importProject(file, requestId) }); }
    finally { setBusy(''); busyRef.current = ''; }
  };

  const refreshExportDocument = async () => {
    const current = docRef.current;
    if (!current || busyRef.current || backendRef.current !== 'native') return null;
    setBusy('Refreshing export compatibility'); busyRef.current = 'Refreshing export compatibility';
    try {
      const result = await command<{ document: Document }>('native', 'get_document', { documentId: current.id });
      if (docRef.current?.id !== current.id || backendRef.current !== 'native') return null;
      await updateDocument(result.document, 'native'); return result.document;
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not refresh the current document.', true); return null; }
    finally { setBusy(''); busyRef.current = ''; }
  };

  const downloadProject = async () => {
    const current = docRef.current;
    if (!current || busyRef.current || backendRef.current !== 'native' || !canProjectBundle) return;
    setBusy('Preparing editable project'); busyRef.current = 'Preparing editable project';
    try { const result = await exportProjectBundle(current); downloadBlob(result.data, result.filename); setModal(null); notify('Editable .prism project download started. Undo history is not included.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'The project could not be downloaded.', true); }
    finally { setBusy(''); busyRef.current = ''; }
  };

  const openModal = (value: Modal, options: { resizeMode?: 'scale' | 'canvas'; cutoutAction?: 'extract' | 'select' | 'place'; setupTab?: 'photoshop' | 'mcp'; exportKind?: 'image' | 'project' } = {}) => {
    if (value === 'generate') setGenerationFocusId('');
    if (value === 'export') setExportKind(options.exportKind || 'image');
    if (value === 'resize') { resizeSessionRef.current++; setResizeSession(resizeSessionRef.current); setResizeMode(options.resizeMode || 'scale'); setResizeReview(null); }
    if (value === 'cutouts') setCutoutAction(options.cutoutAction || 'extract');
    if (value === 'resize' && doc) { setSizeWidth(doc.width); setSizeHeight(doc.height); }
    if (value === 'new') { setSizeWidth(1600); setSizeHeight(1200); }
    setModal(value); setFileMenu(false);
    if (value === 'setup') {
      setSetupTab(options.setupTab || 'mcp');
      setSetupError('');
      void api<Setup>('/api/setup').then(setSetup).catch((error) => setSetupError(error.message));
    }
  };

  const copy = async (text: string, key: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 2500); }
    catch { notify('Clipboard access was denied by your browser.', true); }
  };

  const applyAdjustment = async (kind: string, value: number) => {
    const result = await run('add_adjustment', { kind, value }, `Applying ${kind}`);
    if (result) { setAdjustmentValues((current) => ({ ...current, [kind]: 0 })); notify('Adjustment added as an editable layer.'); }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { if (modal === 'psdImport' && psdImport.importing) { event.preventDefault(); return; } closeModal(); setFileMenu(false); setBackendMenu(false); setCropDraft(null); cropContext.current = null; const previousStart = startPoint.current, previousPan = panStart.current; startPoint.current = null; panStart.current = null; releaseGesturePointer(previousStart?.pointer); releaseGesturePointer(previousPan?.pointer); if (docRef.current) setSelection(documentSelection(docRef.current)); return; }
      if ((event.target as HTMLElement)?.closest('input:not([type=range]), textarea, select, [contenteditable]') || modal) return; // sliders only use arrow keys, so tool shortcuts keep working after dragging one
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'z') { event.preventDefault(); if (doc && (event.shiftKey ? doc.canRedo : doc.canUndo)) void run(event.shiftKey ? 'redo' : 'undo'); }
        if (event.key.toLowerCase() === 'o') { event.preventDefault(); inputRef.current?.click(); }
        if (event.key.toLowerCase() === 'j' && !event.shiftKey) { event.preventDefault(); if (selectedLayer && !busy && !selectedClipping && can('duplicate_layer')) void run('duplicate_layer', { layerId: selectedLayer.id }, 'Duplicating layer'); } // Photoshop: Cmd/Ctrl+J duplicates the layer.
        if (event.key.toLowerCase() === 'n' && !event.shiftKey) { event.preventDefault(); openModal('new'); }
        // Photoshop view shortcuts: ⌘+ / ⌘- step zoom, ⌘0 fits on screen, ⌘1 shows 100%.
        if (doc && (event.key === '=' || event.key === '+')) { event.preventDefault(); changeZoom(1); }
        if (doc && (event.key === '-' || event.key === '_')) { event.preventDefault(); changeZoom(-1); }
        if (doc && event.key === '0') { event.preventDefault(); setZoom('fit'); }
        if (doc && event.key === '1') { event.preventDefault(); setZoom(1); }
        if (doc && hasGuides && event.key.toLowerCase() === 'r' && !event.shiftKey && !event.altKey) { event.preventDefault(); setGuideView((view) => ({ ...view, rulers: !view.rulers })); }
        if (doc && hasGuides && event.key === ';' && !event.shiftKey) { event.preventDefault(); setGuideView((view) => ({ ...view, guides: !view.guides })); }
        if (event.key.toLowerCase() === 's') { event.preventDefault(); if (doc) void run('save_document', {}, 'Saving project').then((result) => { if (result) notify('Project saved.'); }); }
        // Photoshop selection shortcuts: ⌘A select all, ⌘D deselect, ⇧⌘I invert.
        if (doc && event.key.toLowerCase() === 'a' && !event.shiftKey) { event.preventDefault(); if (can('select_region')) void run('select_region', { shape: 'rectangle', x: 0, y: 0, width: doc.width, height: doc.height }, 'Selecting all'); else if (can('select_rectangle')) void run('select_rectangle', { x: 0, y: 0, width: doc.width, height: doc.height }, 'Selecting all'); }
        if (doc && event.key.toLowerCase() === 'd' && !event.shiftKey) { event.preventDefault(); if (doc.selection && can('clear_selection')) void run('clear_selection', {}, 'Deselecting'); }
        if (doc && event.key.toLowerCase() === 'i' && event.shiftKey) { event.preventDefault(); if (doc.selection && can('modify_selection')) void run('modify_selection', { invert: !('invert' in doc.selection && doc.selection.invert) }, 'Inverting selection'); }
        return;
      }
      // Photoshop brush keys: [ ] size (step grows with size), Shift+[ ] hardness by 25%, digits set opacity (1 = 10%, 0 = 100%).
      // Holding Space temporarily switches to the Hand tool, like Photoshop.
      // Photoshop commits the crop box with Enter / Return.
      if (event.key === 'Enter' && tool === 'crop' && cropDraft && cropDraft.width > 0 && cropDraft.height > 0 && cropContext.current && !busyRef.current && !(event.target as HTMLElement)?.closest('button, a')) { event.preventDefault(); const context = cropContext.current; void run('crop_document', cropDraft, 'Cropping image', context).finally(() => { cropContext.current = null; setCropDraft(null); }); return; }
      if (event.key === ' ' && !(event.target as HTMLElement)?.closest?.('button, a, summary, input:not([type=range]), [role=button], [role=checkbox], [role=switch], [role=tab], [role=menuitem]')) { event.preventDefault(); if (!event.repeat && springHand.current === null) setTool((current) => { if (current !== 'hand') springHand.current = current; return 'hand'; }); return; }
      if (event.key === '[' || event.key === ']') { setBrush((current) => { const down = event.key === '[', basis = down ? current.size - 1 : current.size, step = basis < 10 ? 1 : basis < 100 ? 5 : basis < 200 ? 10 : basis < 300 ? 25 : 50; return { ...current, size: Math.max(1, Math.min(512, current.size + (down ? -step : step))) }; }); return; }
      if (event.key === '{' || event.key === '}') { setBrush((current) => ({ ...current, hardness: Math.max(0, Math.min(1, Math.round((current.hardness + (event.key === '{' ? -0.25 : 0.25)) * 4) / 4)) })); return; }
      if (/^[0-9]$/.test(event.key) && !event.altKey && isBrushTool(tool)) { setBrush((current) => ({ ...current, opacity: event.key === '0' ? 1 : Number(event.key) / 10 })); return; }
      // Photoshop color keys: X swaps foreground/background, D restores the default black/white pair.
      if (!event.altKey && !event.shiftKey && event.key.toLowerCase() === 'x') { swapColors(); return; }
      if (!event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') { resetColors(); return; }
      const tools: Record<string, Tool> = { v: backendRef.current === 'native' ? 'move' : 'pointer', m: event.shiftKey ? 'ellipse' : 'select', c: 'crop', t: 'text', h: 'hand', b: event.shiftKey ? 'pencil' : 'brush', e: 'eraser', s: 'clone', j: 'heal', o: event.shiftKey ? 'burn' : 'dodge', l: 'lasso', p: 'pen', u: 'shape', g: event.shiftKey ? 'bucket' : 'gradient', w: 'magic_wand', i: 'eyedropper', a: 'path_edit' };
      const nextTool = tools[event.key.toLowerCase()];
      const required = nextTool ? CLICK_COMMANDS[nextTool] || ({ pen: 'add_path', shape: 'add_shape', gradient: 'add_gradient', lasso: 'select_region', ellipse: 'select_region', path_edit: 'update_path' } as Record<string, string>)[nextTool] : undefined;
      if (nextTool && (!required || can(required)) && (!isPaintTool(nextTool) || can('paint_stroke'))) setTool(nextTool);
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === ' ' && springHand.current !== null) { const previous = springHand.current; springHand.current = null; setTool(previous); } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
  }, [doc, modal, notify, run, psdImport.importing, psdImport.frozen, psdImport.canReplaceRejected, tool, zoom, fitZoom, selectedLayer?.id, busy, selectedClipping, cropDraft, hasGuides]);

  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') || []);
    const timer = setTimeout(() => { if (!dialog?.contains(document.activeElement)) focusable()[0]?.focus(); }, 0);
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable(), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [modal]);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = imageRef.current!.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(doc!.width, (event.clientX - bounds.left) / bounds.width * doc!.width))), y: Math.round(Math.max(0, Math.min(doc!.height, (event.clientY - bounds.top) / bounds.height * doc!.height))) };
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (distort.active) return;
    if (moveCanvas.down(event)) return;
    if (rasterPointerDown(event, { tool, document: doc, layer: selectedLayer, brush: { ...brush, opacity: fillOpacity }, contiguous, canBakeFilters, run, notify, busy: Boolean(busy), can, sampleColor })) return;
    if (vectorCanvas.down(event)) return;
    if (proCanvas.down(event)) return;
    if (!doc || busy || event.button !== 0 || startPoint.current || panStart.current) return;
    if (tool === 'select' || tool === 'crop') {
      const origin = point(event), context = captureGesture(doc, selectedLayer?.id);
      startPoint.current = { ...origin, context, tool, feather: selectionFeather, invert: selectionInvert, pointer: { element: event.currentTarget, pointerId: event.pointerId } };
      if (tool === 'crop') cropContext.current = context;
      (tool === 'crop' ? setCropDraft : setSelection)({ ...origin, width: 0, height: 0 }); event.currentTarget.setPointerCapture(event.pointerId);
    } else if (tool === 'text') {
      // Clicking outside an open text editor commits it, like Photoshop.
      if (textDraft) { void textCommit.current?.(); return; }
      const origin = point(event);
      // Clicking existing type edits that layer in place (native text layers are editable).
      const hit = backend === 'native' && can('update_text') ? textLayerAt(doc, origin, 4 / actualZoom) : null;
      textHit.current = hit;
      startPoint.current = { ...origin, context: captureGesture(doc, hit ? hit.layer.id : selectedLayer?.id), tool, feather: 0, invert: false, pointer: { element: event.currentTarget, pointerId: event.pointerId } };
      if (!hit) setTextDrag({ ...origin, width: 0, height: 0 }); event.currentTarget.setPointerCapture(event.pointerId);
    }
    else if (tool === 'hand' && viewportRef.current) {
      panStart.current = { x: event.clientX, y: event.clientY, left: viewportRef.current.scrollLeft, top: viewportRef.current.scrollTop, pointer: { element: event.currentTarget, pointerId: event.pointerId } };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (distort.active) return;
    if (moveCanvas.move(event)) return;
    if (vectorCanvas.move(event)) return;
    if (proCanvas.move(event)) return;
    if (panStart.current?.pointer.pointerId === event.pointerId && viewportRef.current) { viewportRef.current.scrollLeft = panStart.current.left + panStart.current.x - event.clientX; viewportRef.current.scrollTop = panStart.current.top + panStart.current.y - event.clientY; }
    if (!startPoint.current || !doc || startPoint.current.pointer.pointerId !== event.pointerId) return;
    const next = point(event), start = startPoint.current;
    if (start.tool === 'text') { if (textHit.current) return; setTextDrag({ x: Math.min(start.x, next.x), y: Math.min(start.y, next.y), width: Math.abs(next.x - start.x), height: Math.abs(next.y - start.y) }); return; }
    (tool === 'crop' ? setCropDraft : setSelection)({ x: Math.min(start.x, next.x), y: Math.min(start.y, next.y), width: Math.abs(next.x - start.x), height: Math.abs(next.y - start.y) });
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (distort.active) return;
    if (moveCanvas.up(event)) return;
    if (vectorCanvas.up(event)) return;
    if (proCanvas.up(event)) return;
    if (panStart.current && panStart.current.pointer.pointerId !== event.pointerId) return;
    const started = startPoint.current, panned = panStart.current;
    if (started && started.pointer.pointerId !== event.pointerId) return;
    startPoint.current = null; panStart.current = null;
    releaseGesturePointer(started?.pointer); releaseGesturePointer(panned?.pointer);
    if (started?.tool === 'text') {
      const drag = textDrag, hit = textHit.current; setTextDrag(null); textHit.current = null;
      if (hit && doc && tool === 'text' && started.context.documentId === doc.id && started.context.backend === backend) { setSelectedLayerId(hit.layer.id); selectedLayerRef.current = hit.layer.id; setTextDraft({ x: hit.bounds.anchorX, y: hit.bounds.anchorY, layer: hit.layer, context: started.context }); return; }
      if (doc && tool === 'text' && started.context.documentId === doc.id && started.context.backend === backend) setTextDraft(drag && drag.width >= 8 && drag.height >= 8 ? { ...drag, context: started.context } : { x: started.x, y: started.y, context: started.context });
      return;
    }
    if (started && (started.context.documentId !== doc?.id || started.context.backend !== backend || started.context.targetLayerId !== selectedLayer?.id || started.tool !== tool)) { startPoint.current = null; setCropDraft(null); cropContext.current = null; setSelection(doc ? documentSelection(doc) : null); return; }
    if (started && selection && selection.width > 1 && selection.height > 1 && tool === 'select' && can('select_rectangle')) void run(can('select_region') ? 'select_region' : 'select_rectangle', can('select_region') ? { ...selection, shape: 'rectangle', feather: started.feather, invert: started.invert } : selection, 'Creating selection', started.context).then((result) => { if (!result && docRef.current) setSelection(documentSelection(docRef.current)); });
    // A marquee click without a drag deselects, like Photoshop.
    else if (started && tool === 'select' && doc?.selection && can('clear_selection')) { setSelection(null); void run('clear_selection', {}, 'Deselecting', started.context).then((result) => { if (!result && docRef.current) setSelection(documentSelection(docRef.current)); }); }
    else if (canvasSelection && (canvasSelection.width < 2 || canvasSelection.height < 2)) (tool === 'crop' ? setCropDraft : setSelection)(null);
  };
  const cancelPointer = (event: PointerEvent<HTMLDivElement>) => {
    moveCanvas.cancel(event); proCanvas.cancel(event); vectorCanvas.cancel(event);
    if (startPoint.current?.pointer.pointerId === event.pointerId) {
      const started = startPoint.current; startPoint.current = null;
      releaseGesturePointer(started.pointer); cropContext.current = null; setTextDrag(null);
      setCropDraft(null); setSelection(doc ? documentSelection(doc) : null);
    }
    if (panStart.current?.pointer.pointerId === event.pointerId) {
      const panned = panStart.current; panStart.current = null; releaseGesturePointer(panned.pointer);
    }
  };
  useEffect(() => { const previousStart = startPoint.current, previousPan = panStart.current; startPoint.current = null; panStart.current = null; releaseGesturePointer(previousStart?.pointer); releaseGesturePointer(previousPan?.pointer); cropContext.current = null; setCropDraft(null); setTextDrag(null); setTextDraft(current => tool === 'text' && current?.layer && current.layer.id === selectedLayerRef.current && current.context.documentId === docRef.current?.id ? current : null); setSelection(docRef.current ? documentSelection(docRef.current) : null); }, [backend, doc?.id, tool, selectedLayerId]);
  const actualZoom = zoom === 'fit' ? fitZoom : zoom;
  const changeZoom = (direction: number) => setZoom(Math.max(0.05, Math.min(3, Math.round((actualZoom + direction * 0.1) * 100) / 100)));
  const switchBackend = (value: BackendId) => { setBackendMenu(false); if (value !== backend) { backendRef.current = value; setBackend(value); setTool(value === 'native' ? 'move' : 'pointer'); } };
  const deleteCurrentDocument = async () => {
    if (!doc || !window.confirm(`Delete “${doc.name}” and its history? This cannot be undone.`)) return;
    try { await deleteDocument(doc.id); await loadWorkspace(backend); notify('Document deleted.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'The document could not be deleted.', true); }
  };
  const selectDocument = async (id: string) => {
    const next = documents.find((item) => item.id === id);
    if (next && next.id !== doc?.id) { setBusy('Opening document'); setSelection(null); setZoom('fit'); try { await updateDocument(next, backend); } catch (error) { notify(String(error), true); } finally { setBusy(''); } }
  };
  const canOpenTool = (entry: CatalogEntry) => {
    if (['resize_document', 'resize_canvas'].includes(entry.command || '')) return Boolean(doc);
    return Boolean(entry.tool && (entry.tool in TOOL_LABELS || entry.tool === 'zoom') || ['transform_layer', 'add_text', 'add_adjustment', 'crop_document', 'select_rectangle', 'select_subject', 'extract_subject', 'place_layer'].includes(entry.command || ''));
  };
  const chooseCatalogTool = (entry: CatalogEntry) => {
    setModal(null);
    if (['select_subject', 'extract_subject', 'place_layer'].includes(entry.command || '')) { openModal('cutouts', { cutoutAction: entry.command === 'place_layer' ? 'place' : entry.command === 'select_subject' ? 'select' : 'extract' }); return; }
    if (entry.command === 'add_shape') { setShapeSettings((current) => ({ ...current, shape: entry.id as typeof current.shape })); setTool('shape'); return; }
    if (entry.id === 'custom_shape') { setPathSettings((current) => ({ ...current, closed: true })); setTool('pen'); return; }
    if (entry.tool === 'move' && backend !== 'native') { if (selectedLayer && !['group', 'adjustment'].includes(selectedLayer.type)) openModal('transform'); else notify('Select a content layer to transform.', true); return; }
    if (entry.tool === 'path_edit') { setTool('path_edit'); setTab('layers'); setInspectorOpen(true); if (!selectedLayer?.vector || !('nodes' in selectedLayer.vector)) notify('Select a path layer to edit anchors, or draw one with the Pen tool.'); return; }
    if (entry.tool && entry.tool in TOOL_LABELS) { setTool(entry.tool as Tool); return; }
    if (entry.tool === 'zoom') { setZoom('fit'); return; }
    if (entry.command === 'transform_layer') { if (selectedLayer && selectedLayer.type !== 'adjustment' && selectedLayer.type !== 'group') openModal('transform'); else notify('Select an image or text layer to transform.', true); }
    else if (['resize_document', 'resize_canvas'].includes(entry.command || '')) openModal('resize', { resizeMode: entry.command === 'resize_canvas' ? 'canvas' : 'scale' });
    else if (entry.command === 'add_text') setTool('text');
    else if (entry.command === 'crop_document') setTool('crop');
    else if (entry.command === 'select_rectangle') setTool('select');
    else if (entry.command === 'add_adjustment') { setTab('adjustments'); setInspectorOpen(true); }
  };

  const opacityControl = <label>Opacity<input aria-label="Layer opacity" type="number" min="0" max="100" key={`${selectedLayer?.id}-${selectedLayer?.opacity}`} defaultValue={Math.round((selectedLayer?.opacity ?? 1) * 100)} disabled={!selectedLayer || Boolean(busy) || selectedProtected} onBlur={(event) => { const raw = event.target.value.trim(), parsed = Number(raw); if (!raw || !Number.isFinite(parsed)) { event.target.value = String(Math.round((selectedLayer?.opacity ?? 1) * 100)); return; } const value = Math.max(0, Math.min(100, parsed)) / 100; if (selectedLayer && value !== selectedLayer.opacity) void run('set_layer', { layerId: selectedLayer.id, opacity: value }); else event.target.value = String(Math.round((selectedLayer?.opacity ?? 1) * 100)); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /><span>%</span></label>;

  return <div className={`app ${!inspectorOpen ? 'inspector-hidden' : ''}`}>
    <input ref={inputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/tiff" aria-label="Import image file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
    <input ref={psdInputRef} className="visually-hidden" type="file" accept=".psd,image/vnd.adobe.photoshop" aria-label="Open layered PSD file" disabled={psdImport.importing} onChange={event => { const file = event.target.files?.[0]; if (file) reviewPsd(file); event.target.value = ''; }} />
    <input ref={projectInputRef} className="visually-hidden" type="file" accept=".prism,application/x-prism-project" aria-label="Open Prism project file" onChange={event => { const file = event.target.files?.[0]; if (file) void importProject(file); event.target.value = ''; }} />
    <header className="topbar">
      <a className="brand" href="/" aria-label="Prism Studio home"><PrismMark /><span>prism<span className="brand-studio">studio</span></span><span className="preview-badge">PREVIEW</span></a>
      <div className="header-divider" />
      <div className="menu-anchor"><button className={`menu-button ${fileMenu ? 'selected' : ''}`} onClick={() => { setFileMenu(!fileMenu); setBackendMenu(false); }}>File <ChevronDown size={12} /></button>
        {fileMenu && <><button className="popover-dismiss" aria-label="Close file menu" onClick={() => setFileMenu(false)} /><div className="popover file-popover">
          <button disabled={!can('create_document') || Boolean(busy)} onClick={() => openModal('new')}><Plus size={15} />New canvas<span>⌘ N</span></button>
          <button disabled={!can('import_image') || Boolean(busy)} onClick={() => { inputRef.current?.click(); setFileMenu(false); }}><FolderOpen size={15} />Open image<span>⌘ O</span></button>
          {canPsdImport && <button disabled={Boolean(busy) || psdImport.importing} onClick={() => { if (psdImport.frozen) setModal('psdImport'); else psdInputRef.current?.click(); setFileMenu(false); }}><FolderOpen size={15} />Open PSD</button>}
          {canProjectBundle && <button disabled={Boolean(busy)} onClick={() => { projectInputRef.current?.click(); setFileMenu(false); }}><FolderOpen size={15} />Open project</button>}
          <div className="menu-rule" />
          <button aria-label="Save project locally" disabled={!doc || Boolean(busy)} onClick={() => { void run('save_document', {}, 'Saving project').then((result) => { if (result) notify('Project saved.'); }); setFileMenu(false); }}><Save size={15} />Save locally<span>⌘ S</span></button>{canProjectBundle && <button disabled={!doc || Boolean(busy)} onClick={() => openModal('export', { exportKind: 'project' })}><Layers size={15} />Download project</button>}
          {canPsdImport && doc?.sourceDocument?.format === 'psd' && <button disabled={Boolean(busy)} onClick={() => void downloadSourcePsd()}><Download size={15} />Download original PSD</button>}
          <button disabled={!doc || Boolean(busy)} onClick={() => openModal('export')}><Download size={15} />Export image</button>
        </div></>}
      </div>
      <button className="menu-button header-image-button" disabled={!doc || (!can('resize_document') && !(backend === 'native' && can('resize_canvas'))) || Boolean(busy)} onClick={() => openModal('resize')}>Image</button>
      <button className="menu-button header-help-button" onClick={() => openModal('help')}>Help</button>
      <div className="header-spacer" />
      {hostedSession() ? <AccountMenu disabled={Boolean(busy)} /> : <div className="backend-picker menu-anchor"><button className="backend-button" onClick={() => { setBackendMenu(!backendMenu); setFileMenu(false); }} disabled={Boolean(busy)}><span className={`status-dot ${connected ? 'connected' : ''}`} /><span>{backend === 'native' ? 'Prism Native' : 'Adobe Photoshop'}</span><ChevronDown size={13} /></button>
        {backendMenu && <><button className="popover-dismiss" aria-label="Close backend menu" onClick={() => setBackendMenu(false)} /><div className="popover backend-popover"><div className="popover-heading">EDITING ENGINE</div><button onClick={() => switchBackend('native')}><PrismMark small /><span>Prism Native<small>Standalone editor · local projects</small></span>{backend === 'native' && <Check size={15} />}</button><button onClick={() => switchBackend('photoshop')}><span className="ps-icon">Ps</span><span>Adobe Photoshop<small>{status?.bridge.connected ? 'Optional connection active' : 'Optional desktop connection'}</small></span>{backend === 'photoshop' && <Check size={15} />}</button><div className="menu-rule" /><button onClick={() => { setBackendMenu(false); openModal('setup'); }}><Settings2 size={15} />Connection settings<ArrowUpRight size={14} /></button></div></>}
      </div>}
      <button className="button subtle header-open" title="Open image" onClick={() => inputRef.current?.click()} disabled={!can('import_image') || Boolean(busy)}><Upload size={14} />Open image</button>
      <button className="cutout-header-button" aria-label="Open Cutouts" onClick={() => openModal('cutouts')}><Scissors size={15} /><span>Cutouts</span></button>
      <button className="button primary export-header" onClick={() => openModal('export')} disabled={!doc || Boolean(busy) || !can('export_document')}><ArrowDownToLine size={15} />Export<ChevronDown size={12} /></button>
    </header>

    <div className="documentbar"><div className="documenttab"><FileImage size={14} /><select aria-label="Open document" value={doc?.id || ''} disabled={!documents.length || Boolean(busy)} onChange={(event) => void selectDocument(event.target.value)}>{documents.length ? documents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">Untitled workspace</option>}</select><span className="document-dot" title="Local document" /></div>{hostedSession() && doc && <ButtonIcon label="Delete document" disabled={Boolean(busy)} onClick={() => void deleteCurrentDocument()}><Trash2 size={14} /></ButtonIcon>}<div className="documentbar-spacer" /><span className="save-status">{busy ? <><LoaderCircle size={12} className="spin" />{busy}</> : doc ? <><CheckCheck size={13} />{backend === 'native' ? (hostedSession() ? 'Saved to your account' : 'Saved locally') : 'Photoshop document'}</> : null}</span><ButtonIcon label={inspectorOpen ? 'Hide inspector' : 'Show inspector'} onClick={() => setInspectorOpen(!inspectorOpen)}><PanelRightClose size={16} /></ButtonIcon></div>

    <div className="workspace">
      <aside className="toolrail" aria-label="Editing tools">
        <div className="tool-group">{([
          [backend === 'native' ? 'move' : 'pointer', backend === 'native' ? Move : MousePointer2, backend === 'native' ? 'Move layer (V)' : 'Inspect (V)'], ['select', SquareDashed, 'Rectangle selection (M)'], ['crop', Crop, 'Crop (C)'], ['text', Type, 'Add text (T)'],
        ] as const).map(([id, Icon, label]) => <ButtonIcon key={id} label={label} active={tool === id} disabled={!doc || (id === 'crop' && !can('crop_document')) || (id === 'text' && !can('add_text'))} onClick={() => setTool(id)}><Icon size={19} strokeWidth={1.7} /></ButtonIcon>)}</div>
        <div className="pro-tools-grid"><ButtonIcon label="Ellipse selection" active={tool === 'ellipse'} disabled={!doc || !can('select_region')} onClick={() => setTool('ellipse')}><CircleDashed size={18} /></ButtonIcon><ButtonIcon label="Lasso selection (L)" active={tool === 'lasso'} disabled={!doc || !can('select_region')} onClick={() => setTool('lasso')}><Lasso size={18} /></ButtonIcon></div>
        <div className="tool-rule" /><div className="pro-tools-grid">{([['brush', Paintbrush, 'Brush (B)'], ['eraser', Eraser, 'Eraser (E)'], ['clone', Stamp, 'Clone stamp (S)'], ['heal', Bandage, 'Healing brush (J)'], ['dodge', Sun, 'Dodge (O)'], ['burn', Flame, 'Burn (⇧O)']] as const).map(([id, Icon, label]) => <ButtonIcon key={id} label={label} active={tool === id} disabled={!doc || !can('paint_stroke')} onClick={() => setTool(id)}><Icon size={17} strokeWidth={1.7} /></ButtonIcon>)}</div>
        <div className="tool-rule" /><div className="pro-tools-grid"><ButtonIcon label="Vector shape (U)" active={tool === 'shape'} disabled={!doc || !can('add_shape')} onClick={() => setTool('shape')}><Square size={17} /></ButtonIcon><ButtonIcon label="Pen (P)" active={tool === 'pen'} disabled={!doc || !can('add_path')} onClick={() => setTool('pen')}><PenTool size={17} /></ButtonIcon><ButtonIcon label="Magic wand (W)" active={tool === 'magic_wand'} disabled={!doc || !can('select_color')} onClick={() => setTool('magic_wand')}><Wand size={17} /></ButtonIcon><ButtonIcon label="Eyedropper (I)" active={tool === 'eyedropper'} disabled={!doc || !can('sample_color')} onClick={() => setTool('eyedropper')}><Pipette size={17} /></ButtonIcon></div>
        <div className="tool-rule" /><ButtonIcon label="Adjustments" active={tab === 'adjustments' && inspectorOpen} onClick={() => { setTab('adjustments'); setInspectorOpen(true); }}><SlidersHorizontal size={19} strokeWidth={1.7} /></ButtonIcon><ButtonIcon label="Hand tool (H)" active={tool === 'hand'} onClick={() => setTool('hand')}><Hand size={19} strokeWidth={1.7} /></ButtonIcon><ButtonIcon label="Fit image to view" onClick={() => setZoom('fit')}><Maximize size={18} strokeWidth={1.7} /></ButtonIcon>
        <ButtonIcon label="Browse all tools" onClick={() => openModal('tools')}><Search size={17} /></ButtonIcon><div className="toolrail-spacer" /><div className="color-swatches"><input aria-label="Text foreground color" title="Set foreground color" type="color" value={foregroundColor} onChange={(event) => setForegroundColor(event.target.value)} /><input aria-label="Background color" title="Set background color" type="color" value={backgroundColor} onChange={(event) => setBackgroundSwatch(event.target.value)} /><button type="button" className="swatch-swap" aria-label="Swap colors (X)" title="Swap colors (X)" onClick={swapColors}>⇄</button><button type="button" className="swatch-reset" aria-label="Default colors (D)" title="Default colors (D)" onClick={resetColors}><i /><i /></button></div><div className="tool-rule" /><ButtonIcon label="Connections and MCP setup" onClick={() => openModal('setup')}><Link2 size={18} /></ButtonIcon><ButtonIcon label="Keyboard shortcuts and help" onClick={() => openModal('help')}><CircleHelp size={18} /></ButtonIcon>
      </aside>

      <main className="canvas-column" onDragOver={(event) => { event.preventDefault(); setDragOver(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false); }} onDrop={(event) => { event.preventDefault(); setDragOver(false); const file = event.dataTransfer.files[0]; if (file) void importFile(file); }}>
        <div className="contextbar"><span className="tool-name">{distort.active ? 'Distort' : TOOL_LABELS[tool]}</span><span className="context-divider" /><span className="tool-hint">{distort.active ? 'Draft corner guide · pixels update on Apply' : TOOL_HINTS[tool]}</span><div className="context-spacer" />{chatRunning && backend === 'native' && <span className="chat-canvas-note" role="status"><LoaderCircle size={10} className="spin" />Codex is working · result appears when done</span>}{canvasSelection && <><span className="selection-size">{backend === 'photoshop' && tool !== 'crop' ? 'Bounds · ' : ''}{canvasSelection.width} × {canvasSelection.height}</span>{tool === 'crop' ? <button className="button mini primary" disabled={Boolean(busy) || !canvasSelection.width || !canvasSelection.height} onClick={() => { if (cropContext.current) void run('crop_document', canvasSelection, 'Cropping image', cropContext.current).finally(() => { cropContext.current = null; setCropDraft(null); }); }}>Apply crop</button> : <button className="button mini subtle" onClick={() => { if (can('clear_selection')) void run('clear_selection'); }}>Deselect</button>}</>}<ButtonIcon label="Undo (⌘Z)" disabled={!doc?.canUndo || Boolean(busy)} onClick={() => void run('undo', {}, 'Undoing edit')}><Undo2 size={15} /></ButtonIcon><ButtonIcon label="Redo (⇧⌘Z)" disabled={!doc?.canRedo || Boolean(busy)} onClick={() => void run('redo', {}, 'Redoing edit')}><Redo2 size={15} /></ButtonIcon></div>
        {!distort.active && <>{tool === 'move' && backend === 'native' && <MoveOptions snapping={Boolean(hasGuides && guideView.snap && guideView.guides)} snapReason={moveCanvas.snapReason} snapGuides={moveCanvas.snapGuides} layer={selectedLayer} loading={moveCanvas.loading} reason={moveCanvas.reason} retry={moveCanvas.retry} delta={moveCanvas.delta} />}
        {isBrushTool(tool) && (can('paint_stroke') || can('paint_selection') || can('paint_mask')) && <BrushOptions canBakeFilters={canBakeFilters} brush={brush} setBrush={setBrush} layer={selectedLayer} busy={Boolean(busy)} run={run} hasSource={Boolean(proCanvas.source)} clearSource={proCanvas.clearSource} tool={tool} setTool={setTool} canRefineCutout={canEditCutoutAlpha(selectedLayer, doc) && can('paint_cutout_mask')} />}
        {isSelectionTool(tool) && can('modify_selection') && <SelectionOptions onOpenLibrary={hasSelectionPanel ? () => { setTab('selections'); setInspectorOpen(true); } : undefined} selection={activeSelection} feather={selectionFeather} setFeather={setSelectionFeather} invert={selectionInvert} setInvert={setSelectionInvert} busy={Boolean(busy)} run={run} />}
        {['shape', 'pen', 'gradient', 'path_edit'].includes(tool) && <VectorToolOptions tool={tool} shape={shapeSettings} setShape={setShapeSettings} path={pathSettings} setPath={setPathSettings} gradient={gradientSettings} setGradient={setGradientSettings} nodes={vectorCanvas.nodes} onFinish={vectorCanvas.commitPath} onClear={() => vectorCanvas.setNodes([])} busy={Boolean(busy)} />}
        <RetouchOptions document={doc} layer={selectedLayer} tool={tool} capabilities={activeBackend} sampling={retouchSampling} onSamplingChange={changeRetouchSampling} source={proCanvas.source} sampleCenter={proCanvas.sampleCenter} aligned={proCanvas.aligned} established={proCanvas.established} pendingSource={proCanvas.pendingSource} onAlignedChange={proCanvas.setAligned} clearSource={proCanvas.clearSource} busy={Boolean(busy)} onCreate={() => void createRepairLayer()} />
        {CLICK_TOOLS.includes(tool) && <RasterOptions tool={tool} brush={{ ...brush, opacity: fillOpacity }} setBrush={(next) => { setFillOpacity(next.opacity); setBrush({ ...next, opacity: brush.opacity }); }} contiguous={contiguous} setContiguous={setContiguous} radius={sampleRadius} setRadius={setSampleRadius} />}</>}
        <div className={`canvas-frame ${rulersVisible ? "with-rulers" : ""}`}>{rulersVisible && doc && <CanvasRulers document={doc} viewportRef={viewportRef} artboardRef={imageRef} measureKey={`${actualZoom}:${inspectorOpen}:${doc.revision}:${Boolean(preview)}`} onLayout={() => { setTab('guides'); setInspectorOpen(true); }} onCreateGuide={can('add_guide') && !busy && (doc.guides?.length || 0) < (activeBackend?.limits?.maxGuides || 64) ? (axis, position) => { if (!guideView.guides) setGuideView({ ...guideView, guides: true }); void run('add_guide', { axis, position }, 'Adding guide'); } : undefined} />}<div className={`canvas-viewport tool-${tool}`} ref={viewportRef}>
          {connectionError || backend === 'native' && !connected && !busy ? <div className="empty-state"><span className="empty-icon"><Link2 size={27} /></span><h1>Your workspace is almost ready.</h1><p>{connectionError || 'The local editor is not ready yet. Reconnect to continue.'}</p><button className="button primary" onClick={() => void loadWorkspace(backend)}>Reconnect local editor<ArrowRight size={15} /></button><code>npm run dev</code></div> : backend === 'photoshop' && !connected && !busy ? <div className="empty-state"><span className="ps-icon large">Ps</span><span className="eyebrow">OPTIONAL CONNECTION</span><h1>Connect an existing Photoshop workspace.</h1><p>This connection controls documents in a separate Photoshop installation. Continue in Prism Native for the standalone editor.</p><button className="button primary" onClick={() => openModal('setup', { setupTab: 'photoshop' })}><Link2 size={15} />Connect Photoshop</button><button className="text-button" onClick={() => switchBackend('native')}>Return to Prism Native<ArrowRight size={14} /></button></div> : !doc || !preview ? <div className="empty-state">{busy ? <><LoaderCircle size={28} className="spin muted" /><h2>{busy}</h2><p>A little room for your next idea.</p></> : <><ImagePlus size={32} className="muted" /><h1>Begin with an image.</h1><p>{backend === 'photoshop' ? 'Open a document in Photoshop, then refresh the workspace.' : 'Drop an image here, or start with a blank canvas.'}</p><button className="button primary" onClick={() => backend === 'photoshop' ? void loadWorkspace(backend) : inputRef.current?.click()}>{backend === 'photoshop' ? 'Refresh documents' : 'Open an image'}</button></>}</div> : <div className="canvas-surface" style={{ minWidth: doc.width * actualZoom + 100, minHeight: doc.height * actualZoom + 100 }}><div className="artboard-wrap"><div className="artboard-label"><span>{doc.name}</span><span>{doc.width} × {doc.height}</span></div><div ref={imageRef} className="artboard" style={{ width: doc.width * actualZoom, height: doc.height * actualZoom }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerLeave={proCanvas.leave} onLostPointerCapture={cancelPointer} onPointerCancel={cancelPointer}><img src={preview || undefined} alt={`${doc.name} edited canvas`} draggable={false} />{hasGuides && guideView.guides && <GuideOverlay document={doc} highlighted={moveCanvas.snapGuides} />}{moveCanvas.active && <MoveGuide document={doc} bounds={moveCanvas.bounds} delta={moveCanvas.delta} />}{canvasSelection && <SelectionOverlay capabilities={activeBackend} selection={canvasSelection} document={doc} crop={tool === 'crop'} />}{!distort.active && <CanvasProOverlay document={doc} tool={tool} brush={brush} cursor={proCanvas.cursor} source={proCanvas.sampleCenter} stroke={proCanvas.stroke} polygon={proCanvas.polygon} ellipse={proCanvas.ellipse} />}<DistortOverlay control={distort} />{!distort.active && <VectorOverlay document={doc} tool={tool} layer={selectedLayer} nodes={vectorCanvas.nodes} shapeDraft={vectorCanvas.shapeDraft} gradientDraft={vectorCanvas.gradientDraft} editNodes={vectorCanvas.editNodes} path={pathSettings} />}{textDrag && (textDrag.width > 0 || textDrag.height > 0) && <div className="canvas-text-draft" style={{ left: textDrag.x * actualZoom, top: textDrag.y * actualZoom, width: textDrag.width * actualZoom, height: textDrag.height * actualZoom }} />}{textDraft && tool === 'text' && <CanvasTextEditor key={textDraft.layer ? `${textDraft.layer.id}:${textDraft.context.expectedRevision}` : 'new'} document={doc} draft={textDraft} zoom={actualZoom} native={backend === 'native'} busy={Boolean(busy)} run={run} commitRef={textCommit}
                style={{ fontSize: textSize, color: textColor, fontFamily: textFamily, fontWeight: textWeight, fontStyle: textStyle, align: textAlign }}
                setStyle={next => { setTextSize(next.fontSize); setTextColor(next.color); setTextFamily(next.fontFamily); setTextWeight(next.fontWeight); setTextStyle(next.fontStyle); setTextAlign(next.align); }}
                onClose={() => { setTextDraft(null); textCommit.current = null; }} />}</div></div></div>}
          {dragOver && <div className="drop-overlay"><Upload size={36} /><h2>Drop it into your next idea.</h2><p>{canProjectBundle ? 'PNG, JPEG, WebP, TIFF, or an editable .prism project' : 'PNG, JPEG, WebP, or TIFF'}</p></div>}
        </div></div>
        <div className="canvas-bottom"><span className="canvas-meta">{doc ? <><span className="tiny-square" />{doc.width} × {doc.height} px<span className="meta-dot">·</span>{backend === 'native' ? 'Native project' : 'Photoshop'}</> : 'A workspace for what comes next'}</span><div className="zoom-controls">{hasGuides && <button className={`canvas-layout-button ${tab === 'guides' && inspectorOpen ? 'selected' : ''}`} aria-label="Canvas layout and guides" disabled={!doc} onClick={() => { setTab('guides'); setInspectorOpen(true); }}><SquareDashed size={12} />Layout</button>}<ButtonIcon label="Zoom out" disabled={!doc} onClick={() => changeZoom(-1)}><Minus size={13} /></ButtonIcon><button className="zoom-value" title="Reset to fit" onClick={() => setZoom('fit')}>{Math.round(actualZoom * 100)}%<ChevronDown size={11} /></button><ButtonIcon label="Zoom in" disabled={!doc} onClick={() => changeZoom(1)}><Plus size={13} /></ButtonIcon><span className="zoom-rule" /><button className={`fit-button ${zoom === 'fit' ? 'selected' : ''}`} onClick={() => setZoom('fit')}>Fit</button></div></div>

      </main>

      {inspectorOpen && <aside className={`inspector ${tab === 'chat' ? 'chat-inspector' : ''}`} aria-label="Document inspector"><div className={`inspector-tabs with-chat ${hasSelectionPanel ? 'has-selections' : ''}`}>{((hasSelectionPanel ? ['chat', 'layers', 'selections', 'adjustments', 'history'] : ['chat', 'layers', 'adjustments', 'history']) as Tab[]).map((value) => <button key={value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value === 'selections' ? 'Select' : value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div>
        {tab === 'chat' && <ChatPanel onOpenImage={can('import_image') ? () => inputRef.current?.click() : undefined} controller={chat} document={doc} documents={documents} layer={selectedLayer} backend={backend} busy={Boolean(busy)} generation={generation} onOpenResult={async id => { await openGenerationResult(id); setTab('chat'); }} onImageOptions={jobId => { openModal('generate'); if (jobId) setGenerationFocusId(jobId); }} onSwitchNative={() => switchBackend('native')} />}
        {tab === 'layers' && <><div className="panel-section layer-controls"><div className="section-heading"><span>Layers</span><span className="count-badge">{visibleLayers.length}</span><div className="flex-spacer" /><ButtonIcon label="Add adjustment layer" disabled={!doc || !can('add_adjustment')} onClick={() => setTab('adjustments')}><Plus size={15} /></ButtonIcon></div><div className={`blend-controls ${doc?.backend === 'native' && selectedLayer && isFillContent(selectedLayer.type) ? 'has-layer-fill' : ''}`}><select aria-label="Layer blend mode" disabled={!selectedLayer || Boolean(busy) || selectedLayer.type === 'adjustment' || selectedLayer.type === 'group' || selectedLayer.protected} value={selectedLayer?.blendMode || 'normal'} onChange={(event) => selectedLayer && void run('set_layer', { layerId: selectedLayer.id, blendMode: event.target.value })}>{(activeBackend?.blendModes || ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion']).map((mode) => <option key={mode} value={mode}>{(mode.charAt(0).toUpperCase() + mode.slice(1)).replaceAll('_', ' ')}</option>)}</select>{doc?.backend === 'native' && selectedLayer && isFillContent(selectedLayer.type) ? <LayerFill key={`${doc.id}:${selectedLayer.id}`} document={doc} layer={selectedLayer} capabilities={activeBackend} busy={Boolean(busy)} run={run} opacityControl={opacityControl} /> : opacityControl}</div></div>
          {canRecipes && doc && <div className="recipe-open-action"><button className="button mini secondary" onClick={() => openModal('recipes')}>Recipes{recipeApplication.pending ? ' · outcome needs review' : ''}</button></div>}
          <LayerStack key={`${backend}-${doc?.id}`} capabilities={activeBackend} document={doc} selectedId={selectedLayerId} preview={preview} busy={Boolean(busy)} can={can} run={run} onSelect={setSelectedLayerId} />
          <div className="layer-actions"><span>{doc ? 'Every layer, a possibility.' : 'Made to stay editable.'}</span><ButtonIcon label="Duplicate selected layer" disabled={!selectedLayer || Boolean(busy) || selectedClipping || !can('duplicate_layer')} onClick={() => selectedLayer && void run('duplicate_layer', { layerId: selectedLayer.id }, 'Duplicating layer')}><Copy size={14} /></ButtonIcon><ButtonIcon label="Delete selected layer" disabled={!selectedLayer || Boolean(busy) || selectedProtected || selectedClipping || !can('delete_layer')} onClick={() => selectedLayer && void run('delete_layer', { layerId: selectedLayer.id }, 'Deleting layer')}><Trash2 size={14} /></ButtonIcon></div>
          {selectedLayer && <div className="panel-section properties"><div className="section-heading"><span>Layer properties</span><Settings2 size={14} /></div><label className="field-label">Name<input aria-label="Layer name" key={`${selectedLayer.id}-${selectedLayer.name}`} defaultValue={selectedLayer.name} disabled={Boolean(busy)} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== selectedLayer.name) void run('set_layer', { layerId: selectedLayer.id, name: event.target.value.trim() }); }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label><div className="property-grid"><div><span>TYPE</span><strong>{selectedLayer.type}</strong></div><div><span>VISIBILITY</span><strong>{selectedLayer.visible ? 'Visible' : 'Hidden'}</strong></div></div><div className="layer-order"><span>Stack position</span><ButtonIcon label="Move layer down" disabled={Boolean(busy) || selectedClipping || (backend === 'native' && reorderSplitsClippingChain(siblingLayers, selectedLayer.id, layerDownIndex)) || !can('reorder_layer') || layerDownIndex < 0 || layerDownIndex >= siblingLayers.length} onClick={() => void run('reorder_layer', { layerId: selectedLayer.id, index: layerDownIndex })}><ArrowDownToLine size={13} /></ButtonIcon><ButtonIcon label="Move layer up" disabled={Boolean(busy) || selectedClipping || (backend === 'native' && reorderSplitsClippingChain(siblingLayers, selectedLayer.id, layerUpIndex)) || !can('reorder_layer') || layerUpIndex < 0 || layerUpIndex >= siblingLayers.length} onClick={() => void run('reorder_layer', { layerId: selectedLayer.id, index: layerUpIndex })}><ArrowUpRight size={13} /></ButtonIcon></div></div>}
          {doc && doc.backend === backend && selectedLayer && activeBackend && (doc.backend === 'native' && selectedLayer.type === 'raster' || Boolean(selectedLayer.filters?.length || selectedLayer.filterMask) || ['set_layer_filter_mask', 'modify_layer_filter_mask', 'clear_layer_filter_mask'].some(can) || canBakeFilters || can('clear_layer_filters') || (can('add_layer_filter') || can('update_layer_filter')) && Boolean(activeBackend.layerFilterKinds?.length)) && <LayerFilters key={`${backend}-${doc.id}-${selectedLayer.id}`} document={doc} layer={selectedLayer} capabilities={activeBackend} busy={Boolean(busy)} can={can} run={run} onInspectFilterMask={() => openMaskInspection('filter-mask', selectedLayer.id)} />}
          {selectedLayer && selectedLayer.type !== 'adjustment' && selectedLayer.type !== 'group' && can('set_layer_effects') && <LayerEffects key={selectedLayer.id} layer={selectedLayer} busy={Boolean(busy)} run={run} />}
          {selectedLayer && selectedLayer.type !== 'adjustment' && selectedLayer.type !== 'group' && can('set_layer_protection') && <CutoutLayerProperties canBakeFilters={canBakeFilters} document={doc} canRefineSelection={Boolean(doc?.selection) && canEditCutoutAlpha(selectedLayer, doc) && can('refine_cutout_from_selection')} layer={selectedLayer} busy={Boolean(busy)} run={run} onRefine={() => { setTool(canEditCutoutAlpha(selectedLayer, doc) && can('paint_cutout_mask') ? 'cutout_brush' : 'mask_brush'); setBrush((current) => ({ ...current, mode: 'subtract' })); }} onOpen={() => openModal('cutouts')} />}
          {selectedLayer && doc && doc.backend === backend && selectedLayer.type === 'adjustment' && (can('update_adjustment') || selectedLayer.kind === 'color_lookup' || selectedLayer.kind === 'photo_filter' || selectedLayer.kind === 'selective_color' || selectedLayer.kind === 'hue_saturation' || selectedLayer.kind === 'curves' && isBankedCurves(selectedLayer.parameters)) && <AdjustmentProperties capabilities={activeBackend} kinds={activeBackend?.adjustmentKinds} document={doc} layer={selectedLayer} busy={Boolean(busy)} run={run} />}
          {selectedLayer && doc && selectedLayer.type === 'text' && can('update_text') && <TextProperties capabilities={activeBackend} document={doc} layer={selectedLayer} busy={Boolean(busy)} run={run} />}
          {selectedLayer?.vector && 'shape' in selectedLayer.vector && can('update_shape') && <ShapeProperties layer={selectedLayer} busy={Boolean(busy)} run={run} />}
          {selectedLayer?.vector && 'nodes' in selectedLayer.vector && can('update_path') && <PathProperties layer={selectedLayer} busy={Boolean(busy)} run={run} onEditAnchors={() => setTool('path_edit')} />}
          {selectedLayer?.gradient && can('update_gradient') && <GradientProperties layer={selectedLayer} busy={Boolean(busy)} run={run} />}
          {selectedLayer && doc && hasMaskInspector && <LayerMaskProperties key={maskInspectorKey} document={doc} capabilities={activeBackend} onInspect={canInspectLayerMask ? () => openMaskInspection('layer-mask', selectedLayer.id) : undefined} onPaint={() => { setTool('mask_brush'); setBrush((current) => ({ ...current, mode: 'subtract' })); }} contextKey={maskContextKey} maskProperties={can('modify_layer_mask') ? activeBackend?.layerMaskProperties : []} morphologyOperations={can('morph_layer_mask') ? activeBackend?.morphologyOperations : []} maxMorphologyRadius={activeBackend?.limits?.maxMorphologyRadius} layer={selectedLayer} selection={activeSelection} busy={Boolean(busy)} run={run} />}
          {resizeReview && resizeReview.documentId === doc?.id && <div className="panel-section mask-resize-return"><button className="button secondary wide" disabled={Boolean(busy)} onClick={() => { resizeSessionRef.current++; setResizeSession(resizeSessionRef.current); setModal('resize'); }}>Return to resize</button><p className="property-hint">Your {resizeReview.draft.width} × {resizeReview.draft.height} px draft and resampling choice are saved. Review them before applying.</p></div>}
          <DistortPanel control={distort} />
          {selectedLayer && selectedLayer.type !== 'group' && can('transform_layer') && <div className="panel-section pro-layer-actions"><button className="button secondary wide" disabled={Boolean(busy) || selectedLayer.type === 'adjustment'} onClick={() => openModal('transform')}><Move size={13} />Transform layer</button>{selectedLayer.type !== 'raster' && selectedLayer.type !== 'adjustment' && <button className="button subtle wide" disabled={Boolean(busy)} onClick={() => void run('rasterize_layer', { layerId: selectedLayer.id }, 'Rasterizing layer')}>Rasterize for pixel editing</button>}<button className="button subtle wide" disabled={Boolean(busy)} onClick={() => void run('add_paint_layer', { name: 'Paint layer' }, 'Adding paint layer')}><Plus size={13} />Add paint layer</button></div>}
          <div className="panel-section quick-edits"><div className="section-heading"><span>Make it your own</span><Sparkles size={13} /></div><p>A starting point for your next edit.</p><div className="quick-grid"><button disabled={!doc || Boolean(busy) || !can('add_adjustment')} onClick={() => { setTab('adjustments'); setActiveAdjustment(backend === 'photoshop' ? 'exposure' : 'temperature'); }}><Sun size={18} /><span>Light & color</span></button><button disabled={!doc || Boolean(busy) || !can('add_text')} onClick={() => openModal('text')}><Type size={18} /><span>Add text</span></button><button disabled={!doc || Boolean(busy) || !can('crop_document')} onClick={() => setTool('crop')}><Crop size={18} /><span>Reframe</span></button><button disabled={!doc || Boolean(busy) || (!can('resize_document') && !(backend === 'native' && can('resize_canvas')))} onClick={() => openModal('resize')}><Maximize size={17} /><span>Resize</span></button></div></div></>}

        {tab === 'guides' && hasGuides && doc && activeBackend && <GuidesPanel key={doc.id} document={doc} capabilities={activeBackend} view={guideView} setView={setGuideView} busy={Boolean(busy)} run={run} can={can} snapReason={moveCanvas.snapReason} onBack={() => setTab('layers')} />}

        {tab === 'selections' && hasSelectionPanel && <SavedSelections onInspect={canInspectSelection ? () => openMaskInspection('selection') : undefined} capabilities={activeBackend} sourceSection={doc && activeBackend ? <>{hasColorRange && <ColorRangeSelection key={`range:${backend}:${doc.id}`} document={doc} capabilities={activeBackend} busy={Boolean(busy) || !connected} foreground={foregroundColor} load={channelSelection.loadColorRange} review={channelSelection.review} state={channelSelection.state} producer={channelSelection.producer} reviewing={channelSelection.reviewing} />}{hasChannelSelection && <ChannelSelection key={`${backend}:${doc.id}`} document={doc} capabilities={activeBackend} busy={Boolean(busy) || !connected} {...channelSelection} />}{hasLayerSelection && <LayerSelection key={`${backend}:${doc.id}:${doc.revision}:${selectedLayer?.id}`} document={doc} layer={selectedLayer} capabilities={activeBackend} selection={activeSelection} busy={Boolean(busy) || !connected} run={run} onSelectLayer={setSelectedLayerId} />}</> : undefined} morphologyOperations={activeBackend?.morphologyOperations} maxMorphologyRadius={activeBackend?.limits?.maxMorphologyRadius} key={doc?.id} document={doc} selection={activeSelection} busy={Boolean(busy)} can={can} run={run} onEdit={() => setTool('select')} />}

        {tab === 'adjustments' && <div className="adjustments-panel">{doc && doc.backend === backend && backend === 'native' && <div className="panel-section"><ColorLookup key={`${backend}:${doc.id}`} document={doc} capabilities={activeBackend} scope="global" selectedLayerId={selectedLayerId || undefined} busy={Boolean(busy)} run={run} /></div>}{doc && doc.backend === backend && activeBackend?.adjustmentKinds?.some(kind => PARAMETERIZED_COLOR_KINDS.includes(kind)) && <div className="panel-section professional-color"><div className="section-heading"><span>Precise tonal control</span><SlidersHorizontal size={14} /></div><ColorWorkbench document={doc} selectedLayerId={selectedLayerId || undefined} capabilities={activeBackend} busy={Boolean(busy)} run={run} kinds={activeBackend?.adjustmentKinds} /></div>}<div className="panel-section"><div className="section-heading"><span>Light & color</span><Sun size={15} /></div><p className="panel-description">Shape the feeling. Each adjustment becomes its own editable layer.</p><div className={`mask-notice ${activeSelection ? 'has-mask' : ''}`}><SquareDashed size={14} /><span>{activeSelection ? backend === 'photoshop' ? 'Applying to the active Photoshop selection' : `Selected area · ${activeSelection.width} × ${activeSelection.height} px` : 'Applying to the entire canvas'}</span></div>{availableAdjustments.map((adjustment) => <div key={adjustment.id} className={`adjustment-item ${activeAdjustment === adjustment.id ? 'expanded' : ''}`}><button className="adjustment-title" onClick={() => setActiveAdjustment(adjustment.id)}><span>{adjustment.label}{adjustment.nativeOnly && <small className="adjustment-native-tag">Native</small>}</span><span>{adjustmentValue(adjustment.id)}<ChevronDown size={13} /></span></button>{activeAdjustment === adjustment.id && <div className="adjustment-content"><input aria-label={adjustment.label} type="range" min={adjustment.min} max={adjustment.max} step={adjustment.step} value={adjustmentValue(adjustment.id)} onChange={(event) => setAdjustmentValues((values) => ({ ...values, [adjustment.id]: Number(event.target.value) }))} /><div className="range-labels"><span>{adjustment.min}{adjustment.unit}</span><span>{adjustment.max}{adjustment.unit}</span></div><button className="button secondary wide" disabled={!doc || Boolean(busy) || !can('add_adjustment') || !validAdjustmentValue(adjustment, adjustmentValue(adjustment.id)) || (!adjustmentValue(adjustment.id) && adjustment.id !== 'threshold')} onClick={() => void applyAdjustment(adjustment.id, adjustmentValue(adjustment.id))}><Plus size={13} />Add adjustment layer</button></div>}</div>)}</div><div className="panel-section"><div className="section-heading"><span>A quick starting point</span></div><div className="preset-list">{backend === 'native' && <button disabled={!doc || Boolean(busy) || !can('add_adjustment')} onClick={() => void applyAdjustment('temperature', 20)}><span className="preset-dot warm" />A little warmer<span>+20</span></button>}<button disabled={!doc || Boolean(busy) || !can('add_adjustment')} onClick={() => void applyAdjustment('saturation', -100)}><span className="preset-dot mono" />Desaturate<ChevronRight size={13} /></button><button disabled={!doc || Boolean(busy) || !can('add_adjustment')} onClick={() => void applyAdjustment('contrast', 15)}><span className="preset-dot contrast" />A touch of contrast<span>+15</span></button></div></div></div>}

        {tab === 'history' && <div className="history-panel"><div className="panel-section"><div className="section-heading"><span>Your creative process</span><History size={14} /></div><p className="panel-description">Explore freely. Step back whenever you need.</p><div className="history-buttons"><button className="button secondary" disabled={!doc?.canUndo || Boolean(busy)} onClick={() => void run('undo')}><Undo2 size={14} />Undo</button><button className="button secondary" disabled={!doc?.canRedo || Boolean(busy)} onClick={() => void run('redo')}><Redo2 size={14} />Redo</button></div></div><div className="history-list">{doc?.history?.length ? doc.history.slice().reverse().map((entry, index) => <div className={`history-item ${entry.active ? 'current' : ''} ${entry.future ? 'future' : ''}`} key={entry.id}><span className="history-marker">{entry.active ? <Check size={11} /> : <span />}</span><div><strong>{entry.label}</strong><span>{entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Document history'}{entry.active ? ' · Current state' : entry.future ? ' · Undone' : ''}</span></div></div>) : <div className="panel-empty"><History size={25} /><p>{backend === 'photoshop' ? 'Photoshop history is managed in the desktop app.' : 'Your next edit starts the story.'}</p></div>}</div></div>}
        {tab !== 'chat' && <div className="inspector-footer"><div className="connection-card"><span className="connection-symbol"><Link2 size={16} /></span><div><strong>Edit with your AI.</strong><p>Connect Codex through MCP.</p></div><ButtonIcon label="Set up MCP connection" onClick={() => { setSetupTab('mcp'); openModal('setup'); }}><ArrowUpRight size={17} /></ButtonIcon></div></div>}
      </aside>}
    </div>
    <footer className="statusbar"><span><span className={`status-dot ${connected && !connectionError ? 'connected' : ''}`} />{connectionError ? 'Local editor unavailable' : connected ? backend === 'native' ? 'Local editor ready' : 'Optional Photoshop connection active' : backend === 'native' ? 'Connecting to local editor' : 'Optional Photoshop connection offline'}</span><span className="statusbar-center">A clearer path from idea to image.</span><button onClick={() => openModal('setup')}>Prism Studio <span>v{status?.version || '0.1.0'}</span><ChevronRight size={11} /></button></footer>

    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleAlert size={17} /> : <Check size={17} />}<span>{toast.message}</span>{toast.retry && <button className="toast-retry" disabled={Boolean(busy)} onClick={toast.retry}>Retry project import</button>}<button aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={14} /></button></div>}

    {modal && <div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}><section className={`modal ${modal === 'recipes' ? 'edit-recipes-modal' : modal === 'maskInspection' ? 'mask-inspection-modal' : modal === 'psdImport' ? 'psd-import-modal' : modal === 'generate' ? 'generation-modal' : modal === 'cutouts' ? 'cutout-modal' : modal === 'setup' || modal === 'tools' ? 'setup-modal' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-top"><PrismMark small /><ButtonIcon label="Close dialog" disabled={modal === 'psdImport' && psdImport.importing} onClick={closeModal}><X size={18} /></ButtonIcon></div>
      {modal === 'maskInspection' && maskInspectionTarget && doc && activeBackend && <MaskInspection target={maskInspectionTarget} document={doc} backend={backend} selectedLayerId={selectedLayerId} capabilities={activeBackend} onClose={closeModal} />}
      {modal === 'psdImport' && <PsdImport controller={psdImport} onChoose={() => psdInputRef.current?.click()} onClose={closeModal} />}
      {modal === 'setup' && <><span className="eyebrow">MAKE THE CONNECTION</span><h1 id="modal-title">Your assistant. Your creative tools.</h1><p className="modal-intro">Prism is a standalone image editor. Connect Codex through MCP to edit its local projects with natural language.</p><div className="setup-tabs"><button className={setupTab === 'mcp' ? 'selected' : ''} onClick={() => setSetupTab('mcp')}><Sparkles size={15} />Codex / MCP</button><button className={setupTab === 'photoshop' ? 'selected' : ''} onClick={() => setSetupTab('photoshop')}><span className="ps-icon tiny" aria-hidden="true">Ps</span>Photoshop · optional</button></div>{setupError ? <div className="inline-error">{setupError}</div> : !setup ? <p><LoaderCircle className="spin" size={18} /> Loading local connection settings…</p> : setupTab === 'photoshop' ? <div className="setup-content"><div className={`setup-status ${status?.bridge.connected ? 'online' : ''}`}><span className={`status-dot ${status?.bridge.connected ? 'connected' : ''}`} />{status?.bridge.connected ? `Connected to Photoshop ${status.bridge.appVersion || ''}` : 'Waiting for the Photoshop plugin'}</div><ol className="setup-steps"><li><span>1</span><div><strong>Load the Prism plugin</strong><p>In Adobe UXP Developer Tool, choose Add Plugin and select the manifest inside this folder. Then click Load.</p><div className="copy-field"><code>{setup.pluginPath}</code><ButtonIcon label="Copy plugin path" onClick={() => void copy(setup.pluginPath, 'path')}>{copied === 'path' ? <Check size={14} /> : <Copy size={14} />}</ButtonIcon></div></div></li><li><span>2</span><div><strong>Pair your local companion</strong><p>Open the Prism panel in Photoshop. Enter this bridge URL and pairing token, then connect.</p><div className="copy-field"><code>{setup.bridgeUrl}</code><ButtonIcon label="Copy bridge URL" onClick={() => void copy(setup.bridgeUrl, 'bridge')}>{copied === 'bridge' ? <Check size={14} /> : <Copy size={14} />}</ButtonIcon></div><div className="copy-field"><code>{showToken ? setup.token : '••••••••••••••••••••••••'}</code><ButtonIcon label={showToken ? 'Hide pairing token' : 'Show pairing token'} onClick={() => setShowToken(!showToken)}>{showToken ? <EyeOff size={14} /> : <Eye size={14} />}</ButtonIcon><ButtonIcon label="Copy pairing token" onClick={() => void copy(setup.token, 'token')}>{copied === 'token' ? <Check size={14} /> : <Copy size={14} />}</ButtonIcon></div></div></li><li><span>3</span><div><strong>Open an image in Photoshop</strong><p>Switch this workspace to Adobe Photoshop. Your layers and document preview will appear here.</p></div></li></ol><button className="button primary wide" onClick={() => { setModal(null); switchBackend('photoshop'); if (backend === 'photoshop') void loadWorkspace('photoshop'); }}>Open Photoshop workspace<ArrowRight size={15} /></button></div> : <div className="setup-content"><div className="setup-callout"><Sparkles size={20} /><p>The assistant in your MCP client performs the edits. This workspace shows the actual document and provides manual controls.</p></div><ol className="setup-steps"><li><span>1</span><div><strong>Add the local MCP server</strong><p>Use the following command and arguments in your MCP client’s local server settings.</p><div className="code-block"><pre>{JSON.stringify({ mcpServers: { prism: { command: setup.mcpCommand, args: setup.mcpArgs } } }, null, 2)}</pre><ButtonIcon label="Copy MCP configuration" onClick={() => void copy(JSON.stringify({ mcpServers: { prism: { command: setup.mcpCommand, args: setup.mcpArgs } } }, null, 2), 'mcp')}>{copied === 'mcp' ? <Check size={15} /> : <Copy size={15} />}</ButtonIcon></div></div></li><li><span>2</span><div><strong>Describe the edit in Codex</strong><p>Ask your connected assistant to inspect your Prism document and apply an edit. Use Chat to describe edits, new images, or both. Manual layer controls remain available beside it.</p><blockquote>“Use Prism to warm the colors slightly and add a subtle contrast adjustment. Keep the layers editable.”</blockquote></div></li></ol></div>}</>}
      {modal === 'new' && <><span className="eyebrow">A FRESH START</span><h1 id="modal-title">Make a little space.</h1><p className="modal-intro">Create a canvas for your next idea.</p><form onSubmit={(event) => { event.preventDefault(); void run('create_document', { name: newName, width: sizeWidth, height: sizeHeight, background: newColor }, 'Creating canvas').then((result) => { if (result) { setModal(null); setZoom('fit'); setSelection(null); } }); }}><label className="field-label">Document name<input autoFocus required value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} /></label><div className="form-grid"><label className="field-label">Width, px<input required type="number" min="1" max="8192" value={sizeWidth} onChange={(event) => setSizeWidth(Number(event.target.value))} /></label><label className="field-label">Height, px<input required type="number" min="1" max="8192" value={sizeHeight} onChange={(event) => setSizeHeight(Number(event.target.value))} /></label></div><label className="field-label color-field">Background<input type="color" value={newColor} onChange={(event) => setNewColor(event.target.value)} /><span>{newColor.toUpperCase()}</span></label><button className="button primary wide" disabled={Boolean(busy)} type="submit"><Plus size={15} />Create canvas</button></form></>}
      {modal === 'recipes' && doc && activeBackend && <EditRecipes key={`${backend}:${doc.id}`} document={doc} layer={selectedLayer} capabilities={activeBackend} busy={Boolean(busy)} mutate={recipeMutation} application={recipeApplication} refresh={refreshRecipeDocument} />}
      {modal === 'cutouts' && <CutoutPanel canBakeFilters={canBakeFilters} initialAction={cutoutAction} document={doc} documents={documents} layer={selectedLayer} preview={preview} backend={backend} segmentation={status?.segmentation} busy={Boolean(busy)} can={can} run={run} onSelectLayer={setSelectedLayerId} onRefine={() => { setModal(null); setTab('layers'); setTool(canEditCutoutAlpha(selectedLayer, doc) && can('paint_cutout_mask') ? 'cutout_brush' : 'mask_brush'); setBrush((current) => ({ ...current, mode: 'subtract', color: '#ffffff' })); }} onImport={() => { setModal(null); inputRef.current?.click(); }} onSwitchNative={() => switchBackend('native')} />}
      {modal === 'generate' && <GenerationPanel controller={generation} document={doc} backend={backend} busy={Boolean(busy)} initialPrompt={chat.draft} initialJobId={generationFocusId} onOpenResult={openGenerationResult} onSwitchNative={() => switchBackend('native')} onSelectArea={() => { setTool('select'); setModal(null); }} />}
      {modal === 'tools' && <ToolBrowser backend={backend} catalog={toolCatalog as CatalogEntry[]} commands={activeBackend?.commands || []} canOpen={canOpenTool} onChoose={chooseCatalogTool} />}
      {modal === 'transform' && selectedLayer && selectedLayer.type !== 'group' && <TransformForm layer={selectedLayer} busy={Boolean(busy)} run={run} onComplete={() => setModal(null)} />}
      {modal === 'resize' && doc && doc.backend === backend && <ResizePanel key={`${backend}:${doc.id}:${resizeSession}`} backend={activeBackend} captureCapabilityGuard={captureResizeCapabilityGuard} initialMode={resizeMode} initialDraft={resizeReview?.documentId === doc.id ? resizeReview.draft : undefined} document={doc} preview={preview} canResizeCanvas={can('resize_canvas')} busy={Boolean(busy)} run={run} onReviewMask={(layerId, draft) => { setResizeReview({ documentId: doc.id, draft, layerId }); setSelectedLayerId(layerId); selectedLayerRef.current = layerId; setTab('layers'); setInspectorOpen(true); setModal(null); }} onComplete={result => { if (resizeSessionRef.current !== resizeSession || modalRef.current !== 'resize' || backendRef.current !== result.backend || docRef.current?.id !== result.id || docRef.current.revision !== result.revision || docRef.current.width !== result.width || docRef.current.height !== result.height) return; setModal(null); setResizeReview(null); setZoom('fit'); }} />}
      {modal === 'text' && doc && <TextCreationForm key={`${backend}:${doc.id}:${doc.revision}:${selectedLayerId}`} document={doc} selectedLayerId={selectedLayerId || undefined} capabilities={activeBackend} busy={Boolean(busy)} run={run} initial={{ text: textValue, fontSize: textSize, color: textColor, fontFamily: textFamily, fontWeight: textWeight, fontStyle: textStyle, align: 'left', ...textPosition }} onComplete={settings => { setTextValue(settings.text); setTextSize(settings.fontSize); setTextColor(settings.color); setTextFamily(settings.fontFamily); setTextWeight(settings.fontWeight); setTextStyle(settings.fontStyle); setTextPosition({ x: settings.x, y: settings.y }); setModal(value => value === 'text' ? null : value); setTab('layers'); }} />}
      {modal === 'export' && doc && <ExportPanel onRefreshDocument={refreshExportDocument} initialKind={exportKind} onExportProject={() => void downloadProject()} document={doc} preview={preview} backend={backend} capabilities={activeBackend} busy={Boolean(busy)} onExport={(settings) => { void run('export_document', settings, 'Preparing export').then((result) => { if (result?.data) { downloadBase64(result.data, result.mimeType!, result.filename || `${doc.name}.${settings.format}`); setModal(null); notify('Your image is ready. Download started.'); } }); }} />}
      {modal === 'help' && <><span className="eyebrow">FIND YOUR FLOW</span><h1 id="modal-title">A few useful shortcuts.</h1><p className="modal-intro">Manual precision and AI direction, in the same workspace.</p><div className="shortcut-list">{[[backend === 'native' ? 'Move selected layer' : 'Inspect canvas', 'V'], ['Rectangle / ellipse selection', 'M / ⇧ M'], ['Select all / deselect', '⌘ A / ⌘ D'], ['Invert selection', '⇧ ⌘ I'], ['Crop canvas', 'C'], ['Place text', 'T'], ['Pan canvas', 'H / hold Space'], ['Brush / pencil / eraser', 'B / ⇧ B / E'], ['Clone / healing', 'S / J'], ['Dodge / burn', 'O / ⇧ O'], ['Lasso selection', 'L'], ['Brush size / hardness', '[ ] / ⇧ [ ]'], ['Brush opacity', '1 … 0'], ['Eyedropper (⌥ click: background)', 'I'], ['Swap / default colors', 'X / D'], ['Zoom in / out', '⌘ + / ⌘ −'], ['Fit on screen / 100%', '⌘ 0 / ⌘ 1'], ['Rulers / guides (drag from ruler)', '⌘ R / ⌘ ;'], ['New canvas', '⌘ N'], ['Open image', '⌘ O'], ['Save locally', '⌘ S'], ['Undo', '⌘ Z'], ['Redo', '⇧ ⌘ Z']].map(([label, key]) => <div key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div><p className="help-note">Native projects persist locally. Use adjustments for editable color changes, or draw a selection to limit an adjustment to one area. Connect an MCP client to edit with natural language.</p><button className="button primary wide" onClick={() => { setSetupTab('mcp'); openModal('setup'); }}><Link2 size={15} />Set up your AI connection</button></>}
    </section></div>}
  </div>;
}
