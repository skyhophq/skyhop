// Adds the session transcript and relay to the launch folder, for --full-resume.
// With sync on, this commit goes to GitHub with the transcript encrypted, so the
// cloud session is linked to the repo and can push. With no remote, it's uploaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { git, SkyhopError, tryGit } from './git.mjs';
import { skyhopVersion } from './log.mjs';
import { RELAY_COMMIT_MARKER, WAIT_COMMAND } from './relay.mjs';
import { packMemory } from './memory.mjs';
import { HISTORY_NAME, sealHistory, sealMemory, sealTranscript } from './sync.mjs';

// A direct upload is capped at 100 MB after compression, shared with the repository.
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
// The secret scan holds the transcript in memory, and strings stop at about 512 MB.
export const MAX_TRANSCRIPT_BYTES = 400 * 1024 * 1024;
export const LARGE_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

// The hook only starts each message, and the work runs in the background. A hook
// that hangs is stopped well before the cloud would stop the whole VM, at about 25
// minutes with no activity.
const HOOK_TIMEOUT_SECONDS = 1200;
const RELAY_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.skyhop/relay.mjs"';
// Claude in the chat runs this over and over while a message is worked on, so it
// must never stop for approval.
const WAIT_RULE = `Bash(${WAIT_COMMAND})`;
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
// Everything the relay needs in the VM, where the plugin isn't installed.
export const VM_SCRIPTS = ['log.mjs', 'memory.mjs', 'relay.mjs', 'replay.mjs', 'secrets.mjs', 'sync.mjs'];

function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

export function findTranscript(sessionId, root = projectsDir()) {
  if (!sessionId) throw new SkyhopError('A full resume needs the session ID.', 'Run this through /skyhop, which passes it.');
  const name = `${sessionId}.jsonl`;
  const folders = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const match = folders.map(folder => path.join(root, folder, name)).find(file => fs.existsSync(file));
  if (!match) throw new SkyhopError(`The transcript for session ${sessionId} was not found.`, 'Run /skyhop --summary to hand off with a summary instead.');

  const bytes = fs.statSync(match).size;
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    throw new SkyhopError(
      `The session transcript is ${Math.round(bytes / 1e6)} MB, which is too large to scan and upload.`,
      'Run /skyhop --summary to hand off with a summary instead.',
    );
  }
  return { path: match, bytes };
}

// Git compresses what it uploads, so the raw transcript size overstates the upload.
export function measureUpload(transcript, repoBytes, limit = MAX_UPLOAD_BYTES) {
  const compressed = zlib.deflateSync(fs.readFileSync(transcript.path)).length;
  if (compressed + repoBytes > limit) {
    const mb = bytes => Math.round(bytes / 1e6);
    throw new SkyhopError(
      `This upload would be about ${mb(compressed + repoBytes)} MB (transcript ${mb(compressed)} MB, repository ${mb(repoBytes)} MB), and uploads are capped at 100 MB.`,
      'Run /skyhop --summary to hand off with a summary instead.',
    );
  }
  return compressed;
}

// The outer session only repeats replies, so it can run on a small model. A
// resumed session keeps the model it was using.
export function mergeSettings(existing) {
  let settings = {};
  if (existing !== null) {
    try {
      settings = JSON.parse(existing);
    } catch {
      throw new SkyhopError('.claude/settings.json is not valid JSON.', 'Fix that file, then run /skyhop again.');
    }
  }
  const hooks = settings.hooks ?? {};
  const permissions = settings.permissions ?? {};
  const entry = { hooks: [{ type: 'command', command: RELAY_COMMAND, timeout: HOOK_TIMEOUT_SECONDS, onFailure: 'block' }] };
  return `${JSON.stringify({
    ...settings,
    model: settings.model ?? 'haiku',
    permissions: { ...permissions, allow: [...(permissions.allow ?? []), WAIT_RULE] },
    hooks: { ...hooks, UserPromptSubmit: [...(hooks.UserPromptSubmit ?? []), entry] },
  }, null, 2)}\n`;
}

// Returns the size of the transcript copy, which is where /skyhop-back picks up.
// The live session keeps writing to the original, so this can't be read beforehand.
// `memory` is the project's notes, or null when auto memory is off on this Mac.
// `history` is what the chat replays as real messages, or null. It needs sync, for the key.
export function addRelayCommit(dir, { transcript, sessionId, mode, brief, sync, key, memory = null, history = null }) {
  const skyhop = path.join(dir, '.skyhop');
  fs.mkdirSync(skyhop, { recursive: true });
  const bytes = fs.readFileSync(transcript.path);
  if (sync) {
    sealTranscript(bytes, key).forEach((part, index) => {
      fs.writeFileSync(path.join(skyhop, `session.enc.${String(index).padStart(3, '0')}`), part);
    });
  } else {
    fs.writeFileSync(path.join(skyhop, 'session.jsonl'), bytes);
  }
  if (memory && sync) fs.writeFileSync(path.join(skyhop, 'memory.enc'), sealMemory(packMemory(memory), key));
  else if (memory) fs.writeFileSync(path.join(skyhop, 'memory.json'), packMemory(memory));
  if (history && sync) {
    fs.writeFileSync(path.join(skyhop, HISTORY_NAME), sealHistory(history, key));
    fs.cpSync(path.join(SCRIPTS, 'chat-plugin'), path.join(skyhop, 'chat-plugin'), { recursive: true });
  }
  for (const script of VM_SCRIPTS) fs.copyFileSync(path.join(SCRIPTS, script), path.join(skyhop, script));
  fs.writeFileSync(path.join(skyhop, 'session-id'), `${sessionId}\n`);
  fs.writeFileSync(path.join(skyhop, 'version'), `${skyhopVersion()}\n`);
  fs.writeFileSync(path.join(skyhop, 'mode'), `${mode}\n`);
  // With sync on, the start branch is on GitHub, where everything about the
  // conversation is encrypted. The brief is in the chat's first message anyway.
  if (!sync) fs.writeFileSync(path.join(skyhop, 'brief.md'), `${brief}\n`);
  if (sync) fs.writeFileSync(path.join(skyhop, 'sync.json'), JSON.stringify({ ...sync, baseBytes: bytes.length }));

  const settingsFile = path.join(dir, '.claude/settings.json');
  const existing = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, mergeSettings(existing));

  git(dir, ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'add', '-f', '.skyhop', '.claude/settings.json']);
  const name = tryGit(dir, ['config', 'user.name']) || 'Skyhop';
  const email = tryGit(dir, ['config', 'user.email']) || 'skyhop@localhost';
  git(dir, [
    '-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'core.hooksPath=/dev/null',
    'commit', '-q', '--no-verify', '--no-gpg-sign', '-m', `Skyhop relay files\n\n${RELAY_COMMIT_MARKER}`,
  ]);
  return bytes.length;
}
