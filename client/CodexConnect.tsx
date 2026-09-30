import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, PlugZap, RotateCcw, Unplug } from 'lucide-react';
import { api } from './api';
import './codex-connect.css';

// Routes (hosted server):
//   GET  /api/codex/status     -> { connected, account? }
//   POST /api/codex/login      -> { id, verificationUrl, userCode, expiresAt }
//   GET  /api/codex/login/:id  -> { state: 'pending'|'connected'|'failed'|'expired', message? }
//   POST /api/codex/logout     -> { connected: false }
type CodexStatus = { connected: boolean; account?: string };
type CodexLoginStart = { id: string; verificationUrl: string; userCode: string; expiresAt: string };
type CodexLoginProgress = { state: 'pending' | 'connected' | 'failed' | 'expired'; message?: string };

type View =
  | { kind: 'loading' }
  | { kind: 'disconnected' }
  | { kind: 'starting' }
  | { kind: 'pending'; login: CodexLoginStart }
  | { kind: 'connected'; account?: string }
  | { kind: 'failed'; message: string }
  | { kind: 'expired'; message: string };

const POLL_MS = 2500;
const errorText = (reason: unknown, fallback: string) => reason instanceof Error && reason.message ? reason.message : fallback;

function useCountdown(expiresAt?: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = Math.max(0, Date.parse(expiresAt) - now);
  return { left, label: `${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}` };
}

/** Lets a hosted user connect their own ChatGPT account to Codex via device-code sign-in. */
export function CodexConnect({ onConnected }: { onConnected?: () => void }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [copied, setCopied] = useState(false);
  const [working, setWorking] = useState(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const loadStatus = useCallback(async (notify = false) => {
    try {
      const status = await api<CodexStatus>('/api/codex/status');
      if (!mounted.current) return;
      setView(status.connected ? { kind: 'connected', account: status.account } : { kind: 'disconnected' });
      if (status.connected && notify) onConnectedRef.current?.();
    } catch (reason) {
      if (mounted.current) setView({ kind: 'failed', message: errorText(reason, 'Could not check your Codex connection.') });
    }
  }, []);
  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const pendingId = view.kind === 'pending' ? view.login.id : null;
  useEffect(() => {
    if (!pendingId) return;
    let stopped = false, timer = 0;
    const poll = async () => {
      try {
        const progress = await api<CodexLoginProgress>(`/api/codex/login/${encodeURIComponent(pendingId)}`);
        if (stopped) return;
        if (progress.state === 'connected') { await loadStatus(true); return; }
        if (progress.state === 'expired') { setView({ kind: 'expired', message: progress.message || 'The sign-in code expired.' }); return; }
        if (progress.state === 'failed') { setView({ kind: 'failed', message: progress.message || 'Codex sign-in did not complete.' }); return; }
      } catch { /* transient network error: keep polling until the code expires */ }
      if (!stopped) timer = window.setTimeout(() => { void poll(); }, POLL_MS);
    };
    timer = window.setTimeout(() => { void poll(); }, POLL_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [pendingId, loadStatus]);

  const countdown = useCountdown(view.kind === 'pending' ? view.login.expiresAt : undefined);
  useEffect(() => {
    if (view.kind === 'pending' && countdown && countdown.left === 0) setView({ kind: 'expired', message: 'The sign-in code expired.' });
  }, [view.kind, countdown?.left]);

  const start = async () => {
    setCopied(false); setView({ kind: 'starting' });
    try {
      const login = await api<CodexLoginStart>('/api/codex/login', {});
      if (mounted.current) setView({ kind: 'pending', login });
    } catch (reason) {
      if (mounted.current) setView({ kind: 'failed', message: errorText(reason, 'Could not start Codex sign-in.') });
    }
  };
  const disconnect = async () => {
    setWorking(true);
    try { await api('/api/codex/logout', {}); if (mounted.current) setView({ kind: 'disconnected' }); }
    catch (reason) { if (mounted.current) setView({ kind: 'failed', message: errorText(reason, 'Could not disconnect Codex.') }); }
    finally { if (mounted.current) setWorking(false); }
  };
  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code).then(() => { if (mounted.current) setCopied(true); }).catch(() => {});
  };

  if (view.kind === 'loading') return <section className="cx-connect" aria-busy="true"><p className="cx-status"><LoaderCircle size={13} className="spin" />Checking your Codex connection…</p></section>;

  if (view.kind === 'connected') return <section className="cx-connect cx-connected" aria-label="Codex account">
    <header><span className="cx-dot" aria-hidden="true" /><strong>Codex connected</strong></header>
    <p>{view.account ? <>Signed in as <span className="cx-account">{view.account}</span>.</> : 'Signed in with ChatGPT.'} Chat and image generation use this account's plan.</p>
    <div className="cx-actions"><button type="button" className="button subtle mini" disabled={working} onClick={() => void disconnect()}>{working ? <LoaderCircle size={12} className="spin" /> : <Unplug size={12} />}Disconnect</button></div>
  </section>;

  if (view.kind === 'pending') {
    const { login } = view;
    return <section className="cx-connect" aria-label="Connect your Codex account">
      <header><PlugZap size={14} /><strong>Connect your Codex account</strong></header>
      <ol className="cx-steps">
        <li>Open ChatGPT and sign in to your own account.
          <a className="button secondary mini cx-open" href={login.verificationUrl} target="_blank" rel="noopener noreferrer">Open ChatGPT<ExternalLink size={12} /></a>
        </li>
        <li>Enter this one-time code:
          <div className="cx-code">
            <code aria-label="One-time code">{login.userCode}</code>
            <button type="button" className="icon-button" aria-label={copied ? 'Code copied' : 'Copy code'} title="Copy code" onClick={() => copy(login.userCode)}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          </div>
        </li>
      </ol>
      <p className="cx-status cx-waiting" role="status"><LoaderCircle size={12} className="spin" />Waiting for approval{countdown ? ` · expires in ${countdown.label}` : ''}</p>
      <p className="cx-hint">Only enter this code if you started this sign-in here. Never share it.</p>
      <div className="cx-actions"><button type="button" className="button subtle mini" onClick={() => void start()}><RotateCcw size={12} />Get a new code</button></div>
    </section>;
  }

  const problem = view.kind === 'failed' || view.kind === 'expired' ? view : null;
  return <section className="cx-connect" aria-label="Connect your Codex account">
    <header><PlugZap size={14} /><strong>Connect your Codex account</strong></header>
    <p>Chat and image generation run through Codex on your own ChatGPT plan. You'll sign in on chatgpt.com with a one-time code; Prism stores the sign-in on this server for your account only.</p>
    {problem && <p className={`cx-problem ${problem.kind}`} role="alert">{problem.kind === 'expired' ? 'Code expired. ' : 'Sign-in failed. '}{problem.message}</p>}
    {problem?.kind === 'failed' && <p className="cx-hint">If ChatGPT refuses the code, turn on device code sign-in for Codex in ChatGPT's security settings.</p>}
    <div className="cx-actions">
      <button type="button" className="button primary mini" disabled={view.kind === 'starting'} onClick={() => void start()}>
        {view.kind === 'starting' ? <LoaderCircle size={12} className="spin" /> : problem ? <RotateCcw size={12} /> : <PlugZap size={12} />}
        {problem ? 'Try again' : 'Connect Codex'}
      </button>
    </div>
  </section>;
}
