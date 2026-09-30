import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cache = new Map();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function segmentationPythonPath(dataDir) {
  return path.join(path.resolve(dataDir), 'python-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}
export async function runtimeStatus(dataDir, { refresh = false } = {}) {
  const python = segmentationPythonPath(dataDir);
  const previous = cache.get(python);
  if (!refresh && previous && Date.now() - previous.at < 30_000) return previous.promise;
  const promise = (async () => {
    try {
      await fs.access(python);
      const { stdout } = await run(python, ['-c', 'import json,onnxruntime,numpy,PIL; print(json.dumps({"onnxruntime":onnxruntime.__version__,"numpy":numpy.__version__,"pillow":PIL.__version__}))'], {
        timeout: 15_000, maxBuffer: 4096,
        env: { PYTHONUNBUFFERED: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '2' },
      });
      return { installed: true, engine: 'onnxruntime-cpu', versions: JSON.parse(stdout) };
    } catch { return { installed: false, engine: 'onnxruntime-cpu' }; }
  })();
  cache.set(python, { at: Date.now(), promise });
  return promise;
}

function install(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('error', () => reject(new Error('Unable to start Python. Install Python 3.12 or newer and run setup again.')));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('Local inference runtime installation failed. Check the Python and package download messages above.')));
  });
}

export async function installSegmentationRuntime(dataDir) {
  if ((await runtimeStatus(dataDir, { refresh: true })).installed) return { reused: true };
  await fs.mkdir(path.resolve(dataDir), { recursive: true, mode: 0o700 });
  await install(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', path.join(path.resolve(dataDir), 'python-runtime')]);
  await install(segmentationPythonPath(dataDir), ['-m', 'pip', 'install', '--only-binary=:all:', '-r', path.join(root, 'assets/models/requirements.txt')]);
  if (!(await runtimeStatus(dataDir, { refresh: true })).installed) throw new Error('The local runtime could not be verified after installation.');
  return { reused: false };
}
