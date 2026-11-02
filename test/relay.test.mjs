import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { deniedNote, formatReply, handlePrompt, innerArgs, permissionArgs, relayOutput, resolveMode } from '../scripts/relay.mjs';
import { makeRepo, write } from './helpers.mjs';

function vm(t, { mode = 'auto', debug = false } = {}) {
  const { root, base } = makeRepo(t, { remote: false });
  process.env.HOME = base;
  write(root, '.skyhop/session-id', 'abc\n');
  write(root, '.skyhop/session.jsonl', '{}\n');
  write(root, '.skyhop/mode', `${mode}\n`);
  if (debug) write(root, '.skyhop/debug', '');
  const calls = [];
  const resumeWith = result => (_root, sessionId, usedMode, prompt) => {
    calls.push({ sessionId, usedMode, prompt });
    return result;
  };
  const context = output => output.hookSpecificOutput.additionalContext;
  return { root, base, calls, resumeWith, context, exists: name => fs.existsSync(path.join(root, '.skyhop', name)) };
}

const ok = text => ({ status: 0, stdout: JSON.stringify({ result: text }) });

test('a message reaches the resumed session with the handoff mode', t => {
  const { root, base, calls, resumeWith, context } = vm(t);
  const output = handlePrompt({ prompt: 'hello', hookMode: 'default', root, resume: resumeWith(ok('hi there')) });
  assert.deepEqual(calls, [{ sessionId: 'abc', usedMode: 'auto', prompt: 'hello' }]);
  assert.match(context(output), /<<<SKYHOP_REPLY\nhi there\nSKYHOP_REPLY>>>/);
  assert.ok(fs.existsSync(path.join(base, '.claude/projects/skyhop-import/abc.jsonl')));
});

test('the transcript is restored once, so later messages keep their history', t => {
  const { root, base, resumeWith } = vm(t);
  handlePrompt({ prompt: 'one', hookMode: 'default', root, resume: resumeWith(ok('a')) });
  const restored = path.join(base, '.claude/projects/skyhop-import/abc.jsonl');
  fs.writeFileSync(restored, 'grown by the resumed session\n');
  handlePrompt({ prompt: 'two', hookMode: 'default', root, resume: resumeWith(ok('b')) });
  assert.equal(fs.readFileSync(restored, 'utf8'), 'grown by the resumed session\n');
});

test('debug mode tags the reply', t => {
  const { root, resumeWith, context } = vm(t, { debug: true });
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(ok('y')) });
  assert.match(context(output), /\[skyhop-relay hook=default used=auto\]/);
});

test('no debug tag appears in normal use', t => {
  const { root, resumeWith, context } = vm(t);
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(ok('y')) });
  assert.doesNotMatch(context(output), /skyhop-relay hook/);
});

test('a resume that fails on the first message falls back to the brief', t => {
  const { root, resumeWith, context, exists } = vm(t);
  const failed = { status: 1, stdout: '', stderr: 'No conversation found' };
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(failed) });
  assert.match(context(output), /No conversation found/);
  assert.match(context(output), /\.skyhop\/brief\.md/);
  assert.ok(exists('fallback'));
});

test('after a fallback the outer session handles messages itself', t => {
  const { root, calls, resumeWith } = vm(t);
  write(root, '.skyhop/fallback', '');
  assert.equal(handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(ok('y')) }), null);
  assert.equal(calls.length, 0);
});

test('a failure after a working message reports the error and keeps the relay on', t => {
  const { root, resumeWith, context, exists } = vm(t);
  handlePrompt({ prompt: 'one', hookMode: 'default', root, resume: resumeWith(ok('fine')) });
  const output = handlePrompt({ prompt: 'two', hookMode: 'default', root, resume: resumeWith({ status: 1, stdout: '', stderr: 'boom' }) });
  assert.match(context(output), /Skyhop relay failed \(exit 1\): boom/);
  assert.ok(!exists('fallback'));
});

