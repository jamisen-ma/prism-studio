#!/usr/bin/env node
// Fake `codex` CLI for tests/codex-login.test.mjs. Mimics codex-cli 0.159.1:
//   codex login --device-auth   prints the device-code prompt, then "approves"
//   codex login status          "Logged in using ChatGPT" / "Not logged in"
//   codex logout                removes $CODEX_HOME/auth.json
// Behaviour is controlled per CODEX_HOME by an optional `fake-mode.json`:
//   { "mode": "approve" | "never" | "expire" | "old", "delayMs": 300 }
// The account email is `<basename of CODEX_HOME>@example.com`.
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.CODEX_HOME;
if (!home) { console.error('fake codex: CODEX_HOME must be set'); process.exit(3); }
const args = process.argv.slice(2), auth = path.join(home, 'auth.json');
fs.appendFileSync(path.join(home, 'calls.log'), `${JSON.stringify({ args, codexHome: home })}\n`);
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(home, 'fake-mode.json'), 'utf8')); } catch {}
const { mode = 'approve', delayMs = 300 } = config;

const DEVICE_OUTPUT = '\nWelcome to Codex [v\u001b[90m0.159.1\u001b[0m]\n\u001b[90mOpenAI\'s command-line coding agent\u001b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mFAKE-C0DE9\u001b[0m\n\n\u001b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001b[0m\n';

function fakeIdToken(email) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part({ email, 'https://api.openai.com/profile': { email } })}.sig`;
}

if (args[0] === 'login' && args[1] === 'status') {
  if (fs.existsSync(auth)) { console.error('Logged in using ChatGPT'); process.exit(0); }
  console.error('Not logged in'); process.exit(1);
} else if (args[0] === 'logout') {
  fs.rmSync(auth, { force: true }); console.log('Successfully logged out'); process.exit(0);
} else if (args[0] === 'login' && args.includes('--device-auth')) {
  if (mode === 'old') { console.error("error: unexpected argument '--device-auth' found"); process.exit(2); }
  process.stdout.write(DEVICE_OUTPUT);
  if (mode === 'never') setInterval(() => {}, 1000);
  else if (mode === 'expire') setTimeout(() => { console.error('Error: device code expired'); process.exit(1); }, delayMs);
  else setTimeout(() => {
    const email = `${path.basename(home)}@example.com`;
    fs.writeFileSync(auth, JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: fakeIdToken(email), access_token: 'fake-access', refresh_token: 'fake-refresh', account_id: 'acct' } }), { mode: 0o600 });
    console.error('Successfully logged in'); process.exit(0);
  }, delayMs);
} else { console.error(`fake codex: unsupported ${args.join(' ')}`); process.exit(2); }
