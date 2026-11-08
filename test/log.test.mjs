import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendLog, cleanValue, formatLine, log, readLogTail, skyhopVersion,
} from '../scripts/log.mjs';
import { tempDir } from './helpers.mjs';

const FAKE_TOKEN = `gh${'p'}_${'a'.repeat(36)}`;
const NOW = new Date('2026-11-08T10:02:14.000Z');

test('a log line has the time, area, event and fields, and leaves empty fields out', () => {
  const line = formatLine('handoff', 'plan', { repo: 'app', sync: 'on', chat: null, files: 0, empty: '' }, { now: NOW });
  assert.equal(line, '2026-11-08T10:02:14.000Z handoff plan repo=app sync=on files=0\n');
});

test('values with spaces or quotes are quoted, so each line stays one record', () => {
  const line = formatLine('home', 'message', { said: 'Skyhop: this "session" is back\nfrom the cloud' }, { now: NOW });
  assert.equal(line, '2026-11-08T10:02:14.000Z home message said="Skyhop: this \\"session\\" is back from the cloud"\n');
});

test('home folders, URL credentials, tokens and the transcript key are hidden', () => {
  const cleaned = cleanValue(
    `failed in /Users/alex/work/app and /home/sam/x with https://user:${FAKE_TOKEN}@github.com/o/r.git token ${FAKE_TOKEN} [skyhop-key:abc+/=] password = "hunter2hunter2hunter2"`,
    '/Users/alex',
  );
  assert.doesNotMatch(cleaned, /alex|sam|hunter2|abc\+/);
  assert.ok(!cleaned.includes(FAKE_TOKEN));
  assert.match(cleaned, /~\/work\/app/);
  assert.match(cleaned, /https:\/\/github\.com\/o\/r\.git/);
  assert.match(cleaned, /\[hidden GitHub token\]/);
  assert.match(cleaned, /\[skyhop-key:hidden\]/);
});

test('long values are cut short', () => {
  const cleaned = cleanValue('x'.repeat(5000));
  assert.ok(cleaned.length < 400);
  assert.ok(cleaned.endsWith('…'));
});

test('past its size limit the log starts again and keeps one older file', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'logs/skyhop.log');
  for (let i = 0; i < 10; i += 1) appendLog(file, `line ${i} ${'.'.repeat(40)}\n`, 200);
  assert.ok(fs.statSync(file).size <= 200);
  assert.ok(fs.existsSync(`${file}.1`));
  assert.match(fs.readFileSync(file, 'utf8'), /line 9/);
  assert.ok(!fs.existsSync(`${file}.2`));
});

test('a log that cannot be written never stops Skyhop', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a-file'), '');
  assert.doesNotThrow(() => appendLog(path.join(dir, 'a-file', 'skyhop.log'), 'line\n'));
});

test('the end of a log starts at a whole line', t => {
  const file = path.join(tempDir(t), 'log');
  fs.writeFileSync(file, 'first line\nsecond line\nthird line\n');
  assert.equal(readLogTail(file, 15), 'third line\n');
  assert.equal(readLogTail(file, 1000), 'first line\nsecond line\nthird line\n');
  assert.equal(readLogTail(path.join(file, 'missing'), 10), '');
});

test('the Mac log goes in ~/.skyhop/logs, private to the user', t => {
  const home = tempDir(t);
  log('handoff', 'start', { version: '1.2.3' }, home);
  const file = path.join(home, '.skyhop/logs/skyhop.log');
  assert.match(fs.readFileSync(file, 'utf8'), / handoff start version=1\.2\.3\n$/);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test('the version comes from the plugin, or from the file next to the relay in the VM', t => {
  const plugin = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.equal(skyhopVersion(), plugin.version);
  const vmFolder = tempDir(t);
  fs.writeFileSync(path.join(vmFolder, 'version'), '9.9.9\n');
  assert.equal(skyhopVersion(vmFolder), '9.9.9');
  assert.equal(skyhopVersion(path.join(vmFolder, 'nowhere')), 'unknown');
});
