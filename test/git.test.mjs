import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  createSnapshot, launchDir, maskUrl, pendingCommitCount, pendingDiff, prepareLaunchFolder,
  pushBranch, removeLaunchFolder, repoInfo, skyhopBranch,
} from '../scripts/git.mjs';
import { isSensitivePath } from '../scripts/secrets.mjs';
import { dirty, fingerprint, makeRepo, run, tempDir, write } from './helpers.mjs';

const snapshot = info => createSnapshot(info, { isExcluded: isSensitivePath, message: 'snapshot' });

test('a snapshot leaves the working tree, index and refs byte-for-byte unchanged', t => {
  const { root } = makeRepo(t);
  dirty(root);
  const before = fingerprint(root);
  snapshot(repoInfo(root));
  assert.deepEqual(fingerprint(root), before);
});

test('a snapshot holds tracked, staged and untracked changes', t => {
  const { root } = makeRepo(t);
  dirty(root);
  const { sha } = snapshot(repoInfo(root));
  assert.equal(run(root, 'show', `${sha}:tracked.txt`), 'changed');
  assert.equal(run(root, 'show', `${sha}:staged.txt`), 'staged change');
  assert.equal(run(root, 'show', `${sha}:new-file.txt`), 'untracked');
});

test('a snapshot leaves out gitignored files and .env files', t => {
  const { root } = makeRepo(t);
  dirty(root);
  const { sha, excluded } = snapshot(repoInfo(root));
  const files = run(root, 'ls-tree', '-r', '--name-only', sha).split('\n');
  assert.ok(!files.includes('ignored.txt'));
  assert.ok(!files.includes('.env'));
  assert.deepEqual(excluded, ['.env']);
});

test('an excluded change to a tracked file keeps its committed version', t => {
  const { root } = makeRepo(t);
  write(root, 'config.pem', 'old\n');
  run(root, 'add', 'config.pem');
  run(root, 'commit', '-q', '-m', 'add pem');
  write(root, 'config.pem', 'new\n');
  const { sha } = snapshot(repoInfo(root));
  assert.equal(run(root, 'show', `${sha}:config.pem`), 'old');
});

test('file names with special characters are excluded correctly', t => {
  const { root } = makeRepo(t);
  write(root, 'dir [1]/.env', 'NAME=value\n');
  write(root, 'dir [1]/keep.txt', 'keep\n');
  const { sha } = snapshot(repoInfo(root));
  assert.deepEqual(run(root, 'ls-tree', '-r', '--name-only', '-z', sha).split('\0').filter(f => f.startsWith('dir')), ['dir [1]/keep.txt']);
});

test('a clean repo snapshots to HEAD and creates no commit', t => {
  const { root } = makeRepo(t);
  const info = repoInfo(root);
  const result = snapshot(info);
  assert.equal(result.sha, info.head);
  assert.equal(result.created, false);
});

test('the snapshot commit works without a git identity', t => {
  const { root } = makeRepo(t);
  run(root, 'config', '--unset', 'user.name');
  run(root, 'config', '--unset', 'user.email');
  write(root, 'tracked.txt', 'changed\n');
  const { sha } = createSnapshot(repoInfo(root), { message: 'snapshot' });
  assert.ok(sha);
});

test('pending changes include unpushed commits as well as the snapshot', t => {
  const { root } = makeRepo(t);
  write(root, 'committed.txt', 'unpushed line\n');
  run(root, 'add', 'committed.txt');
  run(root, 'commit', '-q', '-m', 'unpushed');
  write(root, 'tracked.txt', 'working tree line\n');
  const info = repoInfo(root);
  const { sha } = snapshot(info);
  const diff = pendingDiff(root, sha, info.remote);
  assert.match(diff, /\+unpushed line/);
  assert.match(diff, /\+working tree line/);
  assert.equal(pendingCommitCount(root, sha, info.remote), 2);
});

test('a repo with no remote treats all history as pending', t => {
  const { root } = makeRepo(t, { remote: false });
  const info = repoInfo(root);
  assert.equal(info.remote, null);
  assert.match(pendingDiff(root, info.head, null), /\+original/);
});

test('pushing creates the branch on the remote and changes nothing locally', t => {
  const { root, bare } = makeRepo(t);
  dirty(root);
  const before = fingerprint(root);
  const info = repoInfo(root);
  const { sha } = snapshot(info);
  pushBranch(info, sha, 'skyhop/test-1');
  assert.equal(run(bare, 'rev-parse', 'refs/heads/skyhop/test-1'), sha);
  const after = fingerprint(root);
  assert.equal(after.index, before.index);
  assert.deepEqual(after.files, before.files);
  assert.equal(after.head, before.head);
});

