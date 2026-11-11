// Brings a full-resume session home from the cloud as the same session. It runs
// in three places:
//   - pullAll, when Claude Code starts in the repository. The cloud conversation is
//     added to the original session, so /resume shows it. The cloud chat stays open,
//     because starting Claude Code there doesn't mean the user is back.
//   - claim, on the session's next message on this Mac. Typing here means the user
//     is back, so the cloud chat closes and the code comes home.
//   - bringBack, for /skyhop-back, which does both at once from another window.
// A window reads a session file only when it opens it, and Claude Code carries on
// from the last conversation line in the file. So a line written by a window that
// opened the session before its cloud part arrived hides that part, even Skyhop's own
// note when it stops a message there. Nothing is added to a session that's open, a
// window that doesn't show the cloud part can't bring the session home, and the next
// start moves such lines in front of the cloud part.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactPaths } from './brief.mjs';
import { readHistory, runClaude } from './cloud.mjs';
import { findTranscript } from './fullresume.mjs';
import { createSnapshot, git, repoInfo, skyhopBranch, SkyhopError, tryGit } from './git.mjs';
import { log, logDir, privateFile, shortId } from './log.mjs';
import { applyCloudMemory, describeMemory } from './memory.mjs';
import { isSensitivePath } from './secrets.mjs';
import { pulseRef, readChunks, readCloudLog, readSavedMemory, readSealedCodeTree } from './sync.mjs';

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
  privateFile(recordFile(record.sessionId, home));
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
  noteHomecoming(record.sessionId, home, false);
}

// Tells hooks/takeoff.tsx to fly the plane home: written when a window opens a
// session whose cloud conversation it shows, and removed otherwise. Claude Code
// versions without hooks modules just leave it unread.
export function homecomingFile(sessionId, home = os.homedir()) {
  return path.join(home, '.skyhop', 'animate', `${sessionId}.json`);
}

