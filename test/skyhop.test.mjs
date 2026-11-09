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
  // Most tests here cover the summary handoff, so they ask for it unless they say otherwise.
  const skyhop = (args, { mode = '' } = {}) => {
    const full = ['--full-resume', '--status', '--default'].some(flag => args.includes(flag));
    const flags = full ? args.filter(flag => flag !== '--default') : ['--summary', ...args];
    const result = spawnSync('node', [SCRIPT, '--brief', briefFile, '--session', SESSION, ...flags], {
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

  // Pushing records a remote-tracking ref, which is normal. Local refs must not change.
  const localRefs = state => state.refs.split('\n').filter(ref => !ref.startsWith('refs/remotes/'));
  const after = fingerprint(root);
  assert.deepEqual(localRefs(after), localRefs(before));
  assert.deepEqual({ ...after, refs: null }, { ...before, refs: null });
  assert.equal(run(root, 'worktree', 'list').split('\n').length, 1);
  assert.ok(!fs.existsSync(launchFolder()));

  assert.match(result.output, /session_01FakeSessionForTests/);
  assert.equal(fs.readFileSync(path.join(base, 'branch'), 'utf8').trim(), branch);
  assert.match(fs.readFileSync(path.join(base, 'prompt'), 'utf8'), /## Goal\nShip it\./);
  assert.equal(fs.readFileSync(path.join(base, 'force-bundle'), 'utf8'), 'unset');

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

test('no remote is a clear error for the summary handoff', t => {
  const { skyhop } = setup(t, { remote: false });
  const result = skyhop(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /no remote/);
  assert.match(result.output, /drop --summary/);
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

test('a secret on another local branch stops a handoff, because uploads carry every branch', t => {
  const { root, skyhop, branches } = setup(t);
  run(root, 'checkout', '-q', '-b', 'other');
  write(root, 'config.js', `const key = "${FAKE_TOKEN}";\n`);
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'on another branch');
  run(root, 'checkout', '-q', 'main');
  const result = skyhop(['--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /config\.js/);
  assert.equal(branches(), '');
});

test('a waiting handoff is cleaned up by the next run', t => {
  const { root, skyhop } = setup(t);
  assert.equal(skyhop(['--yes', '--name', 'first'], { mode: 'trust' }).status, 3);
  assert.match(run(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/skyhop'), /skyhop\/first-/);

  assert.equal(skyhop(['--yes', '--name', 'second']).status, 0);
  assert.equal(run(root, 'for-each-ref', 'refs/heads/skyhop'), '');
  assert.equal(run(root, 'worktree', 'list').split('\n').length, 1);
});

const shownBranch = output => output.match(/Branch:\s+(skyhop\/\S+)/)[1];
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('the branch in the preview is the branch that gets pushed', t => {
  const { skyhop, branches } = setup(t);
  const preview = shownBranch(skyhop(['--dry-run']).output);
  pause(1100);
  const result = skyhop(['--yes']);
  assert.equal(result.status, 0, result.output);
  assert.equal(shownBranch(result.output), preview);
  assert.equal(branches(), preview);
});

test('a preview name is used once, so a retry gets a fresh branch', t => {
  const { skyhop, branches } = setup(t);
  skyhop(['--dry-run']);
  skyhop(['--yes']);
  pause(1100);
  skyhop(['--yes']);
  assert.equal(branches().split('\n').length, 2);
});

test('changing --name after the preview does not reuse the old branch', t => {
  const { skyhop, branches } = setup(t);
  skyhop(['--dry-run', '--name', 'first']);
  skyhop(['--yes', '--name', 'second']);
  assert.match(branches(), /^skyhop\/second-/);
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

test('full resume leaves the repo unchanged and pushes no skyhop/ branch', t => {
  const { root, base, home, skyhop, branches, launchFolder } = setup(t);
  dirty(root);
  addTranscript(home);
  const before = fingerprint(root);

  const result = skyhop(['--yes', '--full-resume']);
  assert.equal(result.status, 0, result.output);

  assert.equal(branches(), '');
  assert.equal(fs.readFileSync(path.join(base, 'force-bundle'), 'utf8'), 'unset');
  assert.match(fs.readFileSync(path.join(base, 'prompt'), 'utf8'), /Continue with the remaining work/);
  assert.match(result.output, /encrypted\) are pushed to a skyhop-run branch/);
  assert.match(result.output, /Permission: auto/);

  const seen = name => fs.readFileSync(path.join(base, name), 'utf8').trim();
  assert.equal(seen('relay-mode'), 'auto');
  assert.equal(seen('relay-session'), SESSION);
  assert.equal(seen('launch-tracked'), 'changed');
  // Pushing records a remote-tracking ref, which is normal. Local refs must not change.
  const localRefs = state => state.refs.split('\n').filter(ref => !ref.startsWith('refs/remotes/'));
  const after = fingerprint(root);
  assert.deepEqual(localRefs(after), localRefs(before));
  assert.deepEqual({ ...after, refs: null }, { ...before, refs: null });
  assert.ok(!fs.existsSync(launchFolder()));
});

test('full resume with no remote uploads directly', t => {
  const { base, home, skyhop } = setup(t, { remote: false });
  addTranscript(home);
  const result = skyhop(['--yes', '--full-resume']);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(path.join(base, 'force-bundle'), 'utf8'), '1');
  assert.match(result.output, /MB compressed\)/);
});

test('--mode sets the permission mode for full resume', t => {
  const { base, home, skyhop } = setup(t);
  addTranscript(home);
  const result = skyhop(['--yes', '--full-resume', '--mode', 'acceptEdits']);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(path.join(base, 'relay-mode'), 'utf8').trim(), 'acceptEdits');
});

test('full resume is the default', t => {
  const { home, skyhop, branches } = setup(t);
  addTranscript(home);
  const result = skyhop(['--default', '--yes']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Mode:\s+full resume/);
  assert.equal(branches(), '');
});

test('--summary and --full-resume together are refused', t => {
  const { skyhop } = setup(t);
  assert.match(skyhop(['--full-resume', '--yes', '--summary']).output, /ask for different handoffs/);
});

test('the cloud chat starts with a recap of where you left off', t => {
  const { base, home, skyhop } = setup(t);
  addTranscript(home);
  assert.equal(skyhop(['--full-resume', '--yes']).status, 0);
  const first = fs.readFileSync(path.join(base, 'prompt'), 'utf8');
  assert.match(first, /--- Where we left off[\s\S]*## Goal\nShip it\.[\s\S]*--- End of recap ---/);
  assert.match(first, /\[skyhop-key:[^\]]+\]$/);
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

test('the log records each handoff step, and never the secret or the brief', t => {
  const { root, home, skyhop } = setup(t);
  write(root, 'config.js', `const key = "${FAKE_TOKEN}";\n`);
  assert.equal(skyhop(['--yes']).status, 1);
  const text = fs.readFileSync(path.join(home, '.skyhop/logs/skyhop.log'), 'utf8');
  assert.match(text, / handoff start version=\S+ node=v[\d.]+ os="\w+ [^"]+" mode=summary flags=yes\n/);
  assert.match(text, / handoff plan repo=repo remote=yes changed=1 unpushed=0\n/);
  assert.match(text, / handoff secret scan found=1 rules="GitHub token"\n/);
  assert.match(text, / handoff stopped error="Stopped because of the likely secrets above\. Nothing left this machine\."\n/);
  assert.ok(!text.includes(FAKE_TOKEN));
  assert.doesNotMatch(text, /Ship it/);
});

test('status points to the logs once there are any', t => {
  const { skyhop } = setup(t);
  assert.doesNotMatch(skyhop(['--status']).output, /skyhop\/logs/);
  skyhop(['--dry-run']);
  assert.match(skyhop(['--status']).output, /Skyhop's logs are in ~\/\.skyhop\/logs\//);
});

test('with Remote Control on, the plan and the first cloud message link to the whole conversation', t => {
  const { base, home, skyhop } = setup(t);
  addTranscript(home, '{"type":"user","message":{"content":"hi"}}\n{"type":"bridge-session","sessionId":"s","bridgeSessionId":"cse_01AbcdefghijKLmn","lastSequenceNum":0}\n');
  const result = skyhop(['--full-resume', '--yes']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /History:\s+the cloud chat (starts with a recap|quotes your last \d+ message\(s\) word for word), and links to your whole conversation in this session's Remote Control entry: https:\/\/claude\.ai\/code\/session_01AbcdefghijKLmn/);
  assert.match(fs.readFileSync(path.join(base, 'prompt'), 'utf8'), /--- Where we left off[^\n]*\n\nYour whole conversation from your computer[^\n]*session_01AbcdefghijKLmn\n\n## Goal/);
  assert.match(fs.readFileSync(path.join(home, '.skyhop/logs/skyhop.log'), 'utf8'), / history="remote control link"/);
});

test('without Remote Control, the plan says how to get the link next time', t => {
  const { base, home, skyhop } = setup(t);
  addTranscript(home);
  const result = skyhop(['--full-resume', '--yes']);
  assert.match(result.output, /History:\s+the cloud chat (starts with a recap|quotes your last \d+ message\(s\) word for word)\. Remote Control is off, so there's no link to your whole conversation\. To add one, type \/remote-control before going ahead/);
  assert.doesNotMatch(fs.readFileSync(path.join(base, 'prompt'), 'utf8'), /Remote Control entry/);
});

