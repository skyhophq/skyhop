import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isSensitivePath, scanDiff } from '../scripts/secrets.mjs';
import { newKey, openChunk, openTranscript, readChunks, restoreProgress, saveProgress, sealChunk, sealTranscript } from '../scripts/sync.mjs';
import { makeRepo, run, write } from './helpers.mjs';

const FAKE_TOKEN = `gh${'p'}_${'a'.repeat(36)}`;
const BASE = '{"line":"from the Mac"}\n';

function vm(t) {
  const { root, bare, base } = makeRepo(t);
  const key = newKey();
  const transcript = path.join(base, 'session.jsonl');
  fs.writeFileSync(transcript, BASE);
  const config = {
    chatRef: 'skyhop-sync/test-chat', codeRef: 'skyhop-sync/test-code', baseBytes: BASE.length,
    snapshotTree: run(root, 'rev-parse', 'HEAD^{tree}'),
  };
  write(root, '.skyhop/sync.json', JSON.stringify(config));
  write(root, '.skyhop/sync-key', `${key}\n`);
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.skyhop/\n');
  const save = options => saveProgress({ root, transcript, isExcluded: isSensitivePath, scan: scanDiff, ...options });
  const remoteRef = ref => {
    try {
      return run(bare, 'rev-parse', '--verify', `refs/heads/${ref}`);
    } catch {
      return null;
    }
  };
  return { root, bare, key, transcript, config, save, remoteRef };
}

const chunk = { from: 5, to: 9, bytes: Buffer.from('some private text') };

test('a chunk round-trips through encryption', () => {
  const key = newKey();
  const opened = openChunk(sealChunk(chunk, key, 1), key, 1);
  assert.equal(opened.from, 5);
  assert.equal(opened.to, 9);
  assert.equal(opened.bytes.toString(), 'some private text');
});

test('the stored chunk does not contain the conversation', () => {
  assert.ok(!sealChunk(chunk, newKey(), 1).includes('private'));
});

test('a changed chunk, a wrong key, or a reordered chunk is refused', () => {
  const key = newKey();
  const sealed = sealChunk(chunk, key, 1);
  const changed = Buffer.from(sealed);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => openChunk(changed, key, 1));
  assert.throws(() => openChunk(sealed, newKey(), 1));
  assert.throws(() => openChunk(sealed, key, 2));
});

test('a transcript splits into parts and comes back whole', () => {
  const key = newKey();
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => `line ${i}\n`).join(''));
  const parts = sealTranscript(bytes, key, 500);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 500));
  assert.deepEqual(openTranscript(parts, key), bytes);
  assert.throws(() => openTranscript(parts.slice(1), key));
});

test('with no key it warns instead of failing', t => {
  const { root, transcript, save } = vm(t);
  fs.rmSync(path.join(root, '.skyhop/sync-key'));
  fs.appendFileSync(transcript, '{"line":"x"}\n');
  assert.match(save(), /key is missing/);
});

test('with no sync settings it does nothing', t => {
  const { root, transcript, config } = vm(t);
  fs.rmSync(path.join(root, '.skyhop/sync.json'));
  assert.equal(saveProgress({ root, transcript }), null);
  assert.ok(config);
});

test('only the new lines go up, and they are encrypted', t => {
  const { root, bare, key, transcript, config, save, remoteRef } = vm(t);
  fs.appendFileSync(transcript, '{"line":"from the cloud"}\n');
  assert.equal(save(), null);

  const tip = remoteRef(config.chatRef);
  assert.ok(tip);
  assert.ok(!run(bare, 'cat-file', '-p', `${tip}:chunks/000001.enc`).includes('from the cloud'));
  run(root, 'fetch', '-q', 'origin', config.chatRef);
  const saved = readChunks(root, run(root, 'rev-parse', 'FETCH_HEAD'), key, BASE.length);
  assert.equal(saved.bytes.toString(), '{"line":"from the cloud"}\n');
});

test('a half-written line waits for the next save', t => {
  const { root, key, transcript, config, save } = vm(t);
  fs.appendFileSync(transcript, '{"a":1}\n{"b":');
  save();
  fs.appendFileSync(transcript, '2}\n');
  save();
  run(root, 'fetch', '-q', 'origin', config.chatRef);
  const saved = readChunks(root, run(root, 'rev-parse', 'FETCH_HEAD'), key, BASE.length);
  assert.equal(saved.bytes.toString(), '{"a":1}\n{"b":2}\n');
  assert.equal(saved.count, 2);
});

test('nothing new means nothing is pushed', t => {
  const { config, save, remoteRef } = vm(t);
  assert.equal(save(), null);
  assert.equal(remoteRef(config.chatRef), null);
  assert.equal(remoteRef(config.codeRef), null);
});

test('code changes go up without touching the session index', t => {
  const { root, bare, config, save, remoteRef } = vm(t);
  write(root, 'tracked.txt', 'changed in the cloud\n');
  write(root, 'new.txt', 'new in the cloud\n');
  const index = fs.readFileSync(path.join(root, '.git/index'));
  assert.equal(save(), null);

  assert.deepEqual(fs.readFileSync(path.join(root, '.git/index')), index);
  const tip = remoteRef(config.codeRef);
  assert.equal(run(bare, 'show', `${tip}:tracked.txt`), 'changed in the cloud');
  assert.equal(run(bare, 'show', `${tip}:new.txt`), 'new in the cloud');
  assert.ok(!run(bare, 'ls-tree', '-r', '--name-only', tip).includes('.skyhop'));
});

