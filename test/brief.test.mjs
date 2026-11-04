import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { briefPrompt, fitPrompt, loadBrief, MAX_PROMPT_BYTES, redactPaths, resumeMessage, resumePrompt } from '../scripts/brief.mjs';
import { tempDir } from './helpers.mjs';

test('private paths are redacted', () => {
  assert.equal(redactPaths('see /Users/someone/work/app.js', '/nowhere'), 'see ~/work/app.js');
  assert.equal(redactPaths('see /home/someone/work', '/nowhere'), 'see ~/work');
  assert.equal(redactPaths('see /custom/home/x', '/custom/home'), 'see ~/x');
});

test('other paths are left alone', () => {
  assert.equal(redactPaths('run /usr/local/bin/node on src/app.js', '/nowhere'), 'run /usr/local/bin/node on src/app.js');
});

test('loading a brief redacts paths', t => {
  const file = path.join(tempDir(t), 'brief.md');
  fs.writeFileSync(file, 'Edited /Users/someone/app.js\n');
  assert.equal(loadBrief(file), 'Edited ~/app.js');
});

test('a missing or empty brief gets a clear error', t => {
  const file = path.join(tempDir(t), 'brief.md');
  assert.throws(() => loadBrief(file), /not found/);
  assert.throws(() => loadBrief(undefined), /No brief/);
  fs.writeFileSync(file, '  \n');
  assert.throws(() => loadBrief(file), /empty/);
});

test('the first prompt carries the brief and says to act only on remaining work', () => {
  const prompt = briefPrompt('## Goal\nShip it.');
  assert.match(prompt, /## Goal\nShip it\./);
  assert.match(prompt, /Act only on Remaining work/);
  assert.match(prompt, /do not redo those requests/);
});

test('the first prompt starts with the project', () => {
  assert.match(briefPrompt('## Goal\nShip it.', 'my-project'), /^Project my-project\. /);
});

test('the resume message starts with the project too', () => {
  assert.match(resumeMessage('my-project'), /^Project my-project\. /);
});

test('the full-resume prompt carries the recap between its markers', () => {
  const prompt = resumePrompt('my-project', '## Goal\nShip it.');
  assert.match(prompt, /^Project my-project\. Skyhop has moved you/);
  assert.match(prompt, /--- Where we left off[^\n]*\n\n## Goal\nShip it\.\n\n--- End of recap ---$/);
});

test('a long recap is trimmed from its oldest turns and keeps its end marker', () => {
  const turns = Array.from({ length: 3000 }, (_, i) => `turn ${i}`).join('\n');
  const prompt = resumePrompt('p', `## Goal\nShip it.\n\n## Recent conversation\n${turns}`);
  assert.ok(Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES);
  assert.match(prompt, /turn 2999\n\n--- End of recap ---$/);
});

test('a prompt under the limit is unchanged', () => {
  assert.equal(fitPrompt('short', 100), 'short');
});

test('an oversized prompt drops the oldest recent turns and keeps the newest', () => {
  const turns = Array.from({ length: 2000 }, (_, i) => `turn ${i}`).join('\n');
  const fitted = fitPrompt(`## Goal\nShip it.\n\n## Recent conversation\n${turns}`, 4000);
  assert.ok(Buffer.byteLength(fitted) <= 4000);
  assert.match(fitted, /## Goal\nShip it\./);
  assert.match(fitted, /turn 1999$/);
  assert.doesNotMatch(fitted, /\nturn 5\n/);
  assert.match(fitted, /Older turns were left out/);
});

test('trimming stays valid text around multi-byte characters', () => {
  const fitted = fitPrompt(`## Recent conversation\n${'é'.repeat(4000)}`, 1000);
  assert.ok(Buffer.byteLength(fitted) <= 1000);
  assert.ok(!fitted.includes('�'));
});

test('an oversized brief with nothing to trim is an error', () => {
  assert.throws(() => fitPrompt('x'.repeat(MAX_PROMPT_BYTES + 1)), /too long/);
});

test('the resume message tells the session that local paths have changed', () => {
  assert.match(resumeMessage(), /Paths from earlier in this conversation may no longer exist/);
});