function noteHomecoming(sessionId, home, shown) {
  const file = homecomingFile(sessionId, home);
  if (!shown) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ at: Date.now() })}\n`, { mode: 0o600 });
  privateFile(file);
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

// The handoff's branches on GitHub, from one request, which the startup check shares
// between all waiting handoffs. Null when it can't be reached. While the cloud works
// on a reply, its pulse branch is a commit ahead of the chat.
function cloudBranches(info, record, heads = listHeads(info)) {
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

function readRange(file, from, to) {
  const buffer = Buffer.alloc(Math.max(0, to - from));
  const fd = fs.openSync(file, 'r');
  try {
    let done = 0;
    while (done < buffer.length) {
      const got = fs.readSync(fd, buffer, done, buffer.length - done, from + done);
      if (got === 0) break;
      done += got;
    }
    return buffer.subarray(0, done);
  } finally {
    fs.closeSync(fd);
  }
}

function* linesBackwards(bytes) {
  let end = bytes.length;
  while (end > 0) {
    const start = end >= 2 ? bytes.lastIndexOf(10, end - 2) + 1 : 0;
    yield bytes.subarray(start, end);
    end = start;
  }
}

// Claude Code carries on a session from the last conversation line in its file, even
// when an earlier line has a later time (seen on 2.1.319). Conversation lines have a
// uuid and name the line before as parentUuid, and bookkeeping lines have no uuid.
// The format is internal, so an unreadable line is skipped.
function conversationLine(line) {
  try {
    const record = JSON.parse(line.toString('utf8'));
    return typeof record?.uuid === 'string' && !record.isSidechain ? { uuid: record.uuid, parent: record.parentUuid ?? null } : null;
  } catch {
    return null;
  }
}

function lastUuid(bytes) {
  for (const line of linesBackwards(bytes)) {
    const found = conversationLine(line);
    if (found) return found.uuid;
  }
  return null;
}

// Whether a window opening the session now would show its cloud part: the last
// conversation line is the cloud's last one, or follows on from it. Handoffs pulled
// before Skyhop kept track of this say yes, as before.
export function cloudShown(file, record) {
  const first = record.blocks?.[0]?.[0];
  if (!record.cloudLeaf || first === undefined) return true;
  const size = fs.statSync(file).size;
  if (first > size) return true;
  let want = null;
  for (const line of linesBackwards(readRange(file, first, size))) {
    if (want !== null && !line.includes(want)) continue;
    const found = conversationLine(line);
    if (!found || (want !== null && found.uuid !== want)) continue;
    if (found.uuid === record.cloudLeaf) return true;
    if (!found.parent) return false;
    want = found.parent;
  }
  return false;
}

// Moves the lines written after the cloud part in front of it, so Claude Code carries
// on from the cloud part again. Only the end of the file that Skyhop added to changes,
// and lines only change places, so its size stays the same. Returns the record's new
// fields, or null when it can't be done safely: a message typed there means the user
// carried on without the cloud part, and /skyhop-back then splits it off.
export function putCloudLast(file, record, { dryRun = false } = {}) {
  const blocks = record.blocks ?? [];
  if (blocks.length === 0) return null;
  const first = blocks[0][0];
  const size = fs.statSync(file).size;
  if (!blocks.every(([from, to], i) => from < to && to <= size && (i === 0 || from >= blocks[i - 1][1]))) return null;
  const region = readRange(file, first, size);
  const cloud = [];
  const moved = [];
  let at = 0;
  for (const [from, to] of blocks) {
    moved.push(region.subarray(at, from - first));
    cloud.push(region.subarray(from - first, to - first));
    at = to - first;
  }
  moved.push(region.subarray(at));
  if (moved.some(part => part.length > 0 && part.at(-1) !== 10)) return null;
  const front = Buffer.concat(moved);
  if (front.length === 0 || typedTurns(front) > 0) return null;
  if (!dryRun) {
    const reordered = Buffer.concat([front, ...cloud]);
    const fd = fs.openSync(file, 'r+');
    try {
      let done = 0;
      while (done < reordered.length) done += fs.writeSync(fd, reordered, done, reordered.length - done, first + done);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return { blocks: [[first + front.length, size]], localTo: size };
}

// The claude.ai entry for the session's Remote Control, which keeps the whole
// conversation readable on the phone, even once it's archived. While Remote Control
// is on, Claude Code rewrites a bridge-session record every few messages, and the
// newest one names the current entry. Its ID matches the entry's link apart from the
// prefix: cse_ in the file, session_ in the link. The format is internal, so anything
// unexpected means no link. `missing` counts messages typed after the newest record,
// once there are more than a few records' worth, which means Remote Control was off.
const BRIDGE_MARK = Buffer.from('"bridge-session"');
const STALE_TURNS = 10;

export function remoteControlEntry(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  for (let at = bytes.lastIndexOf(BRIDGE_MARK); at >= 0; at = at > 0 ? bytes.lastIndexOf(BRIDGE_MARK, at - 1) : -1) {
    const start = bytes.lastIndexOf(10, at) + 1;
    const newline = bytes.indexOf(10, at);
    const end = newline < 0 ? bytes.length : newline + 1;
    let record;
    try {
      record = JSON.parse(bytes.subarray(start, end).toString('utf8'));
    } catch {
      continue;
    }
    const id = record?.type === 'bridge-session' ? String(record.bridgeSessionId ?? '').match(/^(?:cse|session)_([A-Za-z0-9]{10,})$/) : null;
    if (!id) continue;
    const later = typedTurns(bytes.subarray(end));
    return { url: `https://claude.ai/code/session_${id[1]}`, missing: later > STALE_TURNS ? later : 0 };
  }
  return null;
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

