// Adds the session transcript and relay to the launch folder, for --full-resume.
// This commit is never pushed. It reaches the VM in the direct upload.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, SkyhopError, tryGit } from './git.mjs';
import { RELAY_COMMIT_MARKER } from './relay.mjs';

// The direct upload is capped at 100 MB, and the repository shares that limit.
export const MAX_TRANSCRIPT_BYTES = 95 * 1024 * 1024;
export const LARGE_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

const HOOK_TIMEOUT_SECONDS = 3600;
const RELAY_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.skyhop/relay.mjs"';
const RELAY_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'relay.mjs');

function projectsDir() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

export function findTranscript(sessionId, root = projectsDir()) {
  if (!sessionId) throw new SkyhopError('--full-resume needs the session ID.', 'Run this through /skyhop, which passes it.');
  const name = `${sessionId}.jsonl`;
  const folders = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const match = folders.map(folder => path.join(root, folder, name)).find(file => fs.existsSync(file));
  if (!match) throw new SkyhopError(`The transcript for session ${sessionId} was not found.`, 'Run /skyhop without --full-resume to use the brief handoff.');

  const bytes = fs.statSync(match).size;
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    throw new SkyhopError(
      `The session transcript is ${Math.round(bytes / 1e6)} MB, and uploads are capped at 100 MB.`,
      'Run /skyhop without --full-resume to use the brief handoff.',
    );
  }
  return { path: match, bytes };
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
  const entry = { hooks: [{ type: 'command', command: RELAY_COMMAND, timeout: HOOK_TIMEOUT_SECONDS, onFailure: 'block' }] };
  return `${JSON.stringify({
    ...settings,
    model: settings.model ?? 'haiku',
    hooks: { ...hooks, UserPromptSubmit: [...(hooks.UserPromptSubmit ?? []), entry] },
  }, null, 2)}\n`;
}

export function addRelayCommit(dir, { transcript, sessionId, mode, brief }) {
  const skyhop = path.join(dir, '.skyhop');
  fs.mkdirSync(skyhop, { recursive: true });
  fs.copyFileSync(transcript.path, path.join(skyhop, 'session.jsonl'));
  fs.copyFileSync(RELAY_SOURCE, path.join(skyhop, 'relay.mjs'));
  fs.writeFileSync(path.join(skyhop, 'session-id'), `${sessionId}\n`);
  fs.writeFileSync(path.join(skyhop, 'mode'), `${mode}\n`);
  fs.writeFileSync(path.join(skyhop, 'brief.md'), `${brief}\n`);

  const settingsFile = path.join(dir, '.claude/settings.json');
  const existing = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, mergeSettings(existing));

  git(dir, ['add', '-f', '.skyhop', '.claude/settings.json']);
  const name = tryGit(dir, ['config', 'user.name']) || 'Skyhop';
  const email = tryGit(dir, ['config', 'user.email']) || 'skyhop@localhost';
  git(dir, [
    '-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'core.hooksPath=/dev/null',
    'commit', '-q', '--no-verify', '--no-gpg-sign', '-m', `Skyhop relay files\n\n${RELAY_COMMIT_MARKER}`,
  ]);
}
