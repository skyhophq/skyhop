// Runs the real script end to end, with a stand-in claude and a local bare remote.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { launchDir } from '../scripts/git.mjs';
import { dirty, fingerprint, makeRepo, run, write } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '../scripts/skyhop.mjs');
const FIXTURES = path.join(HERE, 'fixtures');
const SESSION = '11111111-2222-3333-4444-555555555555';
const FAKE_TOKEN = `gh${'p'}_${'a'.repeat(36)}`;

function setup(t, options) {
  const repo = makeRepo(t, options);
  const home = path.join(repo.base, 'home');
  const briefFile = path.join(home, '.skyhop/briefs/brief.md');
  write(home, '.skyhop/briefs/brief.md', '## Goal\nShip it.\n\n## Remaining work\n1. Finish.\n');
  const skyhop = (args, { mode = '' } = {}) => {
    const result = spawnSync('node', [SCRIPT, '--brief', briefFile, '--session', SESSION, ...args], {
      cwd: repo.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_CLAUDE_DIR: repo.base,
        FAKE_CLAUDE_MODE: mode,
        SKYHOP_LAUNCH_WAIT_MS: '5000',
        SKYHOP_LAUNCH_SETTLE_MS: '100',
      },
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const branches = () => (repo.bare ? run(repo.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/skyhop') : '');
  const launchFolder = () => {
    const previous = process.env.HOME;
    process.env.HOME = home;
    const dir = launchDir(repo.root);
    process.env.HOME = previous;
    return dir;
  };
  return { ...repo, home, skyhop, branches, launchFolder };
}

test('a full run pushes the branch, starts the session and leaves the repo unchanged', t => {
  const { root, base, bare, home, skyhop, branches, launchFolder } = setup(t);
  dirty(root);
  const before = fingerprint(root);

  const result = skyhop(['--yes', '--name', 'login fix']);
  assert.equal(result.status, 0, result.output);

  const branch = branches();
  assert.match(branch, /^skyhop\/login-fix-\d{8}-\d{6}$/);
  assert.equal(run(bare, 'show', `${branch}:tracked.txt`), 'changed');
  assert.deepEqual(run(bare, 'ls-tree', '-r', '--name-only', branch).split('\n').filter(f => f === '.env' || f === 'ignored.txt'), []);

  const after = fingerprint(root);
  assert.deepEqual({ ...after, refs: null }, { ...before, refs: null });

  assert.match(result.output, /session_01FakeSessionForTests/);
  assert.equal(fs.readFileSync(path.join(base, 'branch'), 'utf8').trim(), branch);
  assert.match(fs.readFileSync(path.join(base, 'prompt'), 'utf8'), /## Goal\nShip it\./);
  assert.equal(fs.readFileSync(path.join(base, 'force-bundle'), 'utf8'), 'unset');
  assert.equal(run(launchFolder(), 'symbolic-ref', '--short', 'HEAD'), branch);

  const [record] = JSON.parse(fs.readFileSync(path.join(home, '.skyhop/history.json'), 'utf8'));
  assert.equal(record.branch, branch);
  assert.equal(record.status, 'started');
  assert.equal(record.url, 'https://claude.ai/code/session_01FakeSessionForTests');
});

test('a dry run pushes nothing, starts nothing, leaves no refs, and prints the prompt', t => {
  const { root, base, skyhop, branches, launchFolder } = setup(t);
  dirty(root);
  const before = fingerprint(root);

  const result = skyhop(['--dry-run']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Skyhop plan/);
  assert.match(result.output, /Left out:\s+\.env/);
  assert.match(result.output, /Unpushed:\s+0 commit/);
  assert.match(result.output, /## Goal\nShip it\./);
  assert.match(result.output, /nothing was pushed or started/);

  assert.equal(branches(), '');
  assert.ok(!fs.existsSync(launchFolder()));
  assert.ok(!fs.existsSync(path.join(base, 'prompt')));
  assert.deepEqual(fingerprint(root), before);
});

test('a secret in the working tree stops the run before anything leaves', t => {
  const { root, base, skyhop, branches, launchFolder } = setup(t);
  write(root, 'config.js', `const key = "${FAKE_TOKEN}";\n`);

  const result = skyhop(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /config\.js:1/);
  assert.match(result.output, /Nothing left this machine/);
  assert.ok(!result.output.includes(FAKE_TOKEN));
  assert.equal(branches(), '');
  assert.ok(!fs.existsSync(launchFolder()));
  assert.ok(!fs.existsSync(path.join(base, 'prompt')));
});

test('a secret in an unpushed commit stops the run', t => {
  const { root, skyhop, branches } = setup(t);
  write(root, 'config.js', `const key = "${FAKE_TOKEN}";\n`);
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'oops');
  const result = skyhop(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /config\.js/);
  assert.equal(branches(), '');
});

test('a secret in the brief stops the run', t => {
  const { home, skyhop, branches } = setup(t);
  write(home, '.skyhop/briefs/brief.md', `## Goal\nUse ${FAKE_TOKEN}\n`);
  const result = skyhop(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /brief/);
  assert.equal(branches(), '');
});

test('--allow-secrets is an explicit way past the scan', t => {
  const { root, skyhop, branches } = setup(t);
  write(root, 'config.js', `const key = "${FAKE_TOKEN}";\n`);
  const result = skyhop(['--yes', '--allow-secrets']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /--allow-secrets was set/);
  assert.notEqual(branches(), '');
});

test('without a terminal or --yes it asks for confirmation and pushes nothing', t => {
  const { root, skyhop, branches } = setup(t);
  dirty(root);
  const result = skyhop([]);
  assert.equal(result.status, 2);
  assert.match(result.output, /Confirmation needed/);
  assert.equal(branches(), '');
});

test('no remote is a clear error for the brief handoff', t => {
  const { skyhop } = setup(t, { remote: false });
  const result = skyhop(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /no remote/);
  assert.match(result.output, /--full-resume/);
});

test('being signed out is a clear error', t => {
  const { skyhop, branches } = setup(t);
  const result = skyhop(['--yes'], { mode: 'signed-out' });
  assert.equal(result.status, 1);
  assert.match(result.output, /claude auth login/);
  assert.equal(branches(), '');
});

test('a rejected push is reported and starts nothing', t => {
  const { bare, base, skyhop } = setup(t);
  write(bare, 'hooks/pre-receive', '#!/bin/sh\necho "no branches today" >&2\nexit 1\n');
  fs.chmodSync(path.join(bare, 'hooks/pre-receive'), 0o755);
  const result = skyhop(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /no branches today/);
  assert.ok(!fs.existsSync(path.join(base, 'prompt')));
});

test('a trust prompt prints a command for the user and records the handoff', t => {
  const { skyhop, launchFolder, home } = setup(t);
  const result = skyhop(['--yes'], { mode: 'trust' });
  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /Yes, I trust this folder/);
  assert.ok(result.output.includes(`cd '${launchFolder()}' && claude --cloud "$(cat `));

  const prompt = result.output.match(/\$\(cat '([^']+)'\)/)[1];
  assert.match(fs.readFileSync(prompt, 'utf8'), /## Goal/);
  const [record] = JSON.parse(fs.readFileSync(path.join(home, '.skyhop/history.json'), 'utf8'));
  assert.equal(record.status, 'waiting for terminal');
});

test('a failed launch keeps the brief and prints how to retry', t => {
  const { skyhop } = setup(t);
  const result = skyhop(['--yes'], { mode: 'wrong-branch' });
  assert.equal(result.status, 1);
  assert.match(result.output, /wrong commit/);
  assert.match(result.output, /The brief is kept at/);
  assert.match(result.output, /claude --cloud/);
});

function addTranscript(home, content = '{"type":"user"}\n') {
  write(home, `.claude/projects/some-project/${SESSION}.jsonl`, content);
}

test('full resume uploads directly, pushes nothing, and leaves the repo unchanged', t => {
  const { root, base, home, skyhop, branches, launchFolder } = setup(t);
  dirty(root);
  addTranscript(home);
  const before = fingerprint(root);

  const result = skyhop(['--yes', '--full-resume']);
  assert.equal(result.status, 0, result.output);

  assert.equal(branches(), '');
  assert.equal(fs.readFileSync(path.join(base, 'force-bundle'), 'utf8'), '1');
  assert.match(fs.readFileSync(path.join(base, 'prompt'), 'utf8'), /Continue with the remaining work/);
  assert.match(result.output, /full session transcript/);
  assert.match(result.output, /Permission: auto/);

  const dir = launchFolder();
  assert.equal(run(dir, 'show', 'HEAD:.skyhop/mode'), 'auto');
  assert.equal(run(dir, 'show', 'HEAD:.skyhop/session-id'), SESSION);
  assert.equal(run(dir, 'show', 'HEAD:tracked.txt'), 'changed');
  assert.deepEqual({ ...fingerprint(root), refs: null }, { ...before, refs: null });
  assert.equal(run(root, 'for-each-ref', 'refs/skyhop'), '');
});

test('full resume works with no remote', t => {
  const { home, skyhop } = setup(t, { remote: false });
  addTranscript(home);
  const result = skyhop(['--yes', '--full-resume']);
  assert.equal(result.status, 0, result.output);
});

test('--mode sets the permission mode for full resume', t => {
  const { home, skyhop, launchFolder } = setup(t);
  addTranscript(home);
  const result = skyhop(['--yes', '--full-resume', '--mode', 'acceptEdits']);
  assert.equal(result.status, 0, result.output);
  assert.equal(run(launchFolder(), 'show', 'HEAD:.skyhop/mode'), 'acceptEdits');
});

test('an unknown mode or flag is refused', t => {
  const { skyhop } = setup(t);
  assert.match(skyhop(['--mode', 'bypassPermissions']).output, /Unknown mode/);
  assert.match(skyhop(['--nope']).output, /Flags are/);
});

test('a secret in the transcript stops a full resume', t => {
  const { home, base, skyhop, launchFolder } = setup(t);
  addTranscript(home, `{"content":"${FAKE_TOKEN}"}\n`);
  const result = skyhop(['--yes', '--full-resume']);
  assert.equal(result.status, 1);
  assert.match(result.output, /session transcript/);
  assert.ok(!fs.existsSync(launchFolder()));
  assert.ok(!fs.existsSync(path.join(base, 'prompt')));
});

test('status lists handoffs newest first', t => {
  const { skyhop } = setup(t);
  assert.match(skyhop(['--status']).output, /No handoffs yet/);
  skyhop(['--yes', '--name', 'first']);
  skyhop(['--yes', '--name', 'second']);
  const output = skyhop(['--status']).output;
  assert.ok(output.indexOf('skyhop/second') < output.indexOf('skyhop/first'));
  assert.match(output, /https:\/\/claude\.ai\/code\/session_01FakeSessionForTests/);
});
