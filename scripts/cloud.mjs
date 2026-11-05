// Starts the cloud session and records it. `--cloud` needs a real terminal, so it
// runs under `script`. Input stays open through `tail`, because `script` sends
// end-of-input straight away when its input is closed.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkyhopError, tryGit } from './git.mjs';

const POLL_MS = 250;
const BRANCH_POLL_MS = 5000;
const SEND_TIMEOUT_MS = 120_000;

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function terminalCommand(platform, command) {
  const sized = `stty cols 120 rows 40 2>/dev/null; exec ${command.map(shellQuote).join(' ')}`;
  if (platform === 'darwin') return `tail -f /dev/null | script -q /dev/null sh -c ${shellQuote(sized)}`;
  if (platform === 'linux') return `tail -f /dev/null | script -qec ${shellQuote(sized)} /dev/null`;
  return null;
}

export function pasteCommand(dir, promptFile, env = {}) {
  const prefix = Object.entries(env).map(([key, value]) => `${key}=${value} `).join('');
  return `cd ${shellQuote(dir)} && ${prefix}claude --cloud "$(cat ${shellQuote(promptFile)})"`;
}

function stripTerminalCodes(text) {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[=>()][0-9A-Za-z]?/g, '');
}

// The terminal UI moves the cursor instead of printing spaces, so phrases are
// matched with all whitespace removed.
const PROBLEMS = [
  [/trustthisfolder|isthisaprojectyoucreated/, 'trust'],
  [/branch.{0,200}isnotongithub/, 'wrong-branch'],
  [/requiresaninteractiveterminal/, 'no-terminal'],
  [/cloudsessionsneedaclaude\.aisign-in|unabletogetorganizationuuid|sign-in\.runclaudeauthlogin/, 'sign-in'],
  [/disabledbyyourorganization/, 'policy'],
  [/notuploadingthisworkingtree/, 'upload-refused'],
  [/sessioncreationfailed/, 'failed'],
];

export function readLaunchOutput(raw) {
  const text = stripTerminalCodes(raw);
  const squeezed = text.replace(/\s+/g, '').toLowerCase();
  const url = text.match(/https:\/\/claude\.ai\/code\/[A-Za-z0-9_-]+/)?.[0] ?? null;
  const sessionId = text.match(/\b(?:session|cse)_[A-Za-z0-9]{10,}\b/)?.[0] ?? url?.split('/').pop() ?? null;
  const problem = PROBLEMS.find(([pattern]) => pattern.test(squeezed))?.[1] ?? null;
  return { url, sessionId, problem, text };
}

const PROBLEM_MESSAGES = {
  'wrong-branch': ['The session would have started from the wrong commit, because the branch is not on GitHub.', 'Check that the push reached GitHub, then run /skyhop again.'],
  'no-terminal': ['Claude Code would not start the session without a terminal.', 'Run the command below in your own terminal.'],
  'sign-in': ['Cloud sessions need a claude.ai sign-in.', 'Run `claude auth login`, then run /skyhop again.'],
  policy: ['Cloud sessions are turned off for your organization.', 'Ask an organization Owner to turn them on.'],
  'upload-refused': ['Claude Code refused to upload this repository.', 'The output below names the cause.'],
  failed: ['Claude Code could not create the cloud session.', 'Check status.claude.com, then run the command below again.'],
};

function commandExists(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
}

// A direct upload runs through the local client, so stopping the client too soon
// would cut it off. Allows about 1 MB per second on top of the usual wait.
export function launchTimes(uploadBytes = 0) {
  return {
    waitMs: Number(process.env.SKYHOP_LAUNCH_WAIT_MS ?? (uploadBytes > 0 ? 480_000 : 90_000)),
    settleMs: Number(process.env.SKYHOP_LAUNCH_SETTLE_MS ?? 30_000 + uploadBytes / 1000),
  };
}

