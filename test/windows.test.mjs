// The parts of Skyhop that differ on Windows, tested on any system.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hiddenLaunch, launchHidden, pasteCommand, readPulse, waitForPulse, windowsArg } from '../scripts/cloud.mjs';
import { repoInfo } from '../scripts/git.mjs';
import { redactPaths } from '../scripts/log.mjs';
import { chatIdHere, pulseMessage, PULSE_READY, PULSE_SETUP, readPulseMessage } from '../scripts/sync.mjs';
import { makeRepo, run } from './helpers.mjs';

process.env.SKYHOP_BRANCH_POLL_MS = '20';
import { SESSION, setup } from './roundtrip.mjs';

test('Windows command-line arguments split back into what was meant', () => {
  assert.equal(windowsArg('--cloud'), '--cloud');
  assert.equal(windowsArg('session_01Abc'), 'session_01Abc');
  assert.equal(windowsArg('two words'), '"two words"');
  assert.equal(windowsArg(''), '""');
  assert.equal(windowsArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(windowsArg('C:\\path with space\\'), '"C:\\path with space\\\\"');
  assert.equal(windowsArg('a\\"b c'), '"a\\\\\\"b c"');
  assert.equal(windowsArg('Project x. Setting up. [skyhop-key:ab+/c=] [skyhop-history]'), '"Project x. Setting up. [skyhop-key:ab+/c=] [skyhop-history]"');
});

test('Windows launches hidden, and has no command to paste', () => {
  assert.equal(hiddenLaunch('win32'), true);
  assert.equal(hiddenLaunch('darwin'), process.env.SKYHOP_LAUNCH === 'hidden');
  assert.equal(pasteCommand('C:\\repo', 'C:\\brief.md', {}, 'win32'), null);
  assert.match(pasteCommand('/repo', '/brief.md', {}, 'darwin'), /claude --cloud/);
});

test('Windows home folders are hidden in every form a transcript holds them', () => {
  const home = 'C:\\Users\\Aryadeep';
  assert.equal(redactPaths('open C:\\Users\\Aryadeep\\code\\x.py', home), 'open ~\\code\\x.py');
  assert.equal(redactPaths('{"cwd":"C:\\\\Users\\\\Aryadeep\\\\code"}', '/nowhere'), '{"cwd":"~\\\\code"}');
  assert.equal(redactPaths('c:/users/aryadeep/code and D:\\Users\\Other\\x', '/nowhere'), '~/code and ~\\x');
  assert.equal(redactPaths('/Users/someone/x and /home/me/y', '/nowhere'), '~/x and ~/y');
});

test('a pulse commit carries what it means and the chat that sent it', () => {
  assert.equal(chatIdHere({ CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_01HkNmBfjVyV9fQTtins638R' }), 'session_01HkNmBfjVyV9fQTtins638R');
  assert.equal(chatIdHere({ CLAUDE_CODE_REMOTE_SESSION_ID: 'not an id; rm -rf' }), null);
  assert.equal(chatIdHere({}), null);
  assert.deepEqual(readPulseMessage(pulseMessage(PULSE_SETUP, 'session_01Abc')), { note: PULSE_SETUP, chatId: 'session_01Abc' });
  assert.deepEqual(readPulseMessage(pulseMessage(PULSE_READY, null)), { note: PULSE_READY, chatId: null });
  assert.deepEqual(readPulseMessage('Skyhop: a reply is running'), { note: 'Skyhop: a reply is running', chatId: null });
});

function pushPulse(repo, branch, message) {
  const tree = run(repo.root, 'rev-parse', 'HEAD^{tree}');
  const sha = run(repo.root, 'commit-tree', tree, '-m', message);
  run(repo.root, 'push', '-q', 'origin', `+${sha}:refs/heads/${branch}`);
}

test('the Mac reads the pulse branch, and waits for the commit it needs', async t => {
  const repo = makeRepo(t);
  const info = repoInfo(repo.root);
  const branch = 'skyhop-sync/main-1-pulse';
  assert.equal(readPulse(info, branch), null, 'no branch yet');
  pushPulse(repo, branch, pulseMessage(PULSE_SETUP, 'session_01Abc'));
  assert.deepEqual(readPulse(info, branch), { note: PULSE_SETUP, chatId: 'session_01Abc' });
  assert.equal(await waitForPulse(info, branch, 50, found => found.note === PULSE_READY), null);
  pushPulse(repo, branch, pulseMessage(PULSE_READY, 'session_01Abc'));
  assert.equal((await waitForPulse(info, branch, 50, found => found.note === PULSE_READY)).note, PULSE_READY);
  assert.equal(run(repo.root, 'for-each-ref', 'refs/skyhop'), '', 'no local refs left behind');
});

test('a hidden launch starts claude, waits for the chat to report its ID, then ends the window', async t => {
  const repo = makeRepo(t);
  const info = repoInfo(repo.root);
  const calls = [];
  const outcome = await launchHidden({
    dir: repo.root, prompt: 'Project x. [skyhop-history]', info, pulse: 'p-pulse', waitMs: 5000,
    start: (dir, prompt) => {
      calls.push(['start', dir, prompt]);
      setTimeout(() => pushPulse(repo, 'p-pulse', pulseMessage(PULSE_SETUP, 'session_01Reported')), 100);
      return { pid: 4321 };
    },
    stop: pid => calls.push(['stop', pid]),
  });
  assert.deepEqual(outcome, { status: 'started', sessionId: 'session_01Reported', url: 'https://claude.ai/code/session_01Reported' });
  assert.deepEqual(calls, [['start', repo.root, 'Project x. [skyhop-history]'], ['stop', 4321]]);

  const silent = await launchHidden({ dir: repo.root, prompt: 'x', info, pulse: 'none-pulse', waitMs: 50, start: () => ({ pid: 9 }), stop: pid => calls.push(['stop', pid]) });
  assert.equal(silent.status, 'unconfirmed');
  assert.deepEqual(calls.at(-1), ['stop', 9], 'the window is ended even when the chat never reports');
  assert.equal((await launchHidden({ dir: repo.root, prompt: 'x', info, pulse: 'p', start: () => ({ error: 'no PowerShell' }) })).detail, 'no PowerShell');
});

test('on Windows, a summary handoff or one without GitHub stops before anything is pushed', t => {
  const { home, skyhop, remoteBranches } = setup(t);
  const brief = path.join(home, '.skyhop/briefs/brief.md');
  for (const flags of [['--summary'], ['--no-sync']]) {
    const result = skyhop(['--brief', brief, '--session', SESSION, '--yes', ...flags], { SKYHOP_LAUNCH: 'hidden' });
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /On Windows, Skyhop can start the cloud session only for a full resume synced through GitHub/);
  }
  assert.equal(remoteBranches('skyhop'), '');
  assert.ok(!fs.existsSync(path.join(home, '.skyhop/history.json')));
});

test('a brief path starting with ~ is found in the home folder', t => {
  const { skyhop } = setup(t);
  const result = skyhop(['--brief', '~/.skyhop/briefs/brief.md', '--session', SESSION, '--dry-run']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Dry run/);
});
