// Brings a full-resume session home from the cloud as the same session. It runs
// in three places:
//   - pullAll, when Claude Code starts in the repository. The cloud conversation is
//     added to the original session, so /resume shows it. The cloud chat stays open,
//     because starting Claude Code there doesn't mean the user is back.
//   - claim, on the session's next message on this Mac. Typing here means the user
//     is back, so the cloud chat closes and the code comes home.
//   - bringBack, for /skyhop-back, which does both at once from another window.
// A window reads a session file only when it opens it, and history added after that
// stays hidden behind whatever the window writes next. So nothing is added to a
// session that's open, and a window that opened it too early is stopped before it
// writes anything.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactPaths } from './brief.mjs';
import { readHistory } from './cloud.mjs';
import { findTranscript } from './fullresume.mjs';
import { createSnapshot, git, repoInfo, skyhopBranch, SkyhopError, tryGit } from './git.mjs';
import { isSensitivePath } from './secrets.mjs';
import { pulseRef, readChunks } from './sync.mjs';

const CHAT_REF = 'refs/skyhop/back-chat';
const CODE_REF = 'refs/skyhop/back-code';
// A hook runs a moment after its window opens a session, so loads are dated this
// much earlier to be safe. Tests set it to 0.
const LOAD_MARGIN_MS = Number(process.env.SKYHOP_LOAD_MARGIN_MS ?? 1000);
const RECENT_HOME_MS = 60 * 60 * 1000;

function sessionsDir(home) {
  return path.join(home, '.skyhop', 'sessions');
}