// The cloud's own log comes down with the conversation, for bug reports. It is a
// copy, replaced by the newer one each time.
function saveCloudLog(info, sha, record, home) {
  const text = readCloudLog(info.root, sha, record.sync.key);
  if (!text) return;
  try {
    fs.mkdirSync(logDir(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(logDir(home), `cloud-${record.sessionId}.log`), text, { mode: 0o600 });
  } catch {
    // only for bug reports
  }
}

// Downloads the saved conversation and code. `all` is everything since the
// handoff, and `fresh` is the part this Mac doesn't have yet.
function download(info, record, branches, home) {
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
  if (chatSha) saveCloudLog(info, chatSha, record, home);
  const saved = chatSha ? readSaved(info, chatSha, record) : { bytes: Buffer.alloc(0), to: record.baseBytes, count: 0 };
  const lines = assertValidLines(saved.bytes);
  const known = (record.pulledTo ?? record.baseBytes) - record.baseBytes;
  const memory = chatSha && record.memory ? readSavedMemory(info.root, chatSha, record.sync.key) : null;
  const sealedTree = chatSha ? readSealedCodeTree(info.root, chatSha, record.sync.key) : null;
  return { chatSha, codeSha, all: saved.bytes, fresh: saved.bytes.subarray(known), to: saved.to, count: saved.count, lines, memory, sealedTree };
}

// The cloud's changes to the project's memory notes, merged into this Mac's folder.
// Returns a line for the user, or null, and the record fields to keep.
function bringMemory(record, got, home) {
  if (!record.memory || !got.memory) return { line: null, changed: [], fields: {} };
  const aside = path.join(home, '.skyhop', 'memory-aside', record.sessionId);
  const done = applyCloudMemory({ dir: record.memory.dir, base: record.memory.base, cloud: got.memory, aside });
  return {
    line: describeMemory(done, redactPaths(aside)),
    changed: [...done.added, ...done.updated, ...done.removed],
    fields: { memory: { ...record.memory, base: done.base } },
  };
}

function dropDownloads(info) {
  tryGit(info.root, ['update-ref', '-d', CHAT_REF]);
  tryGit(info.root, ['update-ref', '-d', CODE_REF]);
}

function isSessionRunning(sessionId) {
  const run = runClaude(['agents', '--json'], { encoding: 'utf8' });
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
  privateFile(backup);
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
// they wait on a new branch. So does code that isn't the code the cloud sealed with
// the conversation, which anyone who can push to the repository could have put there.
function bringCode(info, record, sha, dryRun, sealedTree) {
  if (!sha) return { kind: 'none' };
  const tree = git(info.root, ['rev-parse', `${sha}^{tree}`]);
  if (tree === record.snapshotTree) return { kind: 'none' };
  if (record.codeSealed && tree !== sealedTree) {
    if (dryRun) return { kind: 'unverified', branch: 'a new skyhop/back-... branch' };
    const branch = skyhopBranch('back');
    git(info.root, ['branch', branch, sha]);
    return { kind: 'unverified', branch };
  }
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
  if (code.kind === 'unverified') return `The code on GitHub doesn't match what your cloud session saved, so someone else may have changed it. Skyhop left your files alone and put that code on ${code.branch}. Check it before using it: git diff HEAD ${code.branch}`;
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
  const records = waitingRecords(info.root, home).filter(record => record.sync);
  if (records.length === 0) return [];
  // The user can pick a session while this runs, so it asks GitHub only once.
  const heads = listHeads(info);
  return records.map(record => {
    let line;
    try {
      line = pullOne(info, record, heads, home);
    } catch (error) {
      line = `Skyhop could not update ${label(record)} from the cloud: ${error.message}`;
    } finally {
      dropDownloads(info);
    }
    log('home', 'startup', { session: shortId(record.sessionId), said: line }, home);
    return line;
  });
}

function pullOne(info, record, heads, home) {
  const name = label(record);
  const branches = cloudBranches(info, record, heads);
  if (!branches) return `Skyhop: ${name} is in the cloud, but ${info.remote} couldn't be reached to update it here.`;
  const working = branches.busy ? " It's working on a reply there." : '';
  const waiting = `Skyhop: ${name} is in the cloud.${working} Pick it in /resume to bring it home.`;
  if (!branches.chat || branches.chat === record.pulledChat) return showCloudPart(record, name, home) ?? waiting;

  const file = findTranscript(record.sessionId).path;
  // A window that opens the session from here on has loaded it without the cloud
  // part, and it writes to the file as it opens it, so a change in size means wait.
  const size = fs.statSync(file).size;
  if (isSessionRunning(record.sessionId)) {
    return `Skyhop: ${name} has new messages in the cloud, but it's open in another Claude Code window. Quit that window, then open claude here again.`;
  }
  if (localTurnsAfter(file, localEnd(record)) > 0) {
    return `Skyhop: ${name} has new messages in the cloud, and you also typed in it here after the handoff. Run /skyhop-back to get the cloud part as a separate session.`;
  }
  const got = download(info, record, branches, home);
  if (got.fresh.length === 0) return showCloudPart(record, name, home) ?? waiting;

  const backup = record.backup ?? backupSession(file, record.sessionId, home);
  if (fs.statSync(file).size !== size) {
    return `Skyhop: ${name} has new messages in the cloud, but a window opened it while they were downloading. Quit that window, then open claude here again.`;
  }
  fs.appendFileSync(file, got.fresh);
  const notes = bringMemory(record, got, home);
  saveHandoffRecord({
    ...record,
    ...notes.fields,
    backup,
    pulledTo: got.to,
    pulledChat: got.chatSha,
    localTo: size + got.fresh.length,
    lastPullAt: Date.now(),
    blocks: [...(record.blocks ?? []), [size, size + got.fresh.length]],
    cloudLeaf: lastUuid(got.fresh) ?? record.cloudLeaf,
  }, home);
  const memoryNote = notes.line ? ` ${notes.line}` : '';
  return `Skyhop: ${name} now has its cloud conversation here (${typedTurns(got.fresh)} new message(s)).${working} Pick it in /resume. It comes home for good when you send a message there, and the cloud chat closes then.${memoryNote}`;
}

// A window that opened the session before its cloud part arrived, and wrote to it
// after, hides that part. The next start puts it back in view before the user can
// pick the session. Returns a line to show instead of the usual one, or null.
function showCloudPart(record, name, home) {
  if (!record.cloudLeaf) return null;
  const file = findTranscript(record.sessionId).path;
  if (cloudShown(file, record)) return null;
  if (isSessionRunning(record.sessionId)) {
    return `Skyhop: ${name} is open in another Claude Code window that doesn't show its cloud conversation. Quit that window, then open claude here again.`;
  }
  const fixed = putCloudLast(file, record);
  if (!fixed) {
    return `Skyhop: ${name} has a cloud conversation that isn't shown, because you typed in it here without it. Run /skyhop-back to get the cloud part as a separate session.`;
  }
  saveHandoffRecord({ ...record, ...fixed }, home);
  log('home', 'cloud part put last', { session: shortId(record.sessionId), moved: fixed.blocks[0][0] - record.blocks[0][0] }, home);
  return null;
}

const REOPEN = 'Quit (type /exit), open claude in this folder again, and pick it in /resume.';

function shownHere(sessionId, record) {
  try {
    return cloudShown(findTranscript(sessionId).path, record);
  } catch {
    return true;
  }
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
  let line = 'Skyhop: this session was in the cloud. It comes home when you send a message, and the cloud chat closes then.';
  let shown = true;
  if (branches?.chat && branches.chat !== record.pulledChat) {
    line = `Skyhop: this session has new messages in the cloud that are not shown here. ${REOPEN}`;
    shown = false;
  } else if (!shownHere(sessionId, record)) {
    line = `Skyhop: this window doesn't show the session's cloud conversation. ${REOPEN}`;
    shown = false;
  }
  noteHomecoming(sessionId, home, shown);
  log('home', 'opened', { session: shortId(sessionId), github: branches ? 'reached' : 'unreachable', said: line }, home);
  return line;
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
  let output;
  try {
    output = claimHere(info, record, pid, home);
  } catch (error) {
    output = allow(`Skyhop could not finish bringing this session home: ${error.message}`);
  } finally {
    dropDownloads(info);
  }
  log('home', 'message', {
    session: shortId(sessionId), outcome: output.decision === 'block' ? 'stopped' : 'let through', said: output.reason ?? output.systemMessage,
  }, home);
  return output;
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
  // Coming home from a window without the cloud part would leave it hidden for good.
  // Stopping the message writes a note after the cloud part, and the next start moves
  // that note in front of it.
  const openedTooEarly = !hasNew && typed === 0 && record.lastPullAt && loadedAt(sessionId, pid, home) < record.lastPullAt;
  const hidden = !(hasNew && typed > 0) && !cloudShown(file, record);
  if (openedTooEarly || hidden) {
    return block(`This window doesn't show the session's cloud conversation, so Skyhop stopped this message. ${REOPEN}`);
  }

  const got = download(info, record, branches, home);
  if (!closeCloud(info, record, branches)) {
    return allow(`Skyhop couldn't close this session's cloud chat on ${info.remote}. Avoid using it: Skyhop tries again on your next message here.`);
  }
  // The user typed here while the cloud kept going, so the cloud part becomes its own session.
  const forked = hasNew ? forkSession(file, sessionId, localEnd(record), got.fresh) : null;
  const notes = bringMemory(record, got, home);
  markHome(record, home, { ...(forked ? { resumeId: forked.newId } : {}), ...notes.fields });
  const code = bringCode(info, record, got.codeSha, false, got.sealedTree);
  tidyRemote(info, record, got);

  const parts = [
    'Skyhop: this session is back from the cloud, and its cloud chat is closed.',
    forked ? `The cloud had new messages too, so they are in a separate session: claude --resume ${forked.newId}` : null,
    code.kind === 'none' ? null : describeCode(code),
    notes.line,
  ].filter(Boolean);
  const facts = [
    code.kind === 'none' ? null : describeCode(code),
    notes.changed.length > 0 ? `Memory notes the cloud session changed are now in the memory folder, newer than what this window loaded: ${notes.changed.join(', ')}.` : null,
  ].filter(Boolean);
  const context = facts.length > 0 ? `Skyhop: this session just came back from a Claude Code cloud session. ${facts.join(' ')}` : null;
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
    log('back', 'still working in the cloud', { session: shortId(record.sessionId) }, home);
    saveHandoffRecord({ ...record, busyWarned: branches.pulse }, home);
    console.log('The cloud session is still working on a reply. Run /skyhop-back again once it has finished. If it never finishes, running it again brings home everything saved before that reply.');
    return 1;
  }
  if (!branches.chat && !branches.code && !record.pulledChat) {
    log('back', 'nothing saved yet', { session: shortId(record.sessionId) }, home);
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
  const got = download(info, record, branches, home);
  const typed = localTurnsAfter(file, localEnd(record));
  // A cloud part added earlier may be hidden behind lines a window wrote after it.
  // It's put back in view, unless the user typed there without it: then it's split off.
  const hidden = !cloudShown(file, record);
  const split = hidden && !putCloudLast(file, record, { dryRun: true });
  const fork = (got.fresh.length > 0 && typed > 0) || split;
  console.log(`Saved in the cloud: ${got.count} message turn(s), ${got.lines} transcript record(s).`);

  if (dryRun) {
    const code = bringCode(info, record, got.codeSha, true, got.sealedTree);
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
  if (split) resumeId = forkSession(file, record.sessionId, record.blocks[0][0], got.all).newId;
  else if (fork) resumeId = forkSession(file, record.sessionId, localEnd(record), got.fresh).newId;
  else {
    if (hidden) putCloudLast(file, record);
    if (got.fresh.length > 0) fs.appendFileSync(file, got.fresh);
  }
  const notes = bringMemory(record, got, home);
  markHome(record, home, { resumeId, backup, ...notes.fields });
  const code = bringCode(info, record, got.codeSha, false, got.sealedTree);
  tidyRemote(info, record, got);
  log('back', 'brought home', { session: shortId(record.sessionId), turns: got.count, conversation: fork ? 'new session' : 'same session', code: code.kind }, home);

  console.log(fork
    ? `\nThe cloud conversation is in a new session, because you typed ${typed} message(s) in it after the handoff. Your original session wasn't changed.`
    : '\nThe cloud conversation is now in your original session.');
  console.log(describeCode(code));
  if (notes.line) console.log(notes.line);
  console.log('The cloud chat is closed, so messages sent there no longer reach this session.');
  console.log(`Backup of the original session: ${redactPaths(backup)}`);
  console.log(`\nTo carry on, type /resume and pick it, or run:\n\nclaude --resume ${resumeId}`);
  return 0;
}
