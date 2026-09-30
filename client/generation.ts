import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';

export type GenerationProvider = 'codex' | 'openai';
export type GenerationQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type GenerationSize = 'auto' | '1024x1024' | '1536x1024' | '1024x1536';
export type GenerationBackground = 'auto' | 'opaque' | 'transparent';
export type GenerationModel = { id: string; label: string; qualities?: GenerationQuality[]; supportedQualities?: GenerationQuality[] };
export type CodexWorkerStatus = { enabled: boolean; available: boolean; state: 'checking' | 'ready' | 'working' | 'unavailable'; message?: string; activeJobId?: string };
export type GenerationAutomation = { state: 'queued' | 'generating' | 'returning' | 'interrupted' | 'failed'; message?: string };
export type GenerationStatus = { codexWorker?: CodexWorkerStatus; configurationChecked?: boolean; defaultProvider?: GenerationProvider; providers?: { id: GenerationProvider; label: string; available: boolean; requiresApiKey: boolean; requiresConversation?: boolean }[]; configured: boolean; models: GenerationModel[]; defaultModel: string; defaultQuality: GenerationQuality; limits: { maxQueued: number; maxActive: number }; jobs?: GenerationJob[] };
export type GenerationJob = { automation?: GenerationAutomation; id: string; provider?: GenerationProvider; mode: 'generate' | 'edit'; prompt: string; model: string; quality: GenerationQuality; size: GenerationSize; background: GenerationBackground; scope: 'canvas' | 'selection'; status: 'awaiting_image' | 'queued' | 'running' | 'ready' | 'succeeded' | 'failed' | 'cancelled'; createdAt: string; updatedAt: string; error?: { code: string; message: string }; documentId?: string; layerId?: string; revision?: number; outputAvailable: boolean; usage?: unknown };
export type GenerationRequest = { provider: GenerationProvider; fit?: 'contain' | 'cover'; mode: 'generate' | 'edit'; prompt: string; model?: string; quality?: GenerationQuality; size: GenerationSize; background: GenerationBackground; scope: 'canvas' | 'selection'; documentId?: string; expectedRevision?: number; name?: string };
export type GenerationPreview = { data: string; mimeType: string; width: number; height: number };
const active = (job: GenerationJob) => job.status === 'queued' || job.status === 'running' || job.status === 'awaiting_image' && (job.automation?.state === 'generating' || job.automation?.state === 'returning');
export function codexJobPresentation(job: GenerationJob, worker?: CodexWorkerStatus) {
  if (job.status !== 'awaiting_image' || !(job.provider === 'codex' || job.model === 'codex-imagegen')) return null;
  const state = job.automation?.state;
  if (state === 'interrupted' || state === 'failed') return { label: state === 'interrupted' ? 'Codex request interrupted' : 'Codex request failed', message: `${job.automation?.message || job.error?.message || 'The local worker could not finish this request.'} No automatic retry was made. Cancel it or use this prompt to submit a new request.`, spinning: false, manualHandoff: false, stopped: true };
  if (state === 'generating' || state === 'returning') return { label: state === 'generating' ? 'Codex is creating your image' : 'Returning image to workspace', message: job.automation?.message || (state === 'generating' ? 'The local worker is using Codex. You can keep editing or close this panel.' : 'The generated image is being saved and added to the workspace.'), spinning: true, manualHandoff: false, stopped: false };
  if (!state) return { label: 'Waiting for image from Codex', message: 'This request was saved for manual handoff. Copy its instruction below and send it in your Codex conversation.', spinning: false, manualHandoff: true, stopped: false };
  if (!worker?.enabled || worker.state === 'unavailable') return { label: 'Waiting for local Codex', message: worker?.message || 'This request is reserved for the automatic worker, which is unavailable. It will wait in the queue; cancel it to stop waiting.', spinning: false, manualHandoff: false, stopped: false };
  return { label: worker.state === 'checking' ? 'Checking local Codex' : 'Queued for local Codex', message: worker.state === 'checking' ? 'Checking the signed-in local Codex worker. Your saved request has not started.' : 'The local worker checks the queue every 5 seconds and starts the next request when it is free. No copying is needed.', spinning: false, manualHandoff: false, stopped: false };
}