function recordFile(sessionId, home) {
  return path.join(sessionsDir(home), `${sessionId}.json`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveHandoffRecord(record, home = os.homedir()) {
  fs.mkdirSync(sessionsDir(home), { recursive: true });
  fs.writeFileSync(recordFile(record.sessionId, home), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function readRecord(sessionId, home = os.homedir()) {
  return readJson(recordFile(sessionId, home));
}

function allRecords(home) {
  const dir = sessionsDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => readJson(path.join(dir, name)))
    .filter(record => record?.sessionId && record.at)
    .sort((a, b) => a.at.localeCompare(b.at));
}

// Handoffs that haven't come home yet, oldest first. With no root, from any repository.
export function waitingRecords(root, home = os.homedir()) {
  return allRecords(home).filter(record => !record.broughtBackAt && (root === undefined || record.repoRoot === root));
}

// Each window is told apart by its Claude Code process ID.
function loadFile(sessionId, pid, home) {
  return path.join(sessionsDir(home), `${sessionId}.${pid}.loaded`);
}

export function noteLoaded(sessionId, pid, home = os.homedir(), now = Date.now()) {
  fs.writeFileSync(loadFile(sessionId, pid, home), String(now - LOAD_MARGIN_MS));
}

// A window with no note opened the session before Skyhop started watching it.
function loadedAt(sessionId, pid, home) {
  try {
    return Number(fs.readFileSync(loadFile(sessionId, pid, home), 'utf8')) || 0;
  } catch {
    return 0;
  }
}

function markHome(record, home, extra = {}) {
  saveHandoffRecord({ ...record, ...extra, broughtBackAt: new Date().toISOString() }, home);
  for (const name of fs.readdirSync(sessionsDir(home))) {
    if (name.startsWith(`${record.sessionId}.`) && name.endsWith('.loaded')) fs.rmSync(path.join(sessionsDir(home), name), { force: true });
  }
}

function when(iso) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function label(record) {
  return `the session you handed off on ${when(record.at)}`;
}

function listHeads(info) {
  const out = info.remote ? tryGit(info.root, ['ls-remote', '--heads', info.remote]) : null;
  if (out === null) return null;
  return new Map(out.split('\n').filter(Boolean).map(line => {
    const [sha, ref] = line.split('\t');
    return [ref.replace(/^refs\/heads\//, ''), sha];
  }));
}

// The handoff's branches on GitHub, from one request. Null when it can't be reached.
// While the cloud works on a reply, its pulse branch is a commit ahead of the chat.
function cloudBranches(info, record) {
  const heads = listHeads(info);
  if (!heads) return null;
  const { chatRef, codeRef, runBranch } = record.sync;
  const pulse = heads.get(pulseRef(chatRef)) ?? null;
  const chat = heads.get(chatRef) ?? null;
  return {
    chat,
    code: heads.get(codeRef) ?? null,
    open: heads.has(runBranch),
    pulse,
    busy: Boolean(pulse) && pulse !== chat,
  };
}

// A reply that never finishes, because its VM stopped, would block coming home
// for good. So the user is told once per reply, and asking again goes ahead.
function stillBusy(branches, record) {
  return branches.busy && record.busyWarned !== branches.pulse;
}

// Counts messages a person typed. The format is internal, so anything unreadable
// counts as typed, which keeps the safer path.
function typedTurns(bytes) {
  let turns = 0;
  for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      turns += 1;
      continue;
    }
    if (record.type !== 'user' || record.isMeta || record.toolUseResult) continue;
    const content = record.message?.content;
    const typed = typeof content === 'string' || (Array.isArray(content) && content.some(block => block.type === 'text'));
    if (typed) turns += 1;
  }
  return turns;
}

export function localTurnsAfter(file, from) {
  return typedTurns(fs.readFileSync(file).subarray(from));
}

// Where this Mac's copy of the session stops: the handoff point, or the end of
// the cloud conversation that was last added to it.
function localEnd(record) {
  return record.localTo ?? record.baseBytes;
}

function assertValidLines(bytes) {
  const lines = bytes.toString('utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      throw new SkyhopError('The saved conversation is damaged, so nothing was changed.', 'Your session on this Mac is untouched.');
    }
  }
  return lines.length;
}

function readSaved(info, sha, record) {
  try {
    return readChunks(info.root, sha, record.sync.key, record.baseBytes);
  } catch (error) {
    throw new SkyhopError(`The saved conversation could not be read (${error.message}), so nothing was changed.`, 'Your session on this Mac is untouched.');
  }
}

// Downloads the saved conversation and code. `all` is everything since the
// handoff, and `fresh` is the part this Mac doesn't have yet.
function download(info, record, branches) {
  const wanted = [[record.sync.chatRef, CHAT_REF, branches.chat], [record.sync.codeRef, CODE_REF, branches.code]]
    .filter(([, , sha]) => sha);
  if (wanted.length > 0) {
    const refspecs = wanted.map(([remote, local]) => `+refs/heads/${remote}:${local}`);
    if (tryGit(info.root, ['fetch', '-q', '--no-tags', info.remote, ...refspecs]) === null) {
      throw new SkyhopError(`Could not download the saved session from ${info.remote}, so nothing was changed.`, 'Check your connection, then try again.');
    }
  }
  const chatSha = branches.chat ? git(info.root, ['rev-parse', CHAT_REF]) : null;
  const codeSha = branches.code ? git(info.root, ['rev-parse', CODE_REF]) : null;
  const saved = chatSha ? readSaved(info, chatSha, record) : { bytes: Buffer.alloc(0), to: record.baseBytes, count: 0 };
  const lines = assertValidLines(saved.bytes);
  const known = (record.pulledTo ?? record.baseBytes) - record.baseBytes;
  return { chatSha, codeSha, all: saved.bytes, fresh: saved.bytes.subarray(known), to: saved.to, count: saved.count, lines };
}

function dropDownloads(info) {
  tryGit(info.root, ['update-ref', '-d', CHAT_REF]);
  tryGit(info.root, ['update-ref', '-d', CODE_REF]);
}

function isSessionRunning(sessionId) {
  const run = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8' });
  try {
    return JSON.parse(run.stdout).some(agent => agent.sessionId === sessionId);
  } catch {
    return false;
  }
}

function backupSession(file, sessionId, home) {
  const dir = path.join(home, '.skyhop', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `${sessionId}.jsonl`);
  fs.copyFileSync(file, backup);
  return backup;
}

// A new session file holding this Mac's copy up to `cut`, plus the cloud messages.
// The session ID appears on every line, so it's swapped as plain text.
export function forkSession(file, sessionId, cut, delta) {
  const newId = crypto.randomUUID();
  const base = fs.readFileSync(file).subarray(0, cut);
  const text = Buffer.concat([base, delta]).toString('latin1').replaceAll(sessionId, newId);
  const target = path.join(path.dirname(file), `${newId}.jsonl`);
  fs.writeFileSync(target, text, 'latin1');
  return { newId, target };
}

// Deleting the start branch closes the cloud chat: the relay checks for it before
// and after every reply, and stops passing messages on once it's gone.
function closeCloud(info, record, branches) {
  const names = [...(branches.open ? [record.sync.runBranch] : []), ...(branches.pulse ? [pulseRef(record.sync.chatRef)] : [])];
  if (names.length === 0 || tryGit(info.root, ['push', '-q', info.remote, '--delete', ...names]) !== null) return true;
  const after = listHeads(info);
  return Boolean(after) && !after.has(record.sync.runBranch);
}

// The saved chat and code are removed once they're home. A branch that moved since
// the download is left for /skyhop-status to show, rather than lose what it holds.
function tidyRemote(info, record, got) {
  const heads = listHeads(info);
  if (!heads) return;
  const names = [[record.sync.chatRef, got.chatSha], [record.sync.codeRef, got.codeSha]]
    .filter(([name, sha]) => sha && heads.get(name) === sha)
    .map(([name]) => name);
  if (names.length > 0) tryGit(info.root, ['push', '-q', info.remote, '--delete', ...names]);
}

function localFilesUnchanged(info, record) {
  if (info.head !== record.head) return false;
  const snapshot = createSnapshot(info, { isExcluded: isSensitivePath, message: 'Skyhop check' });
  if (snapshot.tree !== record.snapshotTree) return false;
  return !snapshot.excluded.some(file => tryGit(info.root, ['ls-files', '--error-unmatch', '--', file]) !== null);
}

// Moves the working tree from the handoff's files to the cloud's through a throwaway
// index, so HEAD and the real index stay as they are. Git refuses if a file it would
// touch differs from the handoff, and then the code goes on a branch instead.
function applyTree(info, from, to) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyhop-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    git(info.root, ['read-tree', from], { env });
    tryGit(info.root, ['update-index', '-q', '--refresh'], { env });
    return tryGit(info.root, ['read-tree', '-m', '-u', from, to], { env }) !== null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The cloud's changes land in the user's files, uncommitted, when that can't
// overwrite anything: the files must still match the handoff exactly. Otherwise
// they wait on a new branch.
function bringCode(info, record, sha, dryRun) {
  if (!sha) return { kind: 'none' };
  const tree = git(info.root, ['rev-parse', `${sha}^{tree}`]);
  if (tree === record.snapshotTree) return { kind: 'none' };
  const here = info.branch ?? 'your detached HEAD';
  const unchanged = localFilesUnchanged(info, record);
  if (dryRun) return unchanged ? { kind: 'apply', branch: here } : { kind: 'branch', branch: 'a new skyhop/back-... branch' };
  if (unchanged && applyTree(info, record.snapshotTree, tree)) return { kind: 'apply', branch: here };
  const branch = skyhopBranch('back');
  git(info.root, ['branch', branch, sha]);
  return { kind: 'branch', branch };
}

function describeCode(code) {
  if (code.kind === 'apply') return `The cloud's code changes are in your files on ${code.branch}, not committed.`;
  if (code.kind === 'branch') return `The cloud's code is on ${code.branch}. Your local files changed since the handoff, so Skyhop left them alone. Run: git switch ${code.branch}`;
  return 'The cloud session made no code changes.';
}

// When Claude Code starts in a repository. Returns lines to show the user.
export function pullAll({ cwd, home = os.homedir() }) {
  if (waitingRecords(undefined, home).length === 0) return [];
  let info;
  try {
    info = repoInfo(cwd);
  } catch {
    return [];
  }
  return waitingRecords(info.root, home).filter(record => record.sync).map(record => {
    try {
      return pullOne(info, record, home);
    } catch (error) {
      return `Skyhop could not update ${label(record)} from the cloud: ${error.message}`;
    } finally {
      dropDownloads(info);
    }
  });
}

function pullOne(info, record, home) {
  const name = label(record);
  const branches = cloudBranches(info, record);
  if (!branches) return `Skyhop: ${name} is in the cloud, but ${info.remote} couldn't be reached to update it here.`;
  const working = branches.busy ? " It's working on a reply there." : '';
  const waiting = `Skyhop: ${name} is in the cloud.${working} Pick it in /resume to bring it home.`;
  if (!branches.chat || branches.chat === record.pulledChat) return waiting;

  const file = findTranscript(record.sessionId).path;
  if (isSessionRunning(record.sessionId)) {
    return `Skyhop: ${name} has new messages in the cloud, but it's open in another Claude Code window. Quit that window, then open claude here again.`;
  }
  if (localTurnsAfter(file, localEnd(record)) > 0) {
    return `Skyhop: ${name} has new messages in the cloud, and you also typed in it here after the handoff. Run /skyhop-back to get the cloud part as a separate session.`;
  }
  const got = download(info, record, branches);
  if (got.fresh.length === 0) return waiting;

  const backup = record.backup ?? backupSession(file, record.sessionId, home);
  fs.appendFileSync(file, got.fresh);
  saveHandoffRecord({
    ...record, backup, pulledTo: got.to, pulledChat: got.chatSha, localTo: fs.statSync(file).size, lastPullAt: Date.now(),
  }, home);
  return `Skyhop: ${name} now has its cloud conversation here (${typedTurns(got.fresh)} new message(s)).${working} Pick it in /resume. It comes home for good when you send a message there, and the cloud chat closes then.`;
}

// When a window opens a session. Returns a line to show the user, or null.
export function onResume({ sessionId, pid, home = os.homedir() }) {
  const record = readRecord(sessionId, home);
  if (!record || record.broughtBackAt || !record.sync) return null;
  noteLoaded(sessionId, pid, home);
  let info;
  try {
    info = repoInfo(record.repoRoot);
  } catch {
    return null;
  }
  const branches = cloudBranches(info, record);
  if (branches?.chat && branches.chat !== record.pulledChat) {
    return 'Skyhop: this session has new messages in the cloud that are not shown here. Quit (type /exit), open claude in this folder, and pick it in /resume.';
  }
  return 'Skyhop: this session was in the cloud. It comes home when you send a message, and the cloud chat closes then.';
}

function allow(message, context) {
  return {
    ...(message ? { systemMessage: message } : {}),
    ...(context ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } } : {}),
  };
}

