import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  launchSession, launchTimes, pasteCommand, readHistory, readLaunchOutput, recordHandoff, requireSignIn, shellQuote, terminalCommand,
} from '../scripts/cloud.mjs';
import { tempDir } from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
process.env.PATH = `${FIXTURES}:${process.env.PATH}`;

function fakeLaunch(t, mode) {
  const dir = tempDir(t);
  process.env.FAKE_CLAUDE_DIR = dir;
  process.env.FAKE_CLAUDE_MODE = mode ?? '';
  return { dir, options: { dir, prompt: "it's a test", waitMs: 5000, settleMs: 100 } };
}

test('quotes shell text safely', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote('$(rm -rf x)'), `'$(rm -rf x)'`);
});

test('builds a terminal wrapper for macOS and Linux', () => {
  assert.match(terminalCommand('darwin', ['claude', '--cloud', 'hi']), /^tail -f \/dev\/null \| script -q \/dev\/null sh -c /);
  assert.match(terminalCommand('linux', ['claude', '--cloud', 'hi']), /^tail -f \/dev\/null \| script -qec /);
  assert.equal(terminalCommand('win32', ['claude']), null);
});

test('the paste command reads the prompt from its file', () => {
  assert.equal(
    pasteCommand('/a b', '/p.md', { CCR_FORCE_BUNDLE: '1' }),
    `cd '/a b' && CCR_FORCE_BUNDLE=1 claude --cloud "$(cat '/p.md')"`,
  );
});

test('reads the session link and ID', () => {
  const output = readLaunchOutput('\x1b[32mView:\x1b[0m https://claude.ai/code/session_01AbCdEfGhIjKl?from=cli\r\n');
  assert.equal(output.url, 'https://claude.ai/code/session_01AbCdEfGhIjKl');
  assert.equal(output.sessionId, 'session_01AbCdEfGhIjKl');
});

test('sees the trust prompt even when the terminal UI drops the spaces', () => {
  assert.equal(readLaunchOutput('Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?').problem, 'trust');
  assert.equal(readLaunchOutput('Yes,\x1b[1CI\x1b[1Ctrust\x1b[1Cthis\x1b[1Cfolder').problem, 'trust');
});

test('recognizes known failures', () => {
  assert.equal(readLaunchOutput('Branch skyhop/x is not on GitHub').problem, 'wrong-branch');
  assert.equal(readLaunchOutput('Error: --cloud requires an interactive terminal.').problem, 'no-terminal');
  assert.equal(readLaunchOutput('Unable to get organization UUID').problem, 'sign-in');
  assert.equal(readLaunchOutput('Session creation failed').problem, 'failed');
  assert.equal(readLaunchOutput('Not uploading this working tree: reason').problem, 'upload-refused');
  assert.equal(readLaunchOutput('Cloud sessions are disabled by your organization').problem, 'policy');
  assert.equal(readLaunchOutput('all fine').problem, null);
});

test('the wrapper gives --cloud a terminal and captures the link', async t => {
  const { dir, options } = fakeLaunch(t);
  const outcome = await launchSession(options);
  assert.deepEqual(outcome, {
    status: 'started',
    url: 'https://claude.ai/code/session_01FakeSessionForTests',
    sessionId: 'session_01FakeSessionForTests',
  });
  assert.equal(fs.readFileSync(path.join(dir, 'prompt'), 'utf8'), "it's a test");
});

test('a trust prompt ends the attempt without answering it', async t => {
  const { options } = fakeLaunch(t, 'trust');
  assert.deepEqual(await launchSession(options), { status: 'needs-terminal', reason: 'trust' });
});

test('a branch missing from GitHub counts as a failed launch', async t => {
  const { options } = fakeLaunch(t, 'wrong-branch');
  await assert.rejects(launchSession(options), /wrong commit/);
});

test('a launch that ends with no link is reported as unconfirmed', async t => {
  const { options } = fakeLaunch(t, 'no-link');
  const outcome = await launchSession(options);
  assert.equal(outcome.status, 'unconfirmed');
  assert.match(outcome.detail, /Setting up/);
});

test('a larger upload gets more time before the client stops', () => {
  const small = launchTimes(0);
  const large = launchTimes(82_000_000);
  assert.ok(large.waitMs > small.waitMs);
  assert.ok(large.settleMs > small.settleMs + 60_000);
});

test('the sign-in check accepts claude.ai and rejects anything else', () => {
  process.env.FAKE_CLAUDE_MODE = '';
  assert.doesNotThrow(requireSignIn);
  process.env.FAKE_CLAUDE_MODE = 'signed-out';
  assert.throws(requireSignIn, /claude\.ai sign-in/);
});

test('history adds entries and survives a missing file', t => {
  const home = tempDir(t);
  assert.deepEqual(readHistory(home), []);
  recordHandoff({ branch: 'one' }, home);
  recordHandoff({ branch: 'two' }, home);
  assert.deepEqual(readHistory(home).map(entry => entry.branch), ['one', 'two']);
});
