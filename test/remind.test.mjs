import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { makeRepo, tempDir, write } from './helpers.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/remind.mjs');
const remind = input => spawnSync('node', [SCRIPT], { input, encoding: 'utf8' });

test('reminds when the repo has uncommitted work', t => {
  const { root } = makeRepo(t);
  write(root, 'tracked.txt', 'changed\n');
  const result = remind(JSON.stringify({ cwd: root }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /\/skyhop/);
});

test('stays quiet in a clean repo, outside a repo, and on bad input', t => {
  const { root } = makeRepo(t);
  for (const input of [JSON.stringify({ cwd: root }), JSON.stringify({ cwd: tempDir(t) }), 'not json']) {
    const result = remind(input);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  }
});