test('commits made in the cloud are carried along', t => {
  const { root, bare, config, save, remoteRef } = vm(t);
  write(root, 'tracked.txt', 'committed in the cloud\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'cloud commit');
  save();
  assert.match(run(bare, 'log', '--format=%s', remoteRef(config.codeRef)), /cloud commit/);
});

test('later saves build on earlier ones without force-pushing', t => {
  const { root, bare, config, save, remoteRef } = vm(t);
  write(root, 'tracked.txt', 'one\n');
  save();
  const first = remoteRef(config.codeRef);
  write(root, 'tracked.txt', 'two\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'in between');
  write(root, 'tracked.txt', 'three\n');
  assert.equal(save(), null);
  const second = remoteRef(config.codeRef);
  assert.notEqual(second, first);
  run(bare, 'merge-base', '--is-ancestor', first, second);
  assert.equal(run(bare, 'show', `${second}:tracked.txt`), 'three');
});

test('.env-style files stay out of the code save', t => {
  const { root, bare, config, save, remoteRef } = vm(t);
  write(root, '.env', 'NAME=value\n');
  write(root, 'tracked.txt', 'changed\n');
  save();
  assert.ok(!run(bare, 'ls-tree', '-r', '--name-only', remoteRef(config.codeRef)).split('\n').includes('.env'));
});

test('a secret holds back the code, but the conversation is still saved', t => {
  const { root, transcript, config, save, remoteRef } = vm(t);
  write(root, 'config.js', `const key = "${FAKE_TOKEN}";\n`);
  fs.appendFileSync(transcript, '{"line":"cloud"}\n');
  assert.match(save(), /likely secret in config\.js/);
  assert.equal(remoteRef(config.codeRef), null);
  assert.ok(remoteRef(config.chatRef));
});

test('a failed push warns and retries on the next message', t => {
  const { root, key, transcript, config, save, remoteRef } = vm(t);
  const url = run(root, 'remote', 'get-url', 'origin');
  run(root, 'remote', 'set-url', 'origin', '/nowhere/at/all.git');
  fs.appendFileSync(transcript, '{"line":"one"}\n');
  assert.match(save(), /will try again on your next message/);
  assert.equal(remoteRef(config.chatRef), null);

  run(root, 'remote', 'set-url', 'origin', url);
  fs.appendFileSync(transcript, '{"line":"two"}\n');
  assert.equal(save(), null);
  run(root, 'fetch', '-q', 'origin', config.chatRef);
  const saved = readChunks(root, run(root, 'rev-parse', 'FETCH_HEAD'), key, BASE.length);
  assert.equal(saved.bytes.toString(), '{"line":"one"}\n{"line":"two"}\n');
  assert.equal(saved.count, 1);
});

test('the URL is the fallback when the VM has no origin', t => {
  const { root, transcript, config, save, remoteRef } = vm(t);
  const url = run(root, 'remote', 'get-url', 'origin');
  run(root, 'remote', 'remove', 'origin');
  fs.writeFileSync(path.join(root, '.skyhop/sync.json'), JSON.stringify({ ...config, remoteUrl: url }));
  fs.appendFileSync(transcript, '{"line":"cloud"}\n');
  assert.equal(save(), null);
  assert.ok(remoteRef(config.chatRef));
});

test('a cleared VM gets its saved conversation back, and saving carries on', t => {
  const { root, key, transcript, config, save } = vm(t);
  fs.appendFileSync(transcript, '{"line":"one"}\n');
  save();
  fs.appendFileSync(transcript, '{"line":"two"}\n');
  save();

  fs.rmSync(path.join(root, '.skyhop/sync-state.json'));
  fs.writeFileSync(transcript, BASE);
  assert.equal(restoreProgress({ root, transcript }), true);
  assert.equal(fs.readFileSync(transcript, 'utf8'), `${BASE}{"line":"one"}\n{"line":"two"}\n`);

  fs.appendFileSync(transcript, '{"line":"three"}\n');
  assert.equal(save(), null);
  run(root, 'fetch', '-q', 'origin', config.chatRef);
  const saved = readChunks(root, run(root, 'rev-parse', 'FETCH_HEAD'), key, BASE.length);
  assert.match(saved.bytes.toString(), /three/);
  assert.equal(saved.count, 3);
});

test('restoring does nothing when the VM still has its progress', t => {
  const { root, transcript, save } = vm(t);
  fs.appendFileSync(transcript, '{"line":"one"}\n');
  save();
  assert.equal(restoreProgress({ root, transcript }), false);
});

test('a gap in the saved chunks is refused', t => {
  const { root, key, transcript, config, save } = vm(t);
  fs.appendFileSync(transcript, '{"line":"one"}\n');
  save();
  run(root, 'fetch', '-q', 'origin', config.chatRef);
  assert.throws(() => readChunks(root, run(root, 'rev-parse', 'FETCH_HEAD'), key, BASE.length + 1), /gap/);
});
