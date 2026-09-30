import { parentPort } from 'node:worker_threads';
import { scanPsd, decodePsdPlan, knownSrgbProfile } from './psd-import.mjs';

parentPort.once('message', async ({ input, options }) => {
  try {
    const data = Buffer.from(input), plan = scanPsd(data, { assumeSrgb: options.assumeSrgb, knownSrgbProfile: await knownSrgbProfile() });
    if (options.expectedSha256 && options.expectedSha256 !== plan.report.input.sha256) throw Object.assign(new Error('The PSD file changed after inspection.'), { code: 'PSD_HASH_MISMATCH' });
    if (plan.report.issues.length) { parentPort.postMessage({ type: 'result', result: { report: plan.report } }); return; }
    parentPort.postMessage({ type: 'plan', workingBytes: plan.workingBytes });
    await new Promise(resolve => parentPort.once('message', resolve));
    const result = await decodePsdPlan(plan, options);
    // PNG buffers may come from pooled allocations; copy into exclusive exact
    // arrays before transfer. This overlap is included in the staging budget.
    const assets = result.assets.map(({ hash, data }) => ({ hash, data: Uint8Array.from(data) }));
    parentPort.postMessage({ type: 'result', result: { ...result, assets, input } }, [input, ...assets.map(asset => asset.data.buffer)]);
  } catch (cause) {
    const codes = ['INVALID_PSD', 'INVALID_ARGUMENT', 'LIMIT_EXCEEDED', 'PSD_HASH_MISMATCH', 'PSD_IMPORT_FAILED'];
    parentPort.postMessage({ type: 'error', error: { code: codes.includes(cause?.code) ? cause.code : 'PSD_IMPORT_FAILED', message: codes.includes(cause?.code) ? cause.message : 'PSD processing failed before publication.' } });
  }
});
