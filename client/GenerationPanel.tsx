import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, Copy, MessageSquare, ImagePlus, Layers, LoaderCircle, RefreshCw, Sparkles, SquareDashed, WandSparkles, X } from 'lucide-react';
import { api, command, type BackendId, type Document } from './api';
import { codexJobPresentation } from './generation';
import type { CodexWorkerStatus, GenerationBackground, GenerationController, GenerationJob, GenerationPreview, GenerationProvider, GenerationQuality, GenerationSize } from './generation';
import './generation.css';

const previewCache = new Map<string, Promise<GenerationPreview>>();
function previewFor(id: string) {
  if (!previewCache.has(id)) {
    const request = api<GenerationPreview>(`/api/ai/jobs/${encodeURIComponent(id)}/preview`).catch((error) => { previewCache.delete(id); throw error; });
    previewCache.set(id, request);
    if (previewCache.size > 24) previewCache.delete(previewCache.keys().next().value!);
  }
  return previewCache.get(id)!;
}

function usePreview(job?: GenerationJob) {
  const [value, setValue] = useState<GenerationPreview | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false; setValue(null); setError('');
    if (job?.outputAvailable) void previewFor(job.id).then((next) => { if (!cancelled) setValue(next); }).catch((reason) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [job?.id, job?.outputAvailable, attempt]);
  return { preview: value, error, retry: () => { if (job) previewCache.delete(job.id); setAttempt((value) => value + 1); } };
}

function JobThumbnail({ job, worker }: { job: GenerationJob; worker?: CodexWorkerStatus }) {
  const { preview } = usePreview(job);
  return <span className="generation-job-thumb">{preview ? <img src={`data:${preview.mimeType};base64,${preview.data}`} alt="Generated image thumbnail" /> : job.status === 'running' || job.status === 'queued' || codexJobPresentation(job, worker)?.spinning ? <LoaderCircle size={16} className="spin" /> : job.status === 'failed' ? <CircleAlert size={17} /> : <ImagePlus size={18} />}</span>;
}

const isCodex = (job: GenerationJob) => job.provider === 'codex' || job.model === 'codex-imagegen';
const handoffInstruction = (job: GenerationJob) => `Complete Prism image request ${job.id} in this Codex conversation. Use prism_get_generation_handoff with jobId "${job.id}" to read the saved prompt and reference images/mask. Use your built-in image generation tool, then call prism_complete_generation with jobId "${job.id}" and the generated local image path. Preserve the handoff constraints and original protected pixels.`;
const STATUS_LABELS: Record<GenerationJob['status'], string> = { awaiting_image: 'Waiting for image from Codex', queued: 'Queued', running: 'Creating your image', ready: 'Ready to apply', succeeded: 'Added to your workspace', failed: 'Could not complete', cancelled: 'Cancelled' };
const QUALITY_LABELS: Record<GenerationQuality, string> = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };

