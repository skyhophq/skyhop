// Moves a full-resume session through GitHub in encrypted form, for the handoff and
// for /skyhop-back. Runs in the VM and on the Mac, so it uses only Node's standard
// library. The key never reaches GitHub: it travels in the first message of the
// cloud session, and stays in ~/.skyhop on the Mac.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const KEY_PATTERN = /\[skyhop-key:([A-Za-z0-9+/=]+)\]/;
// GitHub refuses files over 100 MB, so a long transcript goes up in parts.
export const TRANSCRIPT_PART_BYTES = 45 * 1024 * 1024;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 256 * 1024 * 1024;
const ERROR_TEXT_LIMIT = 300;
const AUTHOR = {
  GIT_AUTHOR_NAME: 'Skyhop',
  GIT_AUTHOR_EMAIL: 'skyhop@localhost',
  GIT_COMMITTER_NAME: 'Skyhop',
  GIT_COMMITTER_EMAIL: 'skyhop@localhost',
};

export function newKey() {
  return crypto.randomBytes(32).toString('base64');
}

function chunkName(seq) {
  return `chunks/${String(seq).padStart(6, '0')}.enc`;
}

export function sealChunk({ from, to, bytes }, key, seq) {
  const plain = zlib.gzipSync(Buffer.concat([Buffer.from(`${JSON.stringify({ from, to })}\n`), bytes]));
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  cipher.setAAD(Buffer.from(`skyhop-chunk-${seq}`));
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
}

export function openChunk(data, key, seq) {
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  decipher.setAAD(Buffer.from(`skyhop-chunk-${seq}`));
  decipher.setAuthTag(tag);
  const plain = zlib.gunzipSync(Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]));
  const newline = plain.indexOf(10);
  return { ...JSON.parse(plain.subarray(0, newline).toString()), bytes: plain.subarray(newline + 1) };
}

export function sealTranscript(bytes, key, partBytes = TRANSCRIPT_PART_BYTES) {
  const sealed = sealChunk({ from: 0, to: bytes.length, bytes }, key, 0);
  const parts = [];
  for (let start = 0; start < sealed.length; start += partBytes) parts.push(sealed.subarray(start, start + partBytes));
  return parts;
}

export function openTranscript(parts, key) {
  return openChunk(Buffer.concat(parts), key, 0).bytes;
}

