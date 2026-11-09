// The project's memory notes go up with a full resume and come back with the session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  applyCloudMemory, memoryDir, memoryEnabled, memoryHashes, memoryPrompt, packMemory, readMemory, unpackMemory,
} from '../scripts/memory.mjs';
import { innerArgs } from '../scripts/relay.mjs';
import { run, tempDir, write } from './helpers.mjs';
import { SESSION, setup } from './roundtrip.mjs';

const INDEX = '- [Deploy](deploy.md) — how this project deploys\n';
const DEPLOY = '---\nname: deploy\ndescription: how this project deploys\nmetadata:\n  type: project\n---\n\nDeploys go through staging first.\n';

test('only markdown notes directly in the folder are read, and names that could leave it are refused', t => {
  const dir = tempDir(t);
  write(dir, 'MEMORY.md', INDEX);
  write(dir, 'deploy.md', DEPLOY);
  write(dir, 'topics/nested.md', 'in a folder\n');
  write(dir, 'notes.txt', 'not markdown\n');
  fs.symlinkSync('/etc/hosts', path.join(dir, 'linked.md'));
  const { files, bytes } = readMemory(dir);
  assert.deepEqual(Object.keys(files).sort(), ['MEMORY.md', 'deploy.md']);
  assert.equal(bytes, Buffer.byteLength(INDEX + DEPLOY));
  assert.deepEqual(unpackMemory(packMemory(files)), files);
  assert.deepEqual(readMemory(path.join(dir, 'missing')), { files: {}, bytes: 0 });

  for (const name of ['../escape.md', '/etc/passwd', 'a/b.md', 'a\\b.md', '.hidden.md', 'authorized_keys', '']) {
    assert.throws(() => unpackMemory(packMemory({ [name]: 'x' })), /damaged/, name);
  }
});

test('the cloud session is told where the notes are, with the start of the index', t => {
  const dir = tempDir(t);
  write(dir, 'MEMORY.md', `${INDEX}${'- another note\n'.repeat(300)}`);
  const prompt = memoryPrompt(dir);
  assert.match(prompt, new RegExp(`notes from the user's computer are in ${dir}`));
  assert.match(prompt, /To save a memory, write it as its own markdown file/);
  assert.ok(prompt.includes(INDEX.trim()));
  assert.equal(prompt.split('\n').filter(line => line === '- another note').length, 199);

  const args = innerArgs(SESSION, 'auto', dir);
  assert.deepEqual(args.slice(0, 5), ['-p', '--resume', SESSION, '--permission-mode', 'auto']);
  assert.deepEqual(args.slice(5, 7), ['--add-dir', dir]);
  assert.equal(args[7], '--append-system-prompt');
  assert.equal(args[8], prompt);
  assert.ok(!innerArgs(SESSION, 'auto').includes('--add-dir'));
  write(dir, 'MEMORY.md', '');
  assert.match(memoryPrompt(dir), /MEMORY\.md is empty so far/);
});

test("the cloud's changes come home, and a note changed on both sides keeps this Mac's version", t => {
  const dir = tempDir(t);
  const aside = path.join(dir, '..', 'aside');
  const start = { 'MEMORY.md': INDEX, 'deploy.md': DEPLOY, 'old.md': 'old\n', 'both.md': 'v1\n', 'mine.md': 'mine\n' };
  for (const [name, text] of Object.entries(start)) write(dir, name, text);
  const base = memoryHashes(start);
  write(dir, 'both.md', 'changed on the Mac\n');
  write(dir, 'mine.md', 'changed on the Mac too\n');

  const cloud = { 'MEMORY.md': `${INDEX}- new\n`, 'deploy.md': DEPLOY, 'both.md': 'changed in the cloud\n', 'new.md': 'new\n' };
  const done = applyCloudMemory({ dir, base, cloud, aside });
  assert.deepEqual(done.added, ['new.md']);
  assert.deepEqual(done.updated, ['MEMORY.md']);
  assert.deepEqual(done.removed, ['old.md']);
  assert.deepEqual(done.kept, ['both.md']);
  assert.deepEqual(readMemory(dir).files, {
    'MEMORY.md': `${INDEX}- new\n`, 'both.md': 'changed on the Mac\n', 'deploy.md': DEPLOY, 'mine.md': 'changed on the Mac too\n', 'new.md': 'new\n',
  });
  assert.equal(fs.readFileSync(path.join(aside, 'both.md'), 'utf8'), 'changed in the cloud\n');

  // Applying the same save again changes nothing.
  const again = applyCloudMemory({ dir, base: done.base, cloud, aside });
  assert.deepEqual([again.added, again.updated, again.removed, again.kept], [[], [], [], []]);
});