export function useGenerationJobs({ open, onApplied }: { open: boolean; onApplied: (job: GenerationJob) => Promise<void> }) {
  const [status, setStatus] = useState<GenerationStatus | null>(null);
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiConfiguration, setApiConfiguration] = useState<GenerationStatus | null>(null);
  const [checkingApiConfiguration, setCheckingApiConfiguration] = useState(false);
  const apiCheckVersion = useRef(0);
  const [error, setError] = useState('');
  const [serviceError, setServiceError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pendingAction, setPendingAction] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const jobsRef = useRef(jobs); jobsRef.current = jobs;
  const appliedCallback = useRef(onApplied); appliedCallback.current = onApplied;
  const known = useRef(new Map<string, GenerationJob['status']>());
  const mounted = useRef(true);
  const retryRequest = useRef<{ serialized: string; id: string } | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const acceptJobs = useCallback((next: GenerationJob[], notify = true) => {
    if (!mounted.current) return;
    const ordered = [...next].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const job of ordered) {
      const previous = known.current.get(job.id);
      known.current.set(job.id, job.status);
      if (notify && previous && previous !== 'succeeded' && job.status === 'succeeded') void appliedCallback.current(job).catch(() => { /* The document can still be opened explicitly. */ });
    }
    jobsRef.current = ordered; setJobs(ordered);
  }, []);

  const acceptJob = useCallback((job: GenerationJob) => {
    if (!known.current.has(job.id)) known.current.set(job.id, 'queued');
    acceptJobs([job, ...jobsRef.current.filter((existing) => existing.id !== job.id)]);
  }, [acceptJobs]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [configuration, result] = await Promise.all([api<GenerationStatus>('/api/ai/status'), api<{ jobs: GenerationJob[] }>('/api/ai/jobs')]);
        if (cancelled) return;
        setStatus(configuration); acceptJobs(result.jobs); setServiceError(''); setLoading(false);
        timer = setTimeout(poll, result.jobs.some(job => active(job) || job.status === 'awaiting_image') ? 1100 : open ? 3000 : 12000);
      } catch (reason) {
        if (cancelled) return;
        setServiceError(reason instanceof Error ? reason.message : 'Generation service is unavailable.'); setLoading(false);
        timer = setTimeout(poll, 7000);
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, refreshNonce, acceptJobs]);

  const checkApiConfiguration = useCallback(async () => {
    const version = ++apiCheckVersion.current;
    setCheckingApiConfiguration(true); setError('');
    try {
      const next = await api<GenerationStatus>('/api/ai/status?provider=openai');
      if (mounted.current && version === apiCheckVersion.current) setApiConfiguration(next);
    } catch (reason) {
      if (mounted.current && version === apiCheckVersion.current) { setApiConfiguration(null); setError(reason instanceof Error ? reason.message : 'Could not check optional API configuration.'); }
    } finally { if (mounted.current && version === apiCheckVersion.current) setCheckingApiConfiguration(false); }
  }, []);

  const submit = useCallback(async (request: GenerationRequest) => {
    if (submittingRef.current) return null;
    submittingRef.current = true; setSubmitting(true); setError('');
    const serialized = JSON.stringify(request);
    if (retryRequest.current?.serialized !== serialized) retryRequest.current = { serialized, id: crypto.randomUUID() };
    try {
      const result = await api<{ job: GenerationJob }>('/api/ai/jobs', { ...request, requestId: retryRequest.current.id });
      acceptJob(result.job); retryRequest.current = null; setRefreshNonce((value) => value + 1);
      return result.job;
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not submit the generation request.'); return null; }
    finally { submittingRef.current = false; if (mounted.current) setSubmitting(false); }
  }, [acceptJob]);

  const cancel = useCallback(async (id: string) => {
    setPendingAction(id); setError('');
    try { const result = await api<{ job: GenerationJob }>(`/api/ai/jobs/${encodeURIComponent(id)}/cancel`, {}); acceptJob(result.job); return result.job; }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not cancel this request.'); return null; }
    finally { if (mounted.current) setPendingAction(''); }
  }, [acceptJob]);

  const apply = useCallback(async (id: string, expectedRevision?: number) => {
    setPendingAction(id); setError('');
    try { const result = await api<{ job: GenerationJob }>(`/api/ai/jobs/${encodeURIComponent(id)}/apply`, expectedRevision === undefined ? {} : { expectedRevision }); acceptJob(result.job); return result.job; }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not apply this result.'); return null; }
    finally { if (mounted.current) setPendingAction(''); }
  }, [acceptJob]);

  const resolvedStatus = status && apiConfiguration ? { ...status, configured: apiConfiguration.configured, configurationChecked: true, providers: status.providers?.map(provider => provider.id === 'openai' ? { ...provider, available: apiConfiguration.configured } : provider) } : status;
  return { status: resolvedStatus, checkApiConfiguration, checkingApiConfiguration, jobs, loading, error: error || serviceError, submitting, pendingAction, submit, cancel, apply, refresh: () => setRefreshNonce((value) => value + 1), activeCount: jobs.filter(active).length, waitingCount: jobs.filter(job => job.status === 'awaiting_image' && !active(job) && job.automation?.state !== 'interrupted' && job.automation?.state !== 'failed').length, readyCount: jobs.filter((job) => job.status === 'ready').length };
}

export type GenerationController = ReturnType<typeof useGenerationJobs>;
