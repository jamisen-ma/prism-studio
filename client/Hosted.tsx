import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, LoaderCircle, LogOut } from 'lucide-react';
import { accountUsage, api, authenticate, hostedSession, signOut, startSession, type SignInInfo } from './api';
import './hosted.css';

// Hosted multi-user mode only (PRISM_HOSTED=1). In local mode /api/session
// returns a token without `hosted`, so the gate renders the workspace directly.
type GateState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'signin'; info: SignInInfo };

const Mark = () => <span className="prism-mark"><svg viewBox="0 0 32 32" fill="none"><path d="M16 5 28 27H4L16 5Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /><path d="m16 5 1 22M4 27l16-15" stroke="currentColor" strokeWidth="1.3" opacity=".65" /></svg></span>;

export function HostedGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });
  useEffect(() => {
    startSession().then(() => setState({ kind: 'ready' })).catch((error: { code?: string; signIn?: SignInInfo }) => {
      // Local connection problems are shown by the workspace itself.
      setState(error?.code === 'SIGN_IN_REQUIRED' && error.signIn ? { kind: 'signin', info: error.signIn } : { kind: 'ready' });
    });
  }, []);
  if (state.kind === 'loading') return <div className="hosted-loading" aria-busy="true" />;
  if (state.kind === 'signin') return <SignIn info={state.info} onSignedIn={() => setState({ kind: 'ready' })} />;
  return <>{children}</>;
}

function SignIn({ info, onSignedIn }: { info: SignInInfo; onSignedIn: () => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState(''), [working, setWorking] = useState(false);
  const signup = mode === 'signup';
  const submit = async () => {
    setError(''); setWorking(true);
    try { await authenticate(mode, { email, password, ...(signup && info.signupCodeRequired ? { inviteCode } : {}) }); onSignedIn(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Sign-in failed.'); }
    finally { setWorking(false); }
  };
  return <main className="hosted-signin">
    <form className="hosted-card" aria-label={signup ? 'Create account' : 'Sign in'} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="hosted-brand"><Mark /><span>prism<span className="brand-studio">studio</span></span></div>
      <h1>{signup ? 'Create your account' : 'Sign in'}</h1>
      <p className="hosted-lead">{signup ? 'Your projects and Codex connection stay private to your account.' : 'Welcome back. Your workspace is where you left it.'}</p>
      <label className="field-label">Email<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label className="field-label">Password<input type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={8} maxLength={200} value={password} onChange={event => setPassword(event.target.value)} /></label>
      {signup && info.signupCodeRequired && <label className="field-label">Invite code<input autoComplete="off" required value={inviteCode} onChange={event => setInviteCode(event.target.value)} /></label>}
      {error && <p className="hosted-error" role="alert">{error}</p>}
      <button className="button primary wide" type="submit" disabled={working}>{working && <LoaderCircle size={14} className="spin" />}{signup ? 'Create account' : 'Sign in'}</button>
      {(info.signupOpen || signup) && <p className="hosted-switch">{signup ? 'Already have an account?' : 'New here?'} <button type="button" onClick={() => { setMode(signup ? 'signin' : 'signup'); setError(''); }}>{signup ? 'Sign in' : 'Create an account'}</button></p>}
    </form>
  </main>;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
export function AccountMenu({ disabled }: { disabled?: boolean }) {
  const hosted = hostedSession();
  const [open, setOpen] = useState(false), [usage, setUsage] = useState<{ storageBytes: number; documents: number } | null>(null);
  useEffect(() => { if (open) void accountUsage().then(result => setUsage(result.usage)).catch(() => setUsage(null)); }, [open]);
  if (!hosted) return null;
  return <div className="backend-picker menu-anchor account-menu">
    <button className="backend-button" aria-label="Account" onClick={() => setOpen(!open)} disabled={disabled}><span className="account-initial">{hosted.email.slice(0, 1).toUpperCase()}</span><span className="account-email">{hosted.email}</span><ChevronDown size={13} /></button>
    {open && <><button className="popover-dismiss" aria-label="Close account menu" onClick={() => setOpen(false)} /><div className="popover backend-popover">
      <div className="popover-heading">SIGNED IN AS</div>
      <div className="account-detail"><strong>{hosted.email}</strong>{usage && <small>{usage.documents} of {hosted.limits.maxDocuments} documents · {megabytes(usage.storageBytes)} of {megabytes(hosted.limits.maxStorageBytes)}</small>}</div>
      <div className="menu-rule" />
      <button onClick={() => void signOut().finally(() => window.location.reload())}><LogOut size={15} /><span>Sign out</span></button>
    </div></>}
  </div>;
}

export function CodexDisconnect({ onChange }: { onChange: () => void }) {
  const [working, setWorking] = useState(false);
  return <button type="button" className="codex-disconnect" disabled={working} onClick={() => { if (!window.confirm('Disconnect your Codex account from this server?')) return; setWorking(true); void api('/api/codex/logout', {}).finally(() => { setWorking(false); onChange(); }); }}>Disconnect Codex</button>;
}
