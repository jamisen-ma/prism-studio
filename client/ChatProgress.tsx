import { useEffect, useRef, useState } from 'react';
import type { ChatTurn } from './chat';

const DEFAULT_SECONDS = { edit: 45, image: 120 };
const kind = (turn: ChatTurn) => turn.generationJobIds?.length ? 'image' : 'edit';
const seconds = (turn: ChatTurn) => (Date.parse(turn.updatedAt) - Date.parse(turn.createdAt)) / 1000;

/** Typical duration for this kind of request, from the median of recent successful turns. */
export function expectedSeconds(turn: ChatTurn, history: ChatTurn[]) {
  const samples = history.filter(item => item.status === 'succeeded' && kind(item) === kind(turn)).map(seconds).filter(value => Number.isFinite(value) && value > 0).slice(-10).sort((a, b) => a - b);
  if (!samples.length) return DEFAULT_SECONDS[kind(turn)];
  const middle = samples.length >> 1;
  return Math.max(5, samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2);
}

/** Linear up to 90% at the expected time, then creeps toward 98% so it never claims to be done early. */
export function progressFraction(elapsed: number, expected: number) {
  const ratio = Math.max(0, elapsed) / expected;
  return ratio < 1 ? 0.9 * ratio : 0.9 + 0.08 * (1 - Math.exp(-(ratio - 1)));
}

function remainingLabel(elapsed: number, expected: number) {
  const left = expected - elapsed;
  if (left <= 3) return 'Almost done…';
  if (left < 60) return `About ${Math.max(5, Math.round(left / 5) * 5)}s left`;
  const minutes = Math.round(left / 60);
  return `About ${minutes} min${minutes === 1 ? '' : 's'} left`;
}

export function ChatProgress({ turn, history }: { turn: ChatTurn; history: ChatTurn[] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  // Never move backwards, e.g. when the estimate grows once an image request appears.
  const highest = useRef(0);
  if (turn.status === 'queued') return <div className="chat-progress" role="status" aria-label="Request progress"><div className="chat-progress-track"><span className="chat-progress-fill queued" /></div><div className="chat-progress-meta"><span>Waiting to start…</span></div></div>;
  const elapsed = (now - Date.parse(turn.createdAt)) / 1000, expected = expectedSeconds(turn, history);
  highest.current = Math.max(highest.current, progressFraction(elapsed, expected));
  const percent = Math.floor(highest.current * 100);
  return <div className="chat-progress" role="progressbar" aria-label="Request progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <div className="chat-progress-track"><span className="chat-progress-fill" style={{ width: `${percent}%` }} /></div>
    <div className="chat-progress-meta"><strong>{percent}%</strong><span>{remainingLabel(elapsed, expected)}</span></div>
  </div>;
}