// Returns once the outcome is known. A trust prompt ends the attempt, because
// answering it belongs to the user.
export async function launchSession({ dir, prompt, env = {}, waitMs, settleMs }) {
  const command = terminalCommand(process.platform, ['claude', '--cloud', prompt]);
  if (!command || !commandExists('script')) return { status: 'needs-terminal', reason: 'no-wrapper' };

  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skyhop-launch-'));
  const logFile = path.join(logDir, 'output.log');
  const out = fs.openSync(logFile, 'w');
  const child = spawn('sh', ['-c', command], {
    cwd: dir,
    env: { ...process.env, ...env, TERM: 'xterm-256color' },
    stdio: ['ignore', out, out],
    detached: true,
  });

  let exited = false;
  child.on('close', () => { exited = true; });
  const stop = () => {
    if (exited) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* it already ended */ }
  };

  const started = Date.now();
  let linkSeenAt = null;
  let outcome;
  try {
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      outcome = readLaunchOutput(fs.readFileSync(logFile, 'utf8'));
      if (outcome.problem) break;
      if (outcome.url && linkSeenAt === null) linkSeenAt = Date.now();
      if (exited) break;
      if (linkSeenAt !== null && Date.now() - linkSeenAt >= settleMs) break;
      if (Date.now() - started >= waitMs) break;
    }
  } finally {
    stop();
    fs.closeSync(out);
    fs.rmSync(logDir, { recursive: true, force: true });
  }

  if (outcome.problem === 'trust') return { status: 'needs-terminal', reason: 'trust' };
  if (outcome.problem === 'no-terminal') return { status: 'needs-terminal', reason: 'no-terminal' };
  if (outcome.problem) {
    const [message, hint] = PROBLEM_MESSAGES[outcome.problem];
    throw new SkyhopError(message, hint);
  }
  if (outcome.url) return { status: 'started', url: outcome.url, sessionId: outcome.sessionId };
  return { status: 'unconfirmed', detail: outcome.text.trim().slice(-500) };
}

// Posts a message into a cloud chat that already exists. Claude Code queues it and
// exits without waiting for the reply, and needs no terminal for this.
export function sendToChat(sessionId, message) {
  const run = spawnSync('claude', ['-p', '--cloud', sessionId, '--output-format', 'json'], {
    input: message, encoding: 'utf8', timeout: SEND_TIMEOUT_MS,
  });
  let result = null;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    result = null;
  }
  if (result?.ok) return { ok: true };
  const error = String(result?.error || run.stderr || run.error?.message || '').trim().slice(0, 300);
  return { ok: false, error: error || 'no answer from claude' };
}

// A cloud machine that was shut down for being idle has to start again first.
export function reopenWaitMs() {
  return Number(process.env.SKYHOP_REOPEN_WAIT_MS ?? 150_000);
}

// Waits for a branch to appear on the remote. True if it did.
export async function waitForBranch(info, name, waitMs) {
  const started = Date.now();
  for (;;) {
    if (tryGit(info.root, ['ls-remote', '--heads', info.remote, `refs/heads/${name}`])) return true;
    if (Date.now() - started >= waitMs) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(BRANCH_POLL_MS, waitMs)));
  }
}

export function requireSignIn() {
  const run = spawnSync('claude', ['auth', 'status'], { encoding: 'utf8' });
  if (run.error) throw new SkyhopError('The claude command was not found.', 'Install Claude Code, then run /skyhop again.');
  let status;
  try {
    status = JSON.parse(run.stdout);
  } catch {
    status = null;
  }
  if (!status?.loggedIn || status.authMethod !== 'claude.ai') {
    throw new SkyhopError('Cloud sessions need a claude.ai sign-in.', 'Run `claude auth login`, then run /skyhop again.');
  }
}

function historyFile(home) {
  return path.join(home, '.skyhop', 'history.json');
}

export function readHistory(home = os.homedir()) {
  try {
    return JSON.parse(fs.readFileSync(historyFile(home), 'utf8'));
  } catch {
    return [];
  }
}

export function recordHandoff(entry, home = os.homedir()) {
  const file = historyFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify([...readHistory(home), entry], null, 2)}\n`);
}