function block(reason) {
  return { decision: 'block', reason };
}

// On a message in a session that's waiting in the cloud. Returns the hook output,
// or null to let the message through untouched.
export function claim({ sessionId, pid, home = os.homedir() }) {
  const record = readRecord(sessionId, home);
  if (!record || record.broughtBackAt || !record.sync) return null;
  let info;
  try {
    info = repoInfo(record.repoRoot);
  } catch {
    return null;
  }
  try {
    return claimHere(info, record, pid, home);
  } catch (error) {
    return allow(`Skyhop could not finish bringing this session home: ${error.message}`);
  } finally {
    dropDownloads(info);
  }
}

function claimHere(info, record, pid, home) {
  const { sessionId } = record;
  const branches = cloudBranches(info, record);
  if (!branches) {
    return allow(`Skyhop couldn't reach ${info.remote}, so this session's cloud chat is still open. Avoid using it: Skyhop closes it on your next message here.`);
  }
  if (stillBusy(branches, record)) {
    saveHandoffRecord({ ...record, busyWarned: branches.pulse }, home);
    return block('This session is still working on a reply in the cloud. Wait for it to finish, then quit and open claude here again to load it. To come home now without that reply, send your message again.');
  }

  const file = findTranscript(sessionId).path;
  const typed = localTurnsAfter(file, localEnd(record));
  const hasNew = Boolean(branches.chat) && branches.chat !== record.pulledChat;
  if (hasNew && typed === 0) {
    return block('This session has new messages from the cloud that are not loaded in this window. Quit (type /exit), open claude in this folder again, and pick it in /resume.');
  }
  if (!hasNew && typed === 0 && record.lastPullAt && loadedAt(sessionId, pid, home) < record.lastPullAt) {
    return block('This window opened the session before its cloud conversation arrived, so that part is not shown here. Quit (type /exit) and pick it in /resume again.');
  }

  const got = download(info, record, branches);
  if (!closeCloud(info, record, branches)) {
    return allow(`Skyhop couldn't close this session's cloud chat on ${info.remote}. Avoid using it: Skyhop tries again on your next message here.`);
  }
  // The user typed here while the cloud kept going, so the cloud part becomes its own session.
  const forked = hasNew ? forkSession(file, sessionId, localEnd(record), got.fresh) : null;
  markHome(record, home, forked ? { resumeId: forked.newId } : {});
  const code = bringCode(info, record, got.codeSha, false);
  tidyRemote(info, record, got);

  const parts = [
    'Skyhop: this session is back from the cloud, and its cloud chat is closed.',
    forked ? `The cloud had new messages too, so they are in a separate session: claude --resume ${forked.newId}` : null,
    code.kind === 'none' ? null : describeCode(code),
  ].filter(Boolean);
  const context = code.kind === 'none' ? null : `Skyhop: this session just came back from a Claude Code cloud session. ${describeCode(code)}`;
  return allow(parts.join(' '), context);
}

