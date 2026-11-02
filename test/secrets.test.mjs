import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFinding, isSensitivePath, scanDiff, scanText } from '../scripts/secrets.mjs';

// Built from parts so this file doesn't trip secret scanners itself.
const fill = (char, length) => char.repeat(length);
const TOKENS = {
  'AWS access key': `AK${'IA'}${fill('A', 16)}`,
  'GitHub token': `gh${'p'}_${fill('a', 36)}`,
  'GitLab token': `gl${'pat'}-${fill('a', 20)}`,
  'Anthropic API key': `sk-${'ant'}-${fill('a', 40)}`,
  'OpenAI API key': `sk-${'proj'}-${fill('a', 40)}`,
  'Slack token': `xo${'xb'}-${fill('1', 24)}`,
  'Stripe live key': `sk_${'live'}_${fill('a', 24)}`,
  'Google API key': `AI${'za'}${fill('a', 35)}`,
  'npm token': `np${'m'}_${fill('a', 36)}`,
  'private key': `-----BEGIN RSA ${'PRIVATE'} KEY-----`,
};

for (const [rule, token] of Object.entries(TOKENS)) {
  test(`finds a ${rule}`, () => {
    assert.ok(scanText(`value = ${token}\n`, { source: 'x' }).some(f => f.rule === rule));
  });
}

test('an Anthropic key is not also reported as an OpenAI key', () => {
  const rules = scanText(TOKENS['Anthropic API key'], { source: 'x' }).map(f => f.rule);
  assert.deepEqual(rules, ['Anthropic API key']);
});

test('findings never contain the secret', () => {
  const token = TOKENS['GitHub token'];
  const [finding] = scanText(token, { source: 'x' });
  assert.ok(!formatFinding(finding).includes(token));
  assert.ok(!JSON.stringify(finding).includes(token));
});

test('reports the line number', () => {
  const [finding] = scanText(`one\ntwo\n${TOKENS['GitHub token']}\n`, { source: 'x' });
  assert.equal(finding.line, 3);
});

test('finds a hardcoded credential', () => {
  const [finding] = scanText(`const password = "${'hunter2'}hunter2hunter2"`, { source: 'x' });
  assert.equal(finding.rule, 'hardcoded credential');
});

test('ignores placeholders and environment lookups', () => {
  for (const line of [
    'api_key = "your-api-key-goes-here"',
    'password: "${DATABASE_PASSWORD_VALUE}"',
    'token = "process.env.SOME_LONG_TOKEN"',
    'secret = "xxxxxxxxxxxxxxxxxxxx"',
    'api_key = "<paste your key in here>"',
  ]) {
    assert.deepEqual(scanText(line, { source: 'x' }), [], line);
  }
});

test('ordinary code is clean', () => {
  const code = 'const tokenCount = 12;\nfunction getPassword() { return input.value; }\nconst sk = "short";\n';
  assert.deepEqual(scanText(code, { source: 'x' }), []);
});

test('strict mode skips the broad credential rule but keeps token rules', () => {
  const text = `password = "${'hunter2'.repeat(3)}"\n${TOKENS['GitHub token']}`;
  assert.deepEqual(scanText(text, { source: 'x', strict: true }).map(f => f.rule), ['GitHub token']);
});

const diffOf = (file, added) => [
  'commit:abcdef1234567890',
  '',
  `diff --git a/${file} b/${file}`,
  `--- a/${file}`,
  `+++ b/${file}`,
  '@@ -0,0 +12,2 @@',
  ...added.map(line => `+${line}`),
].join('\n');

test('a diff finding names the file, commit and line', () => {
  const [finding] = scanDiff(diffOf('src/app.js', ['fine', `key = ${TOKENS['GitHub token']}`]));
  assert.equal(finding.source, 'src/app.js');
  assert.equal(finding.commit, 'abcdef12');
  assert.equal(finding.line, 13);
});

test('removed lines are not findings', () => {
  const diff = [
    'commit:abcdef12', '--- a/x', '+++ b/x', '@@ -1 +0,0 @@', `-key = ${TOKENS['GitHub token']}`,
  ].join('\n');
  assert.deepEqual(scanDiff(diff), []);
});

test('a sensitive file in an unpushed commit is a finding', () => {
  const [finding] = scanDiff(diffOf('.env', ['NAME=value']));
  assert.equal(finding.rule, 'sensitive file');
});

test('recognizes sensitive file names', () => {
  for (const file of ['.env', '.env.local', 'config/.env.production', 'id_rsa', 'server.pem', 'prod.tfvars', '.npmrc', 'credentials.json']) {
    assert.ok(isSensitivePath(file), file);
  }
});

test('leaves template and ordinary files alone', () => {
  for (const file of ['.env.example', '.env.sample', '.env.template', 'README.md', 'src/env.js', 'environment.ts']) {
    assert.ok(!isSensitivePath(file), file);
  }
});
