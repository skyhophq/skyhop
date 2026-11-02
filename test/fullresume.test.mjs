import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addRelayCommit, findTranscript, MAX_TRANSCRIPT_BYTES, mergeSettings } from '../scripts/fullresume.mjs';
import { RELAY_COMMIT_MARKER, scrubRelayCommit } from '../scripts/relay.mjs';
import { makeRepo, run, tempDir, write } from './helpers.mjs';

const SESSION = '11111111-2222-3333-4444-555555555555';

function relayRepo(t, settings) {
  const { root, base } = makeRepo(t, { remote: false });
  if (settings !== undefined) {
    write(root, '.claude/settings.json', settings);
    run(root, 'add', '-A');
    run(root, 'commit', '-q', '-m', 'settings');
  }
  const parent = run(root, 'rev-parse', 'HEAD');
  const transcriptPath = path.join(base, 'session.jsonl');
  fs.writeFileSync(transcriptPath, '{"type":"user"}\n');
  addRelayCommit(root, { transcript: { path: transcriptPath, bytes: 16 }, sessionId: SESSION, mode: 'auto', brief: '## Goal\nShip it.' });
  return { root, parent };
}

test('finds a transcript in any project folder', t => {
  const root = tempDir(t);
  write(root, 'project-a/other.jsonl', 'x');
  write(root, `project-b/${SESSION}.jsonl`, '12345');
  assert.deepEqual(findTranscript(SESSION, root), { path: path.join(root, `project-b/${SESSION}.jsonl`), bytes: 5 });
});

test('a missing transcript or session ID points to the brief handoff', t => {
  assert.throws(() => findTranscript(SESSION, tempDir(t)), error => /not found/.test(error.message) && /without --full-resume/.test(error.hint));
  assert.throws(() => findTranscript(undefined, tempDir(t)), /needs the session ID/);
});

test('an oversized transcript is refused', t => {
  const root = tempDir(t);
  const file = path.join(root, 'project', `${SESSION}.jsonl`);
  write(root, `project/${SESSION}.jsonl`, '');
  fs.truncateSync(file, MAX_TRANSCRIPT_BYTES + 1);
  assert.throws(() => findTranscript(SESSION, root), /capped at 100 MB/);
});

test('the hook is added to an empty settings file', () => {
  const settings = JSON.parse(mergeSettings(null));
  const [entry] = settings.hooks.UserPromptSubmit;
  assert.match(entry.hooks[0].command, /\.skyhop\/relay\.mjs/);
  assert.equal(entry.hooks[0].onFailure, 'block');
  assert.equal(settings.model, 'haiku');
});

test('existing settings and hooks are kept', () => {
  const existing = JSON.stringify({
    model: 'opus',
    permissions: { deny: ['Read(./.env)'] },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'mine' }] }], Stop: [{ hooks: [] }] },
  });
  const settings = JSON.parse(mergeSettings(existing));
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.permissions, { deny: ['Read(./.env)'] });
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'mine');
  assert.ok(settings.hooks.Stop);
});

test('broken settings give a clear error', () => {
  assert.throws(() => mergeSettings('{ nope'), /not valid JSON/);
});

test('the relay commit carries everything the VM needs', t => {
  const { root } = relayRepo(t);
  const files = run(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  for (const file of ['.skyhop/session.jsonl', '.skyhop/relay.mjs', '.skyhop/session-id', '.skyhop/mode', '.skyhop/brief.md', '.claude/settings.json']) {
    assert.ok(files.includes(file), file);
  }
  assert.match(run(root, 'log', '-1', '--format=%B'), new RegExp(RELAY_COMMIT_MARKER));
  assert.equal(run(root, 'show', 'HEAD:.skyhop/mode'), 'auto');
});

test('the relay commit is added even when .claude is gitignored', t => {
  const { root } = makeRepo(t, { remote: false });
  write(root, '.gitignore', '.claude/\n.skyhop/\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'ignore');
  const file = path.join(root, '..', 'session.jsonl');
  fs.writeFileSync(file, 'x\n');
  addRelayCommit(root, { transcript: { path: file, bytes: 2 }, sessionId: SESSION, mode: 'auto', brief: 'b' });
  assert.match(run(root, 'ls-tree', '-r', '--name-only', 'HEAD'), /\.skyhop\/session\.jsonl/);
});

test('scrubbing removes the commit, keeps the files, and hides them from git', t => {
  const { root, parent } = relayRepo(t);
  assert.equal(scrubRelayCommit(root), null);

  assert.equal(run(root, 'rev-parse', 'HEAD'), parent);
  assert.ok(fs.existsSync(path.join(root, '.skyhop/session.jsonl')));
  assert.ok(fs.existsSync(path.join(root, '.claude/settings.json')));
  assert.equal(run(root, 'status', '--porcelain'), '');
  run(root, 'add', '-A');
  assert.equal(run(root, 'diff', '--cached', '--name-only'), '');
});

test('later work and pushes cannot carry the transcript', t => {
  const { root, parent } = relayRepo(t);
  scrubRelayCommit(root);
  write(root, 'work.txt', 'done\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'work');
  assert.equal(run(root, 'rev-parse', 'HEAD~1'), parent);
  const files = run(root, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n');
  assert.deepEqual(files.filter(file => file.startsWith('.skyhop') || file.startsWith('.claude')), []);
});

test('a tracked settings file keeps its committed version in later commits', t => {
  const { root, parent } = relayRepo(t, '{ "permissions": {} }\n');
  scrubRelayCommit(root);
  assert.equal(run(root, 'rev-parse', 'HEAD'), parent);
  assert.match(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), /relay\.mjs/);
  assert.equal(run(root, 'status', '--porcelain'), '');

  write(root, 'work.txt', 'done\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'work');
  assert.doesNotMatch(run(root, 'show', 'HEAD:.claude/settings.json'), /relay\.mjs/);
});

test('scrubbing runs once', t => {
  const { root, parent } = relayRepo(t);
  scrubRelayCommit(root);
  write(root, 'work.txt', `${RELAY_COMMIT_MARKER}\n`);
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', RELAY_COMMIT_MARKER);
  scrubRelayCommit(root);
  assert.equal(run(root, 'rev-parse', 'HEAD~1'), parent);
});

test('warns when the transcript cannot be taken out of history', t => {
  const { root } = relayRepo(t);
  write(root, 'work.txt', 'on top\n');
  run(root, 'add', 'work.txt');
  run(root, 'commit', '-q', '-m', 'someone committed on top');
  assert.match(scrubRelayCommit(root), /Do not push this branch/);
});
