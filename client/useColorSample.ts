import { useCallback, useEffect, useRef } from 'react';
import { command, type BackendId, type Document } from './api';

type Options = {
  document: Document | null;
  backend: BackendId;
  tool: string;
  radius: number;
  brushColor: string;
  textColor: string;
  available: boolean;
  busy: boolean;
  isDocumentCurrent: (document: Document) => boolean;
  setColor: (color: string) => void;
  /** Option/Alt-click samples into the background swatch, like Photoshop. */
  setBackground?: (color: string) => void;
  backgroundColor?: string;
  notify: (message: string, error?: boolean) => void;
};

/** A read may complete after a newer click, manual color, or navigation. */
export function useColorSample(options: Options) {
  const latest = useRef(options); latest.current = options;
  const key = JSON.stringify([
    options.backend, options.document?.backend, options.document?.id,
    options.document?.revision, options.tool, options.radius,
    options.brushColor, options.textColor, options.backgroundColor, options.available, options.busy,
  ]);
  const session = useRef({ key, epoch: 0, request: 0, mounted: true });
  if (session.current.key !== key) {
    session.current.key = key;
    session.current.epoch++;
  }
  useEffect(() => {
    session.current.mounted = true;
    return () => { session.current.mounted = false; session.current.epoch++; };
  }, []);

  return useCallback((x: number, y: number, background = false) => {
    const captured = latest.current, document = captured.document;
    if (!document || document.backend !== captured.backend || captured.tool !== 'eyedropper' || !captured.available || captured.busy || !captured.isDocumentCurrent(document)) return;
    const epoch = session.current.epoch, request = ++session.current.request;
    const ownsRead = () => session.current.mounted && session.current.epoch === epoch && session.current.request === request && latest.current.isDocumentCurrent(document);
    void command<{ hex: string; alpha: number }>(document.backend, 'sample_color', {
      // sample_color has no public expectedRevision argument. Keep its wire
      // contract unchanged; the captured UI revision is checked on completion.
      documentId: document.id, x, y, radius: captured.radius,
    }).then(result => {
      if (!ownsRead()) return;
      const target = background ? latest.current.setBackground : undefined;
      (target || latest.current.setColor)(result.hex);
      latest.current.notify(`Sampled ${result.hex.toUpperCase()} from the composite${target ? ' as the background color' : ''}.`);
    }).catch(error => {
      if (ownsRead()) latest.current.notify(error instanceof Error ? error.message : 'Could not sample the image color.', true);
    });
  }, []);
}