function elapsed(job: GenerationJob, now: number) {
  const end = (job.status === 'running' || job.status === 'queued' || job.status === 'awaiting_image') && job.automation?.state !== 'interrupted' && job.automation?.state !== 'failed' ? now : Date.parse(job.updatedAt);
  const seconds = Math.max(0, Math.floor((end - Date.parse(job.createdAt)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

export function GenerationPanel({ controller, document, backend, busy, initialPrompt, initialJobId, onOpenResult, onSwitchNative, onSelectArea }: { controller: GenerationController; document: Document | null; backend: BackendId; busy: boolean; initialPrompt: string; initialJobId?: string; onOpenResult: (documentId: string, layerId?: string) => Promise<void>; onSwitchNative: () => void; onSelectArea: () => void }) {
  const { status, checkApiConfiguration, checkingApiConfiguration, jobs, loading, error, submitting, pendingAction, submit, cancel, apply, refresh } = controller;
  const [provider, setProvider] = useState<GenerationProvider>('codex');
  const [copiedJob, setCopiedJob] = useState('');
  const [mode, setMode] = useState<'generate' | 'edit' | 'selection'>('generate');
  const [target, setTarget] = useState<'new' | 'layer'>('new');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [model, setModel] = useState('');
  const [quality, setQuality] = useState<GenerationQuality>('medium');
  const [size, setSize] = useState<GenerationSize>('auto');
  const [fit, setFit] = useState<'contain' | 'cover'>('contain');
  const [background, setBackground] = useState<GenerationBackground>('auto');
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState(initialJobId || '');
  useEffect(() => { if (initialJobId) setSelectedId(initialJobId); }, [initialJobId]);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [actionError, setActionError] = useState('');
  const [applying, setApplying] = useState(false);
  const initialized = useRef(false);
  const nativeDocument = document?.backend === 'native' ? document : null;
  const hasSelection = Boolean(nativeDocument?.selection);
  const selectedJob = jobs.find((job) => job.id === selectedId) || jobs.find((job) => job.status === 'running' || job.status === 'ready' || job.status === 'awaiting_image') || jobs[0];
  const { preview, error: previewError, retry: retryPreview } = usePreview(selectedJob);
  const worker = status?.codexWorker;
  const automatic = Boolean(worker?.enabled);
  const automationReady = Boolean(automatic && worker?.available && (worker.state === 'ready' || worker.state === 'working'));
  const selectedCodex = selectedJob ? codexJobPresentation(selectedJob, worker) : null;
  const hasSavedResult = Boolean(selectedJob?.outputAvailable && (selectedJob.status === 'ready' || selectedJob.status === 'cancelled'));
  const selectedModel = status?.models.find((item) => item.id === model);
  const qualities: GenerationQuality[] = selectedModel?.qualities || selectedModel?.supportedQualities || (model.includes('2.5') ? ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] : ['auto', 'low', 'medium', 'high']);
  const needsDocument = mode !== 'generate' || target === 'layer';
  const missingSelection = mode === 'selection' && !hasSelection;
  const inFlight = jobs.filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'awaiting_image');
  const queueFull = Boolean(status && inFlight.length >= status.limits.maxQueued + status.limits.maxActive);
  const canSubmit = !submitting && !loading && !busy && Boolean(status) && (provider === 'codex' ? Boolean(status?.providers?.some(item => item.id === 'codex' && item.available)) : Boolean(status?.configured) && Boolean(model) && !checkingApiConfiguration) && Boolean(prompt.trim()) && (!needsDocument || Boolean(nativeDocument)) && !missingSelection && !queueFull && backend === 'native';

  useEffect(() => { if (provider === 'openai') void checkApiConfiguration(); }, [provider, checkApiConfiguration]);
  useEffect(() => {
    if (!status || initialized.current) return;
    setModel(status.defaultModel || status.models[0]?.id || ''); setQuality(status.defaultQuality || 'medium'); initialized.current = true;
  }, [status]);
  useEffect(() => { if (model && !qualities.includes(quality)) setQuality(qualities.includes('medium') ? 'medium' : qualities[0]); }, [model, quality, qualities.join(',')]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);

  const submitRequest = async () => {
    setActionError('');
    if (!canSubmit) return;
    const job = await submit({ mode: mode === 'generate' ? 'generate' : 'edit', prompt: prompt.trim(), provider, ...(provider === 'openai' ? { model, quality } : {}), size, background, scope: mode === 'selection' ? 'selection' : 'canvas', ...(mode === 'generate' && target === 'layer' ? { fit } : {}), ...(needsDocument && nativeDocument ? { documentId: nativeDocument.id, expectedRevision: nativeDocument.revision } : {}), ...(name.trim() ? { name: name.trim() } : {}) });
    if (job) setSelectedId(job.id);
  };

  const applyResult = async (job: GenerationJob) => {
    setApplying(true); setActionError('');
    try {
      const current = job.documentId ? await command<{ document: Document }>('native', 'get_document', { documentId: job.documentId }) : null;
      const result = await apply(job.id, current?.document.revision);
      if (result?.status === 'succeeded' && result.documentId) await onOpenResult(result.documentId, result.layerId);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : 'Could not apply the saved result.'); }
    finally { setApplying(false); }
  };

  const usePrompt = (job: GenerationJob) => {
    setProvider(isCodex(job) ? 'codex' : 'openai'); setPrompt(job.prompt); setMode(job.mode === 'generate' ? 'generate' : job.scope === 'selection' ? 'selection' : 'edit');
    if (status?.models.some((item) => item.id === job.model)) setModel(job.model);
    setQuality(job.quality); setSize(job.size); setBackground(job.background);
  };

  const copyHandoff = async (job: GenerationJob) => {
    setActionError('');
    try { await navigator.clipboard.writeText(handoffInstruction(job)); setCopiedJob(job.id); }
    catch { setActionError('Copy is unavailable. Select and copy the instruction below, then send it in this Codex conversation.'); }
  };
  const providerReady = provider === 'codex' ? automatic ? automationReady : status?.providers?.some(item => item.id === 'codex' && item.available) : status?.configured;

  return <div className="generation-panel"><div className="generation-heading"><div><span className="eyebrow">IMAGINATION, INTO IMAGE</span><h1 id="modal-title">Make what you have in mind.</h1><p className="modal-intro">Create an image, reimagine your canvas, or fill a selected area.</p></div><span className={`generation-connection ${providerReady ? 'configured' : ''}`}><span className={`status-dot ${providerReady ? 'connected' : ''}`} />{loading || provider === 'openai' && checkingApiConfiguration ? 'Connecting' : provider === 'codex' ? automatic ? worker?.state === 'checking' ? 'Checking local Codex' : automationReady ? worker?.state === 'working' ? 'Local Codex working' : 'Local Codex ready' : 'Local Codex unavailable' : 'Codex conversation' : status?.configured ? 'OpenAI configured' : 'API not configured'}</span></div>
    {backend !== 'native' ? <div className="generation-native-notice"><Sparkles size={22} /><div><strong>Generate in Prism Native.</strong><p>Switch to the native editor to create images and add generated layers. Your Photoshop document stays in its own workspace.</p></div><button className="button primary" onClick={onSwitchNative}>Switch to Native<ArrowRight size={14} /></button></div> : <div className="generation-layout">
      <form className="generation-form" onSubmit={(event) => { event.preventDefault(); void submitRequest(); }}>
        <label className="field-label generation-provider">Create images with<select aria-label="Image generation provider" value={provider} onChange={event => setProvider(event.target.value as GenerationProvider)}><option value="codex">{automatic ? 'Codex · automatic local worker' : 'Codex conversation'}</option><option value="openai">OpenAI API (optional)</option></select></label>{provider === 'codex' && <p className="generation-handoff-intro" role="status">{automatic ? automationReady ? 'The local Codex worker checks the queue every 5 seconds, creates your image, and returns it here automatically. No copying is needed.' : worker?.message || (worker?.state === 'checking' ? 'Checking local Codex. Submitted requests wait in its automatic queue.' : 'The local Codex worker is unavailable. Submitted requests wait until it is ready; you can cancel queued requests.') : 'Prepare your request here, then send its instruction to your Codex conversation. Codex creates the image with its image tool and returns it to this workspace.'}</p>}
        <div className="generation-modes" role="group" aria-label="Image generation mode">{([
          ['generate', 'Generate image', ImagePlus], ['edit', 'Edit canvas', WandSparkles], ['selection', 'Selection fill', SquareDashed],
        ] as const).map(([value, label, Icon]) => <button key={value} type="button" className={mode === value ? 'selected' : ''} onClick={() => setMode(value)}><Icon size={16} /><span>{label}</span></button>)}</div>
        <label className="generation-prompt-label" htmlFor="generation-prompt">{mode === 'generate' ? 'Describe the image' : mode === 'edit' ? 'Describe your edit' : 'What belongs in this selection?'}</label><textarea id="generation-prompt" className="generation-prompt" aria-label="Image generation prompt" autoFocus required maxLength={8000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={mode === 'generate' ? 'A quiet coastal house at blue hour, warm light in the windows, cinematic photography…' : mode === 'edit' ? 'Make the lighting warmer and replace the cloudy sky with a clear sunset. Preserve the building and composition…' : 'Fill this area with soft wildflowers that match the existing light and perspective…'} rows={5} />
        <div className="generation-prompt-footer"><span>{mode === 'selection' ? 'Uses your active selection as the edit boundary.' : mode === 'edit' ? 'Your original image stays in its existing layer.' : 'Be specific about subject, style, light, and composition.'}</span><span>{prompt.length.toLocaleString()} / 8,000</span></div>
        {mode === 'generate' ? <label className="field-label generation-target">Add the result to<select aria-label="Generation destination" value={target} onChange={(event) => setTarget(event.target.value as 'new' | 'layer')}><option value="new">A new document</option><option value="layer" disabled={!nativeDocument}>A new layer{nativeDocument ? ` in ${nativeDocument.name}` : ''}</option></select></label> : <div className={`generation-target-document ${!nativeDocument || missingSelection ? 'needs-target' : ''}`}><Layers size={16} /><div><strong>{nativeDocument?.name || 'Open an image to edit'}</strong><span>{missingSelection ? 'Draw a selection on the canvas before submitting.' : nativeDocument ? `${nativeDocument.width} × ${nativeDocument.height} px · ${mode === 'selection' ? 'Active selection' : 'Full canvas'}` : 'Image edits need an open native document.'}</span></div>{missingSelection && nativeDocument && <button type="button" className="button mini subtle" onClick={onSelectArea}>Select area</button>}</div>}
        {mode === 'generate' && target === 'layer' && <label className="field-label generation-fit">Canvas fit<select aria-label="Generated layer canvas fit" value={fit} onChange={(event) => setFit(event.target.value as 'contain' | 'cover')}><option value="contain">Fit whole image</option><option value="cover">Fill canvas (crop)</option></select></label>}{provider === 'openai' && <label className="field-label generation-model">Model<select aria-label="Image generation model" value={model} disabled={!status?.models.length || loading} onChange={(event) => setModel(event.target.value)}>{status?.models.length ? status.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>) : <option value="">Loading models…</option>}</select></label>}
        <div className={`form-grid generation-options ${provider === 'codex' ? 'codex-options' : ''}`}>{provider === 'openai' && <label className="field-label">Quality<select aria-label="Image generation quality" value={quality} onChange={(event) => setQuality(event.target.value as GenerationQuality)}>{qualities.map((value) => <option key={value} value={value}>{QUALITY_LABELS[value]}</option>)}</select></label>}<label className="field-label">Aspect ratio<select aria-label="Image generation aspect ratio" value={size} onChange={(event) => setSize(event.target.value as GenerationSize)}><option value="auto">Auto</option><option value="1024x1024">Square · 1:1</option><option value="1536x1024">Landscape · 3:2</option><option value="1024x1536">Portrait · 2:3</option></select></label></div>
        <label className="field-label generation-background">Background<select aria-label="Image generation background" value={background} onChange={(event) => setBackground(event.target.value as GenerationBackground)}><option value="auto">Automatic</option><option value="opaque">Opaque</option><option value="transparent">Transparent</option></select></label>
        <label className="field-label generation-result-name">Result name <span>Optional</span><input aria-label="Generated result name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder={mode === 'generate' ? 'Untitled generation' : 'Generated edit'} /></label>
        {provider === 'openai' && !loading && !checkingApiConfiguration && !status?.configured && <div className="generation-configuration-note"><CircleAlert size={14} /><span>Image generation needs a server-side OpenAI connection. Configure it locally, then refresh.</span><button type="button" aria-label="Refresh generation configuration" onClick={() => { void checkApiConfiguration(); refresh(); }}><RefreshCw size={14} /></button></div>}
        {(error || actionError) && <div className="generation-error" role="alert"><CircleAlert size={14} /><span>{actionError || error}</span></div>}
        <button type="submit" className="button primary generation-submit" disabled={!canSubmit}>{submitting ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{submitting ? 'Submitting request…' : queueFull ? 'Generation queue is full' : provider === 'codex' ? automatic ? automationReady ? 'Generate with Codex' : 'Queue for Codex' : 'Prepare Codex request' : mode === 'generate' ? 'Generate image' : mode === 'edit' ? 'Generate edit' : 'Generate selection fill'}<span>{submitting ? '' : '↗'}</span></button>
        <p className="generation-disclosure">{provider === 'codex' ? automatic ? 'Uses your signed-in local Codex account. Prompts and edit references are sent to Codex for image generation. No API key is needed. Aspect ratio and background are image-tool preferences.' : 'No API key is needed. Submission saves a handoff; image creation starts when you send it to Codex. Aspect ratio and background are preferences for its image tool.' : mode === 'generate' ? 'Your prompt is sent to OpenAI. Results are saved locally in your workspace.' : 'Edits send a snapshot of your canvas to OpenAI. Results return as a new layer.'}{provider === 'openai' && ' Higher quality may take longer.'}</p>
      </form>

      <aside className="generation-results" aria-label="Generation results"><div className="generation-results-title"><span>YOUR GENERATIONS</span><button type="button" aria-label="Refresh generation jobs" onClick={refresh}><RefreshCw size={12} /></button></div>
        <div className={`generation-preview-card ${preview ? 'has-image' : ''}`}>
          {preview ? <img src={`data:${preview.mimeType};base64,${preview.data}`} alt="Generated result preview" /> : selectedJob?.status === 'awaiting_image' ? <div className="generation-working generation-awaiting" role={selectedCodex?.stopped ? "alert" : "status"}>{selectedCodex?.spinning ? <LoaderCircle size={29} className="spin" /> : selectedCodex?.stopped ? <CircleAlert size={29} /> : selectedCodex?.manualHandoff ? <MessageSquare size={29} /> : <Clock3 size={29} />}<strong>{selectedCodex?.label || STATUS_LABELS.awaiting_image}</strong><p>{selectedCodex?.message}</p><span className="generation-elapsed"><Clock3 size={12} />{elapsed(selectedJob, now)} {selectedCodex?.spinning ? 'elapsed' : selectedCodex?.stopped ? 'until stopped' : 'waiting'}</span></div> : selectedJob && (selectedJob.status === 'queued' || selectedJob.status === 'running') ? <div className="generation-working"><span className="generation-orbit"><Sparkles size={25} /><i /></span><strong>{selectedJob.status === 'queued' ? 'Your idea is in the queue.' : 'Your image is taking shape.'}</strong><p>{selectedJob.status === 'queued' ? 'It will start when the current request finishes.' : 'You can keep editing while the model works.'}</p><span className="generation-elapsed"><Clock3 size={12} />{elapsed(selectedJob, now)} elapsed</span></div> : selectedJob?.status === 'failed' ? <div className="generation-working"><CircleAlert size={28} /><strong>This request could not finish.</strong><p>{selectedJob.error?.message || 'The provider could not complete this image request.'}</p></div> : <div className="generation-empty"><span className="generation-empty-frame"><ImagePlus size={29} /></span><strong>A space for your next idea.</strong><p>Your generated image will appear here.</p><div className="generation-empty-line" /></div>}
          {previewError && <div className="generation-preview-error"><span>{previewError}</span><button type="button" className="button mini subtle" onClick={retryPreview}><RefreshCw size={12} />Retry preview</button></div>}
        </div>
        {selectedJob && <div className="generation-selected-job"><div className="generation-job-state"><span className={`job-state-pill state-${selectedJob.status}`}>{selectedJob.status === 'running' || selectedJob.status === 'queued' || selectedCodex?.spinning ? <LoaderCircle size={10} className="spin" /> : selectedJob.status === 'succeeded' ? <Check size={10} /> : null}{selectedCodex?.label || STATUS_LABELS[selectedJob.status]}</span><span>{elapsed(selectedJob, now)}</span></div><p className="generation-result-prompt">{selectedJob.prompt}</p><div className="generation-result-meta"><span>{isCodex(selectedJob) ? selectedJob.automation ? 'Local Codex worker · built-in image tool' : 'Codex · built-in image tool' : status?.models.find((item) => item.id === selectedJob.model)?.label || selectedJob.model}</span><span>{isCodex(selectedJob) ? 'Image tool output' : `${QUALITY_LABELS[selectedJob.quality]} quality`}{preview ? ` · Preview ${preview.width} × ${preview.height}` : ''}</span></div>{hasSavedResult && <p className="generation-ready-note">{selectedJob.status === 'cancelled' ? 'This request was cancelled after its image returned. The saved result is available to apply.' : selectedJob.error?.message || 'The result is saved and ready to add as a new layer.'} Applying saved output makes no new provider request.</p>}
          {selectedCodex?.manualHandoff && <div className="generation-handoff"><span>CONTINUE IN THIS CODEX CONVERSATION</span><textarea aria-label="Codex image request instruction" readOnly value={handoffInstruction(selectedJob)} rows={5} onFocus={event => event.currentTarget.select()} /><button type="button" className="button secondary wide" onClick={() => void copyHandoff(selectedJob)}>{copiedJob === selectedJob.id ? <Check size={13} /> : <Copy size={13} />}{copiedJob === selectedJob.id ? 'Instruction copied' : 'Copy instruction for Codex'}</button><small>Job {selectedJob.id}. You can close this panel while Codex works. Reopen it to view the returned image.</small></div>}
          <div className="generation-result-actions">{selectedJob.status === 'queued' || selectedJob.status === 'running' || selectedJob.status === 'awaiting_image' ? <button type="button" className="button subtle wide" disabled={pendingAction === selectedJob.id} onClick={() => void cancel(selectedJob.id)}>{pendingAction === selectedJob.id ? <LoaderCircle size={13} className="spin" /> : <X size={13} />}Cancel request</button> : hasSavedResult ? <button type="button" className="button primary wide" disabled={applying || pendingAction === selectedJob.id || busy} onClick={() => void applyResult(selectedJob)}>{applying || pendingAction === selectedJob.id ? <LoaderCircle size={13} className="spin" /> : <Layers size={13} />}{selectedJob.documentId ? 'Apply to latest document' : 'Create document from result'}</button> : selectedJob.status === 'succeeded' && selectedJob.documentId ? <button type="button" className="button secondary wide" disabled={busy} onClick={() => void onOpenResult(selectedJob.documentId!, selectedJob.layerId).catch((reason) => setActionError(reason.message))}>Open result<ArrowUpRight size={13} /></button> : null}<button type="button" className="generation-reuse" onClick={() => usePrompt(selectedJob)}>Use this prompt</button></div>{selectedJob.status === 'running' && !isCodex(selectedJob) && <p className="generation-cancel-note">A running request may still incur provider charges if cancelled.</p>}
        </div>}
        <div className="generation-history-heading"><span>Recent requests</span><span>{jobs.length}</span></div><div className="generation-history">{(showAll ? jobs : jobs.slice(0, 8)).map((job) => <button type="button" key={job.id} className={`generation-history-item ${selectedJob?.id === job.id ? 'selected' : ''}`} onClick={() => { setSelectedId(job.id); setActionError(''); }}><JobThumbnail job={job} worker={worker} /><span className="generation-history-copy"><strong>{job.prompt}</strong><span>{codexJobPresentation(job, worker)?.label || STATUS_LABELS[job.status]}<i>·</i>{new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></span>{job.status === 'ready' && <span className="generation-ready-dot" />}</button>)}{!jobs.length && <p className="generation-no-history">Your creative history starts with the first request.</p>}</div>{jobs.length > 8 && <button type="button" className="generation-show-history" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show recent requests' : `Show all ${jobs.length} requests`}<ChevronDown size={12} /></button>}
      </aside>
    </div>}
  </div>;
}
