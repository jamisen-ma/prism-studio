import { useEffect, useRef, useState } from 'react';
import { command, type Backend, type BackendId, type ChannelSelectionChannel, type Document } from './api';
import type { ColorRangeSettings } from '../shared/color-range.mjs';
import type { RunCommand } from './CanvasTools';
import { capabilityStrings, channelSubmissionCapabilityKey, channelSupport } from './dense-mask';
import { colorRangeCapabilityKey, colorRangeSettingsAllowed, colorRangeSupport } from './color-range';

export type SelectionCombination = 'replace' | 'add' | 'subtract' | 'intersect';
export type ChannelDraft = { channel: ChannelSelectionChannel; mode: SelectionCombination; invert: boolean };
export type ColorRangeLoadDraft = ColorRangeSettings & { mode: SelectionCombination };
export type SelectionProducer = 'channel' | 'color-range';
type Submission = { id: number; producer: SelectionProducer; state: 'pending' | 'unconfirmed'; revision: number };
const definiteRefusals = new Set(['INVALID_ARGUMENT', 'INVALID_ARGUMENTS', 'UNSUPPORTED_COMMAND', 'UNSUPPORTED_OPERATION', 'NO_SELECTION', 'NOT_FOUND', 'INVALID_TARGET', 'LIMIT_EXCEEDED', 'PROTECTED_LAYER', 'ASSET_NOT_FOUND', 'ASSET_INVALID']);
type Props = { document: Document | null; backend: BackendId; capabilities?: Backend; busy: boolean; run: RunCommand; install: (document: Document, backend: BackendId, accept?: () => boolean) => Promise<boolean>; notify: (text: string, error?: boolean) => void };

/** App-owned records are shared by both producers and survive either panel's teardown. */
export function useChannelSelection(props: Props) {
  const latest = useRef(props); latest.current = props;
  const baseKey = `${props.backend}:${props.document?.id}`;
  const keys = { channel: `${baseKey}:${channelSubmissionCapabilityKey(props.capabilities)}`, 'color-range': `${baseKey}:${colorRangeCapabilityKey(props.capabilities, 'load')}` };
  const epochs = useRef({ channel: { key: keys.channel, value: 0 }, 'color-range': { key: keys['color-range'], value: 0 } });
  for (const producer of ['channel', 'color-range'] as const) if (epochs.current[producer].key !== keys[producer]) epochs.current[producer] = { key: keys[producer], value: epochs.current[producer].value + 1 };
  const reviewKey = JSON.stringify([baseKey, props.capabilities?.connected, capabilityStrings(props.capabilities?.commands).includes('get_document')]);
  const reviewEpoch = useRef({ key: reviewKey, value: 0 });
  if (reviewEpoch.current.key !== reviewKey) reviewEpoch.current = { key: reviewKey, value: reviewEpoch.current.value + 1 };
  const records = useRef(new Map<string, Submission>()), serial = useRef(0);
  const [, redraw] = useState(0), [reviewing, setReviewing] = useState(false);
  const reviewAbort = useRef<AbortController | null>(null);
  useEffect(() => { reviewAbort.current?.abort(); reviewAbort.current = null; setReviewing(false); return () => reviewAbort.current?.abort(); }, [reviewKey]);
  const record = props.document ? records.current.get(props.document.id) : undefined;
  const write = (docId: string, submission: Submission, next?: Submission) => {
    if (records.current.get(docId)?.id !== submission.id) return;
    if (next) records.current.set(docId, next); else records.current.delete(docId);
    redraw(value => value + 1);
  };
  const submit = async (producer: SelectionProducer, draft: ChannelDraft | ColorRangeLoadDraft) => {
    const p = latest.current, doc = p.document;
    const support = colorRangeSupport(p.capabilities, doc);
    const supported = producer === 'channel' ? channelSupport(p.capabilities, doc).load : support.load && colorRangeSettingsAllowed(draft as ColorRangeLoadDraft, support) && Boolean(doc && doc.width * doc.height * (draft as ColorRangeLoadDraft).colors.length <= support.maxComparisons);
    if (!doc || p.busy || reviewAbort.current || records.current.has(doc.id) || !supported || ['subtract', 'intersect'].includes(draft.mode) && !doc.selection) return;
    const version = epochs.current[producer].value, submission: Submission = { id: ++serial.current, producer, state: 'pending', revision: doc.revision };
    records.current.set(doc.id, submission); redraw(value => value + 1);
    let dispatched = false, rejected = false;
    const owned = () => epochs.current[producer].value === version && records.current.get(doc.id)?.id === submission.id && latest.current.document?.id === doc.id && latest.current.backend === doc.backend;
    const args = producer === 'color-range' ? { ...draft, colors: [...(draft as ColorRangeLoadDraft).colors] } : { ...draft };
    const result = await p.run(producer === 'channel' ? 'load_channel_selection' : 'load_color_range_selection', args, producer === 'channel' ? 'Loading composite channel selection' : 'Loading Color Range selection', {
      backend: doc.backend, documentId: doc.id, expectedRevision: doc.revision, scope: 'document', isCurrent: owned,
      channelSelection: {
        producer, width: doc.width, height: doc.height,
        onDispatch: () => { if (!owned()) return false; dispatched = true; return true; },
        onFailure: code => { rejected = Boolean(code && definiteRefusals.has(code)); },
      },
    });
    if (result?.document && owned() || !dispatched || rejected) write(doc.id, submission);
    else write(doc.id, submission, { ...submission, state: 'unconfirmed' });
  };
  const review = async () => {
    const p = latest.current, doc = p.document;
    if (!doc || p.busy || reviewAbort.current || p.backend !== 'native' || !p.capabilities?.connected || !capabilityStrings(p.capabilities.commands).includes('get_document') || records.current.get(doc.id)?.state === 'pending') return;
    const abort = new AbortController(); reviewAbort.current = abort;
    const captured = reviewEpoch.current.value, submission = records.current.get(doc.id);
    const owned = () => !abort.signal.aborted && reviewAbort.current === abort && reviewEpoch.current.value === captured && records.current.get(doc.id)?.id === submission?.id && latest.current.document?.id === doc.id && latest.current.backend === doc.backend;
    setReviewing(true);
    try {
      const result = await command<{ document: Document }>('native', 'get_document', { documentId: doc.id }, abort.signal);
      if (!owned()) return;
      if (result.document.id !== doc.id || result.document.backend !== doc.backend || result.document.revision < (latest.current.document?.revision || doc.revision)) throw Error('The document changed while reviewing. Review the current selection again.');
      const installed = await p.install(result.document, doc.backend, owned);
      if (!installed || !owned()) return;
      if (submission) write(doc.id, submission);
      p.notify('Current selection reviewed. Inspect coverage before loading another selection.');
    } catch (error) { if (owned()) p.notify(error instanceof Error ? error.message : 'The current selection could not be reviewed.', true); }
    finally { if (reviewAbort.current === abort) { reviewAbort.current = null; setReviewing(false); } }
  };
  return { load: (draft: ChannelDraft) => submit('channel', draft), loadColorRange: (draft: ColorRangeLoadDraft) => submit('color-range', draft), review, state: record?.state, producer: record?.producer, reviewing };
}