function briefHandoffHelp(info, home) {
  const entry = readHistory(home).filter(item => item.repo === redactPaths(info.root) && ['summary handoff', 'brief handoff'].includes(item.mode)).pop();
  if (!entry) return null;
  console.log(`Your last handoff from this repository was a summary handoff (--summary), on ${entry.branch}.`);
  console.log('Its conversation is a separate cloud session, so bring it down with Claude Code itself:\n');
  console.log(`git fetch ${info.remote} ${entry.branch}\nclaude --teleport${entry.sessionId ? ` ${entry.sessionId}` : ''}`);
  return 0;
}

function recentlyHome(info, home) {
  return allRecords(home)
    .filter(record => record.repoRoot === info.root && record.broughtBackAt && Date.now() - Date.parse(record.broughtBackAt) < RECENT_HOME_MS)
    .sort((a, b) => a.broughtBackAt.localeCompare(b.broughtBackAt))
    .pop();
}

// /skyhop-back: everything at once, from a window that isn't the session itself.
export function bringBack({ session, dryRun = false, home = os.homedir() }) {
  const info = repoInfo(process.cwd());
  const records = waitingRecords(info.root, home);
  const record = session ? records.find(item => item.sessionId === session) : records.at(-1);
  if (!record) {
    const recent = !session && recentlyHome(info, home);
    if (recent) {
      console.log(`Skyhop already brought ${label(recent)} home. Type /resume and pick it, or run:\n\nclaude --resume ${recent.resumeId ?? recent.sessionId}`);
      return 0;
    }
    const help = briefHandoffHelp(info, home);
    if (help !== null) return help;
    throw new SkyhopError('There is no full-resume handoff to bring back from this repository.', 'Run this from the repository you handed off.');
  }
  if (!record.sync) {
    throw new SkyhopError('That handoff had no saved progress to bring back.', 'It ran with no remote or with --no-sync, so the conversation stayed in the cloud.');
  }
  try {
    return bringBackRecord(info, record, dryRun, home);
  } finally {
    dropDownloads(info);
  }
}