test('a rejected push explains itself', t => {
  const { root, bare } = makeRepo(t);
  write(bare, 'hooks/pre-receive', '#!/bin/sh\necho "branch policy says no" >&2\nexit 1\n');
  fs.chmodSync(path.join(bare, 'hooks/pre-receive'), 0o755);
  const info = repoInfo(root);
  assert.throws(() => pushBranch(info, info.head, 'skyhop/test-2'), error => {
    assert.match(error.message, /branch policy says no/);
    assert.match(error.hint, /Nothing was started/);
    return true;
  });
});

test('the launch folder is a worktree on the snapshot branch', t => {
  const { root, base } = makeRepo(t);
  process.env.HOME = base;
  dirty(root);
  const before = fingerprint(root);
  const info = repoInfo(root);
  const { sha } = snapshot(info);
  const dir = prepareLaunchFolder(info, sha, 'skyhop/one');

  assert.equal(dir, launchDir(root));
  assert.equal(run(dir, 'rev-parse', 'HEAD'), sha);
  assert.equal(run(dir, 'symbolic-ref', '--short', 'HEAD'), 'skyhop/one');
  assert.equal(fs.readFileSync(path.join(dir, 'new-file.txt'), 'utf8'), 'untracked\n');
  assert.equal(run(root, 'symbolic-ref', '--short', 'HEAD'), before.branch);
  assert.equal(fingerprint(root).index, before.index);
});

test('removing the launch folder leaves the repo exactly as it was', t => {
  const { root, base } = makeRepo(t);
  process.env.HOME = base;
  dirty(root);
  const before = fingerprint(root);
  const info = repoInfo(root);
  const dir = prepareLaunchFolder(info, snapshot(info).sha, 'skyhop/one');
  removeLaunchFolder(info);
  assert.ok(!fs.existsSync(dir));
  assert.deepEqual(fingerprint(root), before);
  assert.equal(run(root, 'worktree', 'list').split('\n').length, 1);
});

test('removing never deletes a branch that is not a Skyhop branch', t => {
  const { root, base } = makeRepo(t);
  process.env.HOME = base;
  const info = repoInfo(root);
  fs.mkdirSync(path.dirname(launchDir(root)), { recursive: true });
  run(root, 'worktree', 'add', '-q', '-b', 'my-work', launchDir(root));
  removeLaunchFolder(info);
  assert.equal(run(root, 'rev-parse', '--verify', 'my-work'), info.head);
});

test('a leftover launch folder does not block the next handoff', t => {
  const { root, base } = makeRepo(t);
  process.env.HOME = base;
  const info = repoInfo(root);
  prepareLaunchFolder(info, info.head, 'skyhop/one');
  const dir = prepareLaunchFolder(info, info.head, 'skyhop/two');
  assert.equal(run(dir, 'symbolic-ref', '--short', 'HEAD'), 'skyhop/two');
  assert.equal(run(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/skyhop'), 'skyhop/two');
});

test('pending changes cover every local branch', t => {
  const { root } = makeRepo(t);
  run(root, 'checkout', '-q', '-b', 'other');
  write(root, 'other.txt', 'line on another branch\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'other');
  run(root, 'checkout', '-q', 'main');
  const info = repoInfo(root);
  assert.match(pendingDiff(root, info.head, info.remote), /\+line on another branch/);
});

test('branch names are safe and carry a timestamp', () => {
  const date = new Date('2026-11-01T12:34:56Z');
  assert.equal(skyhopBranch('feature/login page', date), 'skyhop/feature-login-page-20261101-123456');
  assert.equal(skyhopBranch('..', date), 'skyhop/session-20261101-123456');
  assert.equal(skyhopBranch(undefined, date), 'skyhop/session-20261101-123456');
});

test('credentials in a remote URL are masked', () => {
  assert.equal(maskUrl('https://user:secret@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(maskUrl('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});

test('outside a repository the error says so', t => {
  assert.throws(() => repoInfo(tempDir(t)), /not inside a git repository/);
});

test('a repository with no commits gets a clear error', t => {
  const dir = tempDir(t);
  run(dir, 'init', '-q');
  assert.throws(() => repoInfo(dir), /no commits yet/);
});