export function readKey(root) {
  try {
    return fs.readFileSync(path.join(root, '.skyhop/sync-key'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function git(root, args, { env, input, encoding = 'utf8', timeout } = {}) {
  return spawnSync('git', args, {
    cwd: root, input, encoding, timeout, maxBuffer: MAX_OUTPUT, env: { ...process.env, ...env },
  });
}

function must(run, what) {
  if (run.status !== 0) throw new Error(`${what}: ${String(run.stderr ?? run.error).trim().slice(0, ERROR_TEXT_LIMIT)}`);
  return String(run.stdout).trim();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Only whole lines go up, so a half-written record waits for the next message.
function newLines(file, from) {
  const size = fs.statSync(file).size;
  if (size <= from) return null;
  const bytes = Buffer.alloc(size - from);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, bytes, 0, bytes.length, from);
  fs.closeSync(fd);
  const end = bytes.lastIndexOf(10);
  return end < 0 ? null : { from, to: from + end + 1, bytes: bytes.subarray(0, end + 1) };
}

function commitChunk(root, parent, name, data) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyhop-sync-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    if (parent) must(git(root, ['read-tree', parent], { env }), 'read-tree');
    const blob = must(git(root, ['hash-object', '-w', '--stdin'], { input: data, encoding: 'buffer' }), 'hash-object');
    must(git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${name}`], { env }), 'update-index');
    const tree = must(git(root, ['write-tree'], { env }), 'write-tree');
    const parents = parent ? ['-p', parent] : [];
    return must(git(root, ['commit-tree', tree, ...parents, '-m', 'Skyhop encrypted session progress'], { env: AUTHOR }), 'commit-tree');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The same throwaway-index approach as the handoff snapshot, so the session's
// own index and working tree are never touched.
function codeTree(root, isExcluded) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyhop-sync-'));
  const indexFile = path.join(tmp, 'index');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    fs.copyFileSync(path.resolve(root, must(git(root, ['rev-parse', '--git-path', 'index']), 'index path')), indexFile);
    must(git(root, ['add', '-A', '--', ':/'], { env }), 'add');
    const changed = String(git(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD'], { env }).stdout).split('\0').filter(Boolean);
    const excluded = changed.filter(isExcluded);
    if (excluded.length > 0) {
      must(git(root, ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: excluded.join('\0') }), 'reset');
    }
    return must(git(root, ['write-tree'], { env }), 'write-tree');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function commitCode(root, tree, previous) {
  const head = must(git(root, ['rev-parse', 'HEAD']), 'rev-parse');
  const headIncluded = previous && git(root, ['merge-base', '--is-ancestor', head, previous]).status === 0;
  const parents = previous ? [previous, ...(headIncluded ? [] : [head])] : [head];
  const args = parents.flatMap(parent => ['-p', parent]);
  return must(git(root, ['commit-tree', tree, ...args, '-m', 'Skyhop cloud progress'], { env: AUTHOR }), 'commit-tree');
}

// The VM may reach GitHub through its own origin, so the Mac's URL is the fallback.
function pushTargets(root, config) {
  const hasOrigin = git(root, ['remote', 'get-url', 'origin']).status === 0;
  return [...(hasOrigin ? ['origin'] : []), config.remoteUrl].filter(Boolean);
}

function pushRefs(root, config, refspecs, timeout) {
  let failure = 'no remote to push to';
  for (const target of pushTargets(root, config)) {
    const run = git(root, ['push', target, ...refspecs], { timeout });
    if (run.status === 0) return null;
    failure = String(run.stderr || run.error).trim().slice(-ERROR_TEXT_LIMIT);
  }
  return failure;
}

// Returns a warning for the user, or null when everything is saved. The state
// only moves forward after a successful push, so a failed save retries next time.
export function saveProgress({ root, transcript, isExcluded = () => false, scan = () => [], timeout = PUSH_TIMEOUT_MS }) {
  const skyhop = path.join(root, '.skyhop');
  const config = readJson(path.join(skyhop, 'sync.json'));
  if (!config) return null;
  const key = readKey(root);
  if (!key) return 'Skyhop could not save this message, because its key is missing from this VM.';

  const stateFile = path.join(skyhop, 'sync-state.json');
  const state = readJson(stateFile) ?? { sentBytes: config.baseBytes, seq: 0, chatTip: null, codeTip: null, codeTree: config.snapshotTree };
  const next = { ...state };
  const refspecs = [];
  const warnings = [];

  const chunk = newLines(transcript, state.sentBytes);
  if (chunk) {
    next.seq = state.seq + 1;
    next.sentBytes = chunk.to;
    next.chatTip = commitChunk(root, state.chatTip, chunkName(next.seq), sealChunk(chunk, key, next.seq));
    refspecs.push(`${next.chatTip}:refs/heads/${config.chatRef}`);
  }

  const tree = codeTree(root, isExcluded);
  if (tree !== state.codeTree) {
    const diff = String(git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', state.codeTree, tree]).stdout);
    const findings = scan(diff);
    if (findings.length > 0) {
      warnings.push(`Skyhop did not save this code to GitHub, because it found a likely secret in ${findings[0].source}.`);
    } else {
      next.codeTip = commitCode(root, tree, state.codeTip);
      next.codeTree = tree;
      refspecs.push(`${next.codeTip}:refs/heads/${config.codeRef}`);
    }
  }

  if (refspecs.length > 0) {
    const failure = pushRefs(root, config, refspecs, timeout);
    if (failure) {
      warnings.push(`Skyhop could not save this message to GitHub, so /skyhop-back won't have it yet. It will try again on your next message. (${failure})`);
      return warnings.join('\n\n');
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(next));
  return warnings.length > 0 ? warnings.join('\n\n') : null;
}

// Decrypts a saved chat branch in order. Any gap or tampering throws.
export function readChunks(root, sha, key, expectedFrom) {
  const names = String(git(root, ['ls-tree', '-r', '--name-only', sha]).stdout).split('\n').filter(Boolean).sort();
  const parts = [];
  let cursor = expectedFrom;
  names.forEach((name, index) => {
    const data = git(root, ['cat-file', 'blob', `${sha}:${name}`], { encoding: 'buffer' }).stdout;
    const chunk = openChunk(data, key, index + 1);
    if (chunk.from !== cursor) throw new Error(`saved progress has a gap at chunk ${index + 1}`);
    parts.push(chunk.bytes);
    cursor = chunk.to;
  });
  return { bytes: Buffer.concat(parts), to: cursor, count: names.length };
}

// A cleared VM starts again from the handoff. This puts back what was already
// saved, so the resumed session keeps everything since then.
export function restoreProgress({ root, transcript }) {
  const skyhop = path.join(root, '.skyhop');
  const config = readJson(path.join(skyhop, 'sync.json'));
  const stateFile = path.join(skyhop, 'sync-state.json');
  const key = readKey(root);
  if (!config || !key || fs.existsSync(stateFile)) return false;

  for (const target of pushTargets(root, config)) {
    const fetched = git(root, ['fetch', '--no-tags', '-q', target, `refs/heads/${config.chatRef}`], { timeout: PUSH_TIMEOUT_MS });
    if (fetched.status !== 0) continue;
    const tip = must(git(root, ['rev-parse', 'FETCH_HEAD']), 'rev-parse');
    const saved = readChunks(root, tip, key, config.baseBytes);
    fs.appendFileSync(transcript, saved.bytes);
    fs.writeFileSync(stateFile, JSON.stringify({ sentBytes: saved.to, seq: saved.count, chatTip: tip, codeTip: null, codeTree: config.snapshotTree }));
    return true;
  }
  return false;
}