function bringBackRecord(info, record, dryRun, home) {
  const branches = cloudBranches(info, record);
  if (!branches) throw new SkyhopError(`Could not reach ${info.remote}, so nothing was changed.`, 'Check your connection, then run /skyhop-back again.');
  if (!dryRun && stillBusy(branches, record)) {
    saveHandoffRecord({ ...record, busyWarned: branches.pulse }, home);
    console.log('The cloud session is still working on a reply. Run /skyhop-back again once it has finished. If it never finishes, running it again brings home everything saved before that reply.');
    return 1;
  }
  if (!branches.chat && !branches.code && !record.pulledChat) {
    console.log('Nothing has been saved yet. Send the cloud session a message, wait for its reply, then try again.');
    return 0;
  }
  if (isSessionRunning(record.sessionId)) {
    throw new SkyhopError(
      'That session is open in a Claude Code window, maybe this one, so nothing was changed.',
      'Quit that window and run /skyhop-back from another one. Or just send a message in it: it comes home by itself.',
    );
  }

  const file = findTranscript(record.sessionId).path;
  const got = download(info, record, branches);
  const typed = localTurnsAfter(file, localEnd(record));
  const fork = got.fresh.length > 0 && typed > 0;
  console.log(`Saved in the cloud: ${got.count} message turn(s), ${got.lines} transcript record(s).`);

  if (dryRun) {
    const code = bringCode(info, record, got.codeSha, true);
    console.log(fork
      ? `Conversation: would become a new session, because you typed ${typed} message(s) in it after the handoff.`
      : 'Conversation: would be added to your original session.');
    console.log(code.kind === 'none' ? 'Code: no changes to bring back.' : `Code: would go ${code.kind === 'apply' ? 'into your files on' : 'on'} ${code.branch}.`);
    console.log('\nDry run: nothing was changed.');
    return 0;
  }

  if (!closeCloud(info, record, branches)) throw new SkyhopError(`Could not reach ${info.remote}, so nothing was changed.`, 'Check your connection, then run /skyhop-back again.');
  const backup = record.backup ?? backupSession(file, record.sessionId, home);
  let resumeId = record.sessionId;
  if (fork) resumeId = forkSession(file, record.sessionId, localEnd(record), got.fresh).newId;
  else if (got.fresh.length > 0) fs.appendFileSync(file, got.fresh);
  markHome(record, home, { resumeId, backup });
  const code = bringCode(info, record, got.codeSha, false);
  tidyRemote(info, record, got);

  console.log(fork
    ? `\nThe cloud conversation is in a new session, because you typed ${typed} message(s) in it after the handoff. Your original session wasn't changed.`
    : '\nThe cloud conversation is now in your original session.');
  console.log(describeCode(code));
  console.log('The cloud chat is closed, so messages sent there no longer reach this session.');
  console.log(`Backup of the original session: ${redactPaths(backup)}`);
  console.log(`\nTo carry on, type /resume and pick it, or run:\n\nclaude --resume ${resumeId}`);
  return 0;
}