test('auto memory turned off on the Mac stays off, and the folder follows the settings', t => {
  const home = tempDir(t);
  const root = path.join(home, 'repo');
  fs.mkdirSync(root);
  run(root, 'init', '-q');
  const transcriptPath = path.join(home, '.claude/projects/some-project/x.jsonl');
  assert.equal(memoryEnabled({ root, home, env: {} }), true);
  assert.equal(memoryEnabled({ root, home, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' } }), false);
  write(home, '.claude/settings.json', JSON.stringify({ autoMemoryEnabled: false }));
  assert.equal(memoryEnabled({ root, home, env: {} }), false);
  // A repository's settings can't turn it back on.
  write(root, '.claude/settings.local.json', JSON.stringify({ autoMemoryEnabled: true }));
  assert.equal(memoryEnabled({ root, home, env: {} }), false);
  write(home, '.claude/settings.json', '{}');
  write(root, '.claude/settings.json', JSON.stringify({ autoMemoryEnabled: false }));
  assert.equal(memoryEnabled({ root, home, env: {} }), false);

  assert.equal(memoryDir({ transcriptPath, root, home }), path.join(home, '.claude/projects/some-project/memory'));
  const shared = path.join(home, '.claude/projects', root.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  fs.mkdirSync(shared, { recursive: true });
  assert.equal(memoryDir({ transcriptPath, root, home }), shared);
  fs.mkdirSync(path.dirname(transcriptPath) + '/memory', { recursive: true });
  assert.equal(memoryDir({ transcriptPath, root, home }), path.join(home, '.claude/projects/some-project/memory'));
  // Only the user's own settings can move the folder.
  write(root, '.claude/settings.json', JSON.stringify({ autoMemoryDirectory: '~/.ssh' }));
  write(root, '.claude/settings.local.json', JSON.stringify({ autoMemoryDirectory: '~/.ssh' }));
  assert.equal(memoryDir({ transcriptPath, root, home }), path.join(home, '.claude/projects/some-project/memory'));
  write(home, '.claude/settings.json', JSON.stringify({ autoMemoryDirectory: '~/notes' }));
  assert.equal(memoryDir({ transcriptPath, root, home }), path.join(home, 'notes'));
});

test('a note that is a link on this Mac is never written through', t => {
  const dir = tempDir(t);
  const target = path.join(dir, '..', 'elsewhere.txt');
  fs.writeFileSync(target, 'untouched\n');
  fs.symlinkSync(target, path.join(dir, 'deploy.md'));
  const done = applyCloudMemory({ dir, base: {}, cloud: { 'deploy.md': 'from the cloud\n' }, aside: path.join(dir, '..', 'aside') });
  assert.deepEqual(done.kept, ['deploy.md']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n');
  assert.equal(fs.readFileSync(path.join(dir, '..', 'aside', 'deploy.md'), 'utf8'), 'from the cloud\n');
});

// The fake session file sits in .claude/projects/some-project, so its notes do too.
function withNotes(t, notes = { 'MEMORY.md': INDEX, 'deploy.md': DEPLOY }) {
  const context = setup(t);
  const dir = path.join(context.home, '.claude/projects/some-project/memory');
  for (const [name, text] of Object.entries(notes)) write(dir, name, text);
  const vmNotes = path.join(context.base, 'vm-home/.skyhop/memory', SESSION);
  return { ...context, dir, vmNotes };
}

const start = { source: 'startup', session_id: 'aaaaaaaa-0000-4000-8000-000000000000' };
const resume = { source: 'resume', session_id: SESSION };
const prompt = { session_id: SESSION, prompt: 'hello again' };

test("the notes go up encrypted, the cloud's new notes come home, and the plan says so", t => {
  const { skyhop, briefFile, handOff, cloudWork, hook, dir, vmNotes, bare, record } = withNotes(t);
  const plan = skyhop(['--brief', briefFile, '--session', SESSION, '--dry-run']);
  assert.match(plan.output, /Memory: {5}2 memory note\(s\) from this project go along, encrypted/);

  const vm = handOff();
  assert.ok(fs.existsSync(path.join(vm, '.skyhop/memory.enc')));
  assert.ok(!fs.existsSync(path.join(vm, '.skyhop/memory.json')));
  const pushed = run(bare, 'log', '--all', '-p', '--format=%H');
  assert.ok(!pushed.includes('Deploys go through staging'));

  cloudWork(vm, { notes: { 'MEMORY.md': `${INDEX}- [Colour](colour.md) — deploy colour\n`, 'colour.md': 'The deploy colour is blue.\n' } });
  assert.deepEqual(readMemory(vmNotes).files['colour.md'], 'The deploy colour is blue.\n');
  assert.ok(!run(bare, 'log', '--all', '-p', '--format=%H').includes('deploy colour is blue'));

  const out = hook('start', start);
  assert.match(out.systemMessage, /Memory notes changed in the cloud are here now: colour\.md, MEMORY\.md\./);
  assert.equal(fs.readFileSync(path.join(dir, 'colour.md'), 'utf8'), 'The deploy colour is blue.\n');

  // A note edited on the Mac after the update is left alone when the session comes home.
  hook('start', resume);
  write(dir, 'deploy.md', 'Edited on the Mac.\n');
  const home = hook('prompt', prompt);
  assert.match(home.systemMessage, /back from the cloud/);
  assert.ok(record().broughtBackAt);
  assert.equal(fs.readFileSync(path.join(dir, 'deploy.md'), 'utf8'), 'Edited on the Mac.\n');
});

test('notes from a later cloud reply come with the next update, or with the first message when both sides kept going', t => {
  const { handOff, cloudWork, hook, dir, vm } = withNotes(t);
  cloudWork(handOff());
  hook('start', start);
  hook('start', resume);
  cloudWork(vm, { prompt: 'one more', code: false, notes: { 'deploy.md': 'Deploys skip staging now.\n' } });
  assert.match(hook('start', start).systemMessage, /Memory notes changed in the cloud are here now: deploy\.md/);
  assert.equal(fs.readFileSync(path.join(dir, 'deploy.md'), 'utf8'), 'Deploys skip staging now.\n');
  hook('start', resume);
  const out = hook('prompt', prompt);
  assert.doesNotMatch(out.systemMessage, /Memory notes/);

  const both = withNotes(t);
  both.cloudWork(both.handOff());
  both.hook('start', start);
  both.hook('start', resume);
  fs.appendFileSync(both.localSession, `{"type":"user","sessionId":"${SESSION}","message":{"content":"typed on the Mac"}}\n`);
  both.cloudWork(both.vm, { prompt: 'one more', code: false, notes: { 'deploy.md': 'Deploys skip staging now.\n' } });
  const forked = both.hook('prompt', prompt);
  assert.match(forked.systemMessage, /separate session/);
  assert.match(forked.systemMessage, /Memory notes changed in the cloud are here now: deploy\.md/);
  assert.match(forked.hookSpecificOutput.additionalContext, /newer than what this window loaded: deploy\.md/);
  assert.equal(fs.readFileSync(path.join(both.dir, 'deploy.md'), 'utf8'), 'Deploys skip staging now.\n');
});

test('with auto memory off on the Mac, no notes go and the cloud session gets none', t => {
  const { skyhop, briefFile, handOff, cloudWork, vmNotes } = withNotes(t);
  const off = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  assert.match(skyhop(['--brief', briefFile, '--session', SESSION, '--dry-run'], off).output, /auto memory is off here, so no notes go along/);
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  try {
    const vm = handOff();
    assert.ok(!fs.existsSync(path.join(vm, '.skyhop/memory.enc')));
    cloudWork(vm);
    assert.ok(!fs.existsSync(vmNotes));
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY;
  }
});

test('a likely secret in a note stops the handoff', t => {
  const { skyhop, briefFile } = withNotes(t, { 'MEMORY.md': INDEX, 'keys.md': 'The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' });
  const result = skyhop(['--brief', briefFile, '--session', SESSION, '--yes']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /memory note keys\.md/);
  assert.match(result.output, /Nothing left this machine/);
});

test('a likely secret written to a note in the cloud is not saved to GitHub', t => {
  const { handOff, cloudWork, bare } = withNotes(t);
  const reply = cloudWork(handOff(), { check: false, notes: { 'keys.md': 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' } });
  assert.match(reply, /did not save the memory notes to GitHub, because it found a likely secret in memory note keys\.md/);
  const chat = run(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/skyhop-sync');
  assert.ok(chat.includes('-chat'));
  assert.equal(run(bare, 'ls-tree', '-r', '--name-only', chat.split('\n').find(name => name.endsWith('-chat'))).includes('memory.enc'), false);
});

test('a cloud machine that was cleared gets the notes from the last save, not the handoff', t => {
  const { base, bare, handOff, cloudWork, vmNotes, record } = withNotes(t);
  cloudWork(handOff(), { notes: { 'colour.md': 'blue\n' } });
  // A fresh VM, cloned from the chat's start branch, with nothing left from before.
  const fresh = path.join(base, 'fresh-vm');
  run(base, 'clone', '-q', '--branch', record().sync.runBranch, bare, fresh);
  fs.rmSync(path.join(base, 'vm-home'), { recursive: true, force: true });
  cloudWork(fresh, { code: false });
  assert.equal(fs.readFileSync(path.join(vmNotes, 'colour.md'), 'utf8'), 'blue\n');
  assert.equal(fs.readFileSync(path.join(vmNotes, 'deploy.md'), 'utf8'), DEPLOY);
});
