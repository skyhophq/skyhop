// /skyhop-back: brings a full-resume session's cloud work home. The conversation is
// added to the original session so /resume shows it, and the code lands on a new
// local branch. The user's own branch and any local work are never overwritten.
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
import { readChunks } from './sync.mjs';

const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

function sessionsDir(home = os.homedir()) {
  return path.join(home, '.skyhop', 'sessions');
}

export function saveHandoffRecord(record, home = os.homedir()) {
  const dir = sessionsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${record.sessionId}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function loadRecords(root, home) {
  const dir = sessionsDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')))
    .filter(record => record.repoRoot === root && !record.broughtBackAt)
    .sort((a, b) => a.at.localeCompare(b.at));
}

function fetchRef(info, remoteRef, localRef) {
  return tryGit(info.root, ['fetch', '-q', '--no-tags', info.remote, `+refs/heads/${remoteRef}:${localRef}`]) !== null
    ? git(info.root, ['rev-parse', localRef])
    : null;
}

// Counts messages typed locally after the handoff. The format is internal, so
// anything unreadable counts as local work, which keeps the safer path.
export function localTurnsAfter(file, baseBytes) {
  const text = fs.readFileSync(file).subarray(baseBytes).toString('utf8');
  let turns = 0;
  for (const line of text.split('\n').filter(Boolean)) {
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

// A new session file holding the handoff point plus the cloud messages. The
// session ID appears on every line, so it's swapped as plain text.
export function forkSession(file, sessionId, baseBytes, delta) {
  const newId = crypto.randomUUID();
  const base = fs.readFileSync(file).subarray(0, baseBytes);
  const text = Buffer.concat([base, delta]).toString('latin1').replaceAll(sessionId, newId);
  const target = path.join(path.dirname(file), `${newId}.jsonl`);
  fs.writeFileSync(target, text, 'latin1');
  return { newId, target };
}

function chooseConversationPath(record, file) {
  if (isSessionRunning(record.sessionId)) return { kind: 'fork', reason: 'that session is still open in a Claude Code window' };
  const turns = localTurnsAfter(file, record.baseBytes);
  if (turns > 0) return { kind: 'fork', reason: `you typed ${turns} message(s) in it after the handoff` };
  return { kind: 'append' };
}

function localFilesUnchanged(info, record) {
  if (info.head !== record.head) return false;
  const snapshot = createSnapshot(info, { isExcluded: isSensitivePath, message: 'Skyhop check' });
  if (snapshot.tree !== record.snapshotTree) return false;
  return !snapshot.excluded.some(file => tryGit(info.root, ['ls-files', '--error-unmatch', '--', file]) !== null);
}

// Checks out the cloud's code only when that can't overwrite anything: the files
// must still match the handoff exactly. Otherwise the code just waits on a branch.
function bringCode(info, record, sha, dryRun) {
  if (!sha) return { branch: null, switched: false };
  const unchanged = localFilesUnchanged(info, record);
  if (dryRun) return { branch: 'a new skyhop/back-... branch', switched: unchanged };

  const branch = skyhopBranch('back');
  if (unchanged) {
    git(info.root, [...NO_HOOKS, 'switch', '-q', '-c', branch]);
    git(info.root, ['reset', '-q', '--hard', sha]);
  } else {
    git(info.root, ['branch', branch, sha]);
  }
  return { branch, switched: unchanged };
}

function briefHandoffHelp(info, home) {
  const entry = readHistory(home).filter(item => item.repo === redactPaths(info.root) && ['summary handoff', 'brief handoff'].includes(item.mode)).pop();
  if (!entry) return null;
  console.log(`Your last handoff from this repository was a summary handoff (--summary), on ${entry.branch}.`);
  console.log('Its conversation is a separate cloud session, so bring it down with Claude Code itself:\n');
  console.log(`git fetch ${info.remote} ${entry.branch}\nclaude --teleport${entry.sessionId ? ` ${entry.sessionId}` : ''}`);
  return 0;
}

export function bringBack({ session, dryRun = false, home = os.homedir() }) {
  const info = repoInfo(process.cwd());
  const records = loadRecords(info.root, home);
  const record = session ? records.find(item => item.sessionId === session) : records.at(-1);
  if (!record) {
    const help = briefHandoffHelp(info, home);
    if (help !== null) return help;
    throw new SkyhopError('There is no full-resume handoff to bring back from this repository.', 'Run this from the repository you handed off.');
  }
  if (!record.sync) {
    throw new SkyhopError('That handoff had no saved progress to bring back.', 'It ran with no remote or with --no-sync, so the conversation stayed in the cloud.');
  }

  const chatRef = 'refs/skyhop/back-chat';
  const codeRef = 'refs/skyhop/back-code';
  try {
    const chatSha = fetchRef(info, record.sync.chatRef, chatRef);
    const codeSha = fetchRef(info, record.sync.codeRef, codeRef);
    if (!chatSha && !codeSha) {
      if (tryGit(info.root, ['ls-remote', '--heads', info.remote]) === null) {
        throw new SkyhopError(`Could not reach ${info.remote}, so nothing was changed.`, 'Check your connection, then run /skyhop-back again.');
      }
      console.log('Nothing has been saved yet. Send the cloud session a message, wait for its reply, then try again.');
      return 0;
    }

    const file = findTranscript(record.sessionId).path;
    const saved = chatSha ? readSaved(info, chatSha, record) : { bytes: Buffer.alloc(0), count: 0 };
    const lines = assertValidLines(saved.bytes);
    const route = chooseConversationPath(record, file);
    console.log(`Saved in the cloud: ${saved.count} message turn(s), ${lines} transcript record(s).`);

    if (dryRun) {
      const code = bringCode(info, record, codeSha, true);
      console.log(route.kind === 'append'
        ? 'Conversation: would be added to your original session.'
        : `Conversation: would become a new session, because ${route.reason}.`);
      console.log(code.branch ? `Code: would go on ${code.branch}${code.switched ? ', and be checked out' : ', without touching your files'}.` : 'Code: no changes to bring back.');
      console.log('\nDry run: nothing was changed.');
      return 0;
    }

    const backup = backupSession(file, record.sessionId, home);
    let resumeId = record.sessionId;
    if (saved.bytes.length > 0) {
      if (route.kind === 'append') fs.appendFileSync(file, saved.bytes);
      else resumeId = forkSession(file, record.sessionId, record.baseBytes, saved.bytes).newId;
    }
    const code = bringCode(info, record, codeSha, false);

    const remoteRefs = [record.sync.chatRef, record.sync.codeRef, record.sync.runBranch].filter(Boolean);
    for (const ref of remoteRefs) tryGit(info.root, ['push', info.remote, '--delete', ref]);
    saveHandoffRecord({ ...record, broughtBackAt: new Date().toISOString() }, home);

    console.log(route.kind === 'append'
      ? '\nThe cloud conversation is now in your original session.'
      : `\nThe cloud conversation is in a new session, because ${route.reason}. Your original session wasn't changed.`);
    if (code.branch) {
      console.log(code.switched
        ? `The cloud's code is checked out on ${code.branch}. Your original branch wasn't changed.`
        : `The cloud's code is on ${code.branch}. Your local files changed since the handoff, so Skyhop left them alone. Run: git switch ${code.branch}`);
    } else {
      console.log('The cloud session made no code changes.');
    }
    console.log(`Backup of the original session: ${redactPaths(backup)}`);
    console.log(`\nStop using the cloud session now. To carry on here, run:\n\nclaude --resume ${resumeId}`);
    return 0;
  } finally {
    tryGit(info.root, ['update-ref', '-d', chatRef]);
    tryGit(info.root, ['update-ref', '-d', codeRef]);
  }
}