test('a timeout does not end the relay, even on the first message', t => {
  const { root, resumeWith, context, exists } = vm(t);
  const timedOut = { status: null, stdout: '', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) };
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(timedOut) });
  assert.match(context(output), /ran out of time/);
  assert.ok(!exists('fallback'));
});

test('an error from the model is shown and does not end the relay', t => {
  const { root, resumeWith, context, exists } = vm(t);
  const failed = { status: 1, stdout: JSON.stringify({ is_error: true, result: 'rate limited' }) };
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(failed) });
  assert.match(context(output), /rate limited/);
  assert.ok(!exists('fallback'));
});

test('a long reply is saved to a file in the session', t => {
  const { root, resumeWith, context } = vm(t);
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(ok('z'.repeat(12000))) });
  assert.match(context(output), /reply\.md/);
  assert.equal(fs.readFileSync(path.join(root, '.skyhop/reply.md'), 'utf8').length, 12000);
});

test('never blocks the prompt, because that shows a warning on claude.ai', () => {
  const output = relayOutput('hello', () => assert.fail('a short reply needs no file'));
  assert.equal(output.decision, undefined);
  assert.equal(output.continue, undefined);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('puts a short reply directly in the context', () => {
  const context = relayOutput('hello', () => '').hookSpecificOutput.additionalContext;
  assert.match(context, /<<<SKYHOP_REPLY\nhello\nSKYHOP_REPLY>>>/);
});

test('sends a long reply through a file and stays under the hook cap', () => {
  const long = 'x'.repeat(20000);
  let saved;
  const output = relayOutput(long, reply => { saved = reply; return '/repo/.skyhop/reply.md'; });
  const context = output.hookSpecificOutput.additionalContext;
  assert.equal(saved, long);
  assert.match(context, /\/repo\/\.skyhop\/reply\.md/);
  assert.ok(context.length < 10000);
});

test('the largest inline reply still fits under the hook cap', () => {
  const context = relayOutput('x'.repeat(9000), () => '').hookSpecificOutput.additionalContext;
  assert.ok(context.length < 10000);
});

test('uses the handoff mode when the hook reports default', () => {
  assert.equal(resolveMode('default', 'auto'), 'auto');
  assert.equal(resolveMode(undefined, 'acceptEdits'), 'acceptEdits');
});

test('a mode the hook reports other than default wins', () => {
  assert.equal(resolveMode('plan', 'auto'), 'plan');
  assert.equal(resolveMode('acceptEdits', 'auto'), 'acceptEdits');
});

test('keeps the hook mode when there is no usable handoff mode', () => {
  assert.equal(resolveMode('default', undefined), 'default');
  assert.equal(resolveMode('default', 'bypassPermissions'), 'default');
  assert.equal(resolveMode('default', 'default'), 'default');
});

test('passes the chat mode to the resumed session', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'plan', 'dontAsk']) {
    assert.deepEqual(permissionArgs(mode), ['--permission-mode', mode]);
  }
});

test('never passes bypassPermissions or an unknown mode', () => {
  assert.deepEqual(permissionArgs('bypassPermissions'), []);
  assert.deepEqual(permissionArgs('somethingNew'), []);
  assert.deepEqual(permissionArgs(undefined), []);
});

test('keeps the prompt out of the arguments', () => {
  assert.deepEqual(innerArgs('abc', 'auto'), [
    '-p', '--resume', 'abc', '--permission-mode', 'auto', '--output-format', 'json',
  ]);
});

test('names each refused tool once', () => {
  const denials = [{ tool_name: 'Write' }, { tool_name: 'Write' }, { tool_name: 'Bash' }];
  assert.match(deniedNote(denials, 'acceptEdits'), /Blocked in acceptEdits mode: Write, Bash\./);
});

test('adds no note when nothing was refused', () => {
  assert.equal(deniedNote([], 'auto'), '');
  assert.equal(deniedNote(undefined, 'auto'), '');
});

test('joins the reply and the refusal note', () => {
  const reply = formatReply({ result: 'Done.', permission_denials: [{ tool_name: 'Bash' }] }, 'default');
  assert.match(reply, /^Done\.\n\nBlocked in default mode: Bash\./);
});
