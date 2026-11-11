// Starts the cloud session and records it. `--cloud` needs a real terminal. On macOS
// and Linux it runs under `script`, with input kept open through `tail`, because
// `script` sends end-of-input straight away when its input is closed. Windows has no
// `script`, so there it runs in a hidden console window of its own, whose output
// can't be read: the chat reports its ID through GitHub instead (launchHidden).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkyhopError, tryGit } from './git.mjs';
import { privateFile } from './log.mjs';
import { readPulseMessage } from './sync.mjs';

const POLL_MS = 250;
const branchPollMs = () => Number(process.env.SKYHOP_BRANCH_POLL_MS ?? 5000);
const SEND_TIMEOUT_MS = 120_000;

// Runs the claude command. npm installs it on Windows as claude.cmd, which only
// cmd.exe can start, so a failed start there is tried again through the shell, with
// every argument quoted. Messages always go through stdin, never the command line.
export function runClaude(args, options = {}) {
  const run = spawnSync('claude', args, options);
  if (process.platform !== 'win32' || !run.error) return run;
  return spawnSync(['claude', ...args].map(windowsArg).join(' '), { ...options, shell: true });
}

// One argument for a Windows command line, as programs split it back up.
export function windowsArg(value) {
  const text = String(value);
  if (text && !/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

// Windows starts the cloud session itself only for a full resume through GitHub,
// because only that chat can tell it which session it is.
export function hiddenLaunch(platform = process.platform) {
  return platform === 'win32' || process.env.SKYHOP_LAUNCH === 'hidden';
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function terminalCommand(platform, command) {
  const sized = `stty cols 120 rows 40 2>/dev/null; exec ${command.map(shellQuote).join(' ')}`;
  if (platform === 'darwin') return `tail -f /dev/null | script -q /dev/null sh -c ${shellQuote(sized)}`;
  if (platform === 'linux') return `tail -f /dev/null | script -qec ${shellQuote(sized)} /dev/null`;
  return null;
}

export function pasteCommand(dir, promptFile, env = {}, platform = process.platform) {
  // A Windows command line can't carry a long first message, so there is none to paste.
  if (platform === 'win32') return null;
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
  const run = runClaude(['-p', '--cloud', sessionId, '--output-format', 'json'], {
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

// The newest pulse commit on GitHub: what it says, and the chat that pushed it.
export function readPulse(info, name) {
  const local = 'refs/skyhop/pulse-read';
  if (tryGit(info.root, ['fetch', '-q', '--no-tags', info.remote, `+refs/heads/${name}:${local}`]) === null) return null;
  const message = tryGit(info.root, ['log', '-1', '--format=%B', local]);
  tryGit(info.root, ['update-ref', '-d', local]);
  return message ? readPulseMessage(message) : null;
}

// Waits for a pulse commit that `accept` takes. Returns it, or null after waitMs.
export async function waitForPulse(info, name, waitMs, accept = () => true) {
  const started = Date.now();
  let seen = null;
  for (;;) {
    const head = tryGit(info.root, ['ls-remote', '--heads', info.remote, `refs/heads/${name}`])?.split('\t')[0] || null;
    if (head && head !== seen) {
      seen = head;
      const pulse = readPulse(info, name);
      if (pulse && accept(pulse)) return pulse;
    }
    if (Date.now() - started >= waitMs) return null;
    await new Promise(resolve => setTimeout(resolve, Math.min(branchPollMs(), waitMs)));
  }
}

const hiddenWaitMs = () => Number(process.env.SKYHOP_HIDDEN_WAIT_MS ?? 300_000);

// Windows: starts `claude --cloud` in a hidden console window, which gives it the
// terminal it needs, and waits for the new chat to report its ID on the pulse branch.
// The prompt must be one short line, which a Windows command line carries safely.
// Starts `claude --cloud <prompt>` in a hidden console window, and returns its
// process ID, or { error }.
export function startHidden(dir, prompt) {
  // SKYHOP_LAUNCH=hidden on macOS or Linux runs this same path for testing, with
  // `script` standing in for the hidden window.
  if (process.platform !== 'win32') {
    const command = terminalCommand(process.platform, ['claude', '--cloud', prompt]);
    if (!command) return { error: 'no terminal wrapper on this system' };
    const child = spawn('sh', ['-c', command], { cwd: dir, detached: true, stdio: 'ignore', env: { ...process.env, TERM: 'xterm-256color' } });
    child.unref();
    return { pid: child.pid };
  }
  const script = "$p = Start-Process -FilePath 'claude' -ArgumentList $env:SKYHOP_CLAUDE_ARGS -WorkingDirectory $env:SKYHOP_LAUNCH_DIR -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)";
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    env: { ...process.env, SKYHOP_CLAUDE_ARGS: ['--cloud', prompt].map(windowsArg).join(' '), SKYHOP_LAUNCH_DIR: dir },
    timeout: 60_000,
  });
  const pid = Number(String(run.stdout ?? '').trim());
  if (Number.isInteger(pid) && pid > 0) return { pid };
  return { error: String(run.stderr || run.error?.message || 'PowerShell could not start claude').trim().slice(-500) };
}

// Ends that window's process and everything it started.
export function stopHidden(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* it already ended */ }
    return;
  }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

export async function launchHidden({ dir, prompt, info, pulse, waitMs = hiddenWaitMs(), start = startHidden, stop = stopHidden }) {
  const { pid, error } = start(dir, prompt);
  if (!pid) return { status: 'unconfirmed', detail: error };
  try {
    const report = await waitForPulse(info, pulse, waitMs, found => Boolean(found.chatId));
    if (!report) return { status: 'unconfirmed', detail: `The cloud chat did not report back within ${Math.round(waitMs / 60_000)} minutes.` };
    return { status: 'started', sessionId: report.chatId, url: `https://claude.ai/code/${report.chatId}` };
  } finally {
    // The chat runs in the cloud now, so the local window is no longer needed.
    stop(pid);
  }
}

// Waits for a branch to appear on the remote. True if it did.
export async function waitForBranch(info, name, waitMs) {
  const started = Date.now();
  for (;;) {
    if (tryGit(info.root, ['ls-remote', '--heads', info.remote, `refs/heads/${name}`])) return true;
    if (Date.now() - started >= waitMs) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(branchPollMs(), waitMs)));
  }
}

export function requireSignIn() {
  const run = runClaude(['auth', 'status'], { encoding: 'utf8' });
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
  fs.writeFileSync(file, `${JSON.stringify([...readHistory(home), entry], null, 2)}\n`, { mode: 0o600 });
  privateFile(file);
}
