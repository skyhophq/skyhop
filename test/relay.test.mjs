import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  deniedNote, formatReply, handlePrompt, innerArgs, modeRequest, parseRun, permissionArgs, relayOutput, resolveMode, stepsNote,
} from '../scripts/relay.mjs';
import { newKey, sealTranscript } from '../scripts/sync.mjs';
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

const ok = text => ({ status: 0, stdout: JSON.stringify({ type: 'result', result: text }) });

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

test('reads the reply and tool steps from the event stream', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }, { type: 'tool_use', name: 'Bash', input: { description: 'Run the tests', command: 'npm test' } }] } }),
    'not json',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/app.js' } }] } }),
    JSON.stringify({ type: 'result', result: 'All done' }),
  ].join('\n');
  const { result, steps } = parseRun(stdout);
  assert.equal(result.result, 'All done');
  assert.deepEqual(steps, ['Bash: Run the tests', 'Edit: src/app.js']);
});

test('a run with no result event counts as a failure', () => {
  assert.throws(() => parseRun('{"type":"system"}'), /no result/);
});

test('long step lists are shortened', () => {
  const note = stepsNote(Array.from({ length: 15 }, (_, i) => `step ${i}`));
  assert.match(note, /step 11\n- and 3 more/);
  assert.doesNotMatch(note, /step 12/);
  assert.equal(stepsNote([]), '');
});

test('the steps taken appear in the reply', t => {
  const { root, resumeWith, context } = vm(t);
  const events = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.txt' } }] } }),
    JSON.stringify({ type: 'result', result: 'Wrote it' }),
  ].join('\n');
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith({ status: 0, stdout: events }) });
  assert.match(context(output), /Wrote it\n\nSteps taken:\n- Write: a\.txt/);
});

test('recognizes a mode change sent in the chat', () => {
  assert.equal(modeRequest('skyhop mode auto'), 'auto');
  assert.equal(modeRequest('  Skyhop Mode acceptedits '), 'acceptEdits');
  assert.equal(modeRequest('skyhop mode plan'), 'plan');
  assert.equal(modeRequest('skyhop mode bypassPermissions'), null);
  assert.equal(modeRequest('what is skyhop mode auto about?'), null);
});

test('a mode change is applied to later messages without reaching the session', t => {
  const { root, calls, resumeWith, context } = vm(t);
  const output = handlePrompt({ prompt: 'skyhop mode acceptEdits', hookMode: 'default', root, resume: resumeWith(ok('no')) });
  assert.match(context(output), /Permission mode is now acceptEdits/);
  assert.equal(calls.length, 0);
  handlePrompt({ prompt: 'do it', hookMode: 'default', root, resume: resumeWith(ok('done')) });
  assert.equal(calls[0].usedMode, 'acceptEdits');
});

test('a blocked tool tells the user how to allow it', () => {
  assert.match(deniedNote([{ tool_name: 'Bash' }], 'plan'), /send "skyhop mode acceptEdits"/);
});

test('the key in the first message is stored and never reaches the resumed session', t => {
  const { root, calls, resumeWith } = vm(t);
  handlePrompt({ prompt: 'Carry on.\n\n[skyhop-key:abc123==]', hookMode: 'default', root, resume: resumeWith(ok('done')) });
  assert.equal(calls[0].prompt, 'Carry on.');
  assert.equal(fs.readFileSync(path.join(root, '.skyhop/sync-key'), 'utf8').trim(), 'abc123==');
  assert.equal(fs.statSync(path.join(root, '.skyhop/sync-key')).mode & 0o777, 0o600);
});

test('a rebuilt VM finds its key again in the chat history', t => {
  const { root, base, resumeWith } = vm(t);
  const chat = path.join(base, 'chat.jsonl');
  fs.writeFileSync(chat, '{"message":"Carry on. [skyhop-key:recovered==]"}\n');
  handlePrompt({ prompt: 'next', hookMode: 'default', root, chatTranscript: chat, resume: resumeWith(ok('done')) });
  assert.equal(fs.readFileSync(path.join(root, '.skyhop/sync-key'), 'utf8').trim(), 'recovered==');
});

test('an encrypted transcript is opened in the VM', t => {
  const { root, base, resumeWith } = vm(t);
  const key = newKey();
  fs.rmSync(path.join(root, '.skyhop/session.jsonl'));
  sealTranscript(Buffer.from('{"line":"secret history"}\n'), key, 20).forEach((part, index) => {
    fs.writeFileSync(path.join(root, '.skyhop', `session.enc.${String(index).padStart(3, '0')}`), part);
  });
  handlePrompt({ prompt: `go [skyhop-key:${key}]`, hookMode: 'default', root, resume: resumeWith(ok('done')) });
  assert.equal(fs.readFileSync(path.join(base, '.claude/projects/skyhop-import/abc.jsonl'), 'utf8'), '{"line":"secret history"}\n');
});

test('a save warning is added to the reply, and the reply still arrives', t => {
  const { root, resumeWith, context } = vm(t);
  const output = handlePrompt({ prompt: 'x', hookMode: 'default', root, resume: resumeWith(ok('the reply')), save: () => 'could not save' });
  assert.match(context(output), /the reply[\s\S]*could not save/);
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
  const failed = { status: 1, stdout: JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' }) };
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
    '-p', '--resume', 'abc', '--permission-mode', 'auto', '--output-format', 'stream-json', '--verbose',
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
