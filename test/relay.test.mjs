import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  deniedNote, formatReply, handlePrompt, innerArgs, jobStatus, modeRequest, parseRun, permissionArgs, readEvents, relayOutput,
  replyNow, resolveMode, runJob, stepsNote, stripRecap, trimPartialLine, waitForReply, WAIT_COMMAND,
} from '../scripts/relay.mjs';
import { newKey, sealTranscript } from '../scripts/sync.mjs';
import { alive, makeRepo, sleeper, write } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '../scripts');
const FIXTURES = path.join(HERE, 'fixtures');

const ok = text => ({ status: 0, stdout: JSON.stringify({ type: 'result', result: text }) });
const toolUse = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

async function until(check, ms = 5000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function deadPid() {
  return spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout.trim();
}

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
  const jobPath = name => path.join(root, '.skyhop/job', name);
  const job = () => JSON.parse(fs.readFileSync(jobPath('job.json'), 'utf8'));
  // The hook starts the job, here run to the end at once, and `wait` collects the reply.
  const send = ({ prompt, result = ok('done'), resume = resumeWith(result), save, start, chatTranscript, collect = true, github }) => {
    const extra = { ...(save ? { save } : {}), ...(github ? { github } : {}) };
    const run = start ?? (dir => {
      runJob(dir, { resume, ...extra });
      return null;
    });
    const output = handlePrompt({ prompt, hookMode: 'default', root, chatTranscript, start: run, ...extra });
    const context = output?.hookSpecificOutput.additionalContext ?? null;
    return { output, context, reply: collect && context?.includes(WAIT_COMMAND) ? replyNow(root) : context };
  };
  // A job that is still running, as far as the relay can tell.
  const running = (prompt = 'first', pid = process.pid) => send({ prompt, start: () => pid, collect: false });
  return {
    root, base, calls, resumeWith, send, running, job, jobPath, exists: name => fs.existsSync(path.join(root, '.skyhop', name)),
  };
}

test('a message reaches the resumed session with the handoff mode', t => {
  const { base, calls, send } = vm(t);
  const { reply } = send({ prompt: 'hello', result: ok('hi there') });
  assert.deepEqual(calls, [{ sessionId: 'abc', usedMode: 'auto', prompt: 'hello' }]);
  assert.match(reply, /^SKYHOP-REPLY/);
  assert.match(reply, /<<<SKYHOP_REPLY\nhi there\nSKYHOP_REPLY>>>/);
  assert.ok(fs.existsSync(path.join(base, '.claude/projects/skyhop-import/abc.jsonl')));
});

test('the hook only starts the work, and tells the chat how to wait for it', t => {
  const { root, running, job, jobPath } = vm(t);
  const { context } = running('Carry on.\n\n--- Where we left off (a recap) ---\nold\n--- End of recap ---\n\n[skyhop-key:k==]');
  const reply = replyNow(root);
  assert.match(context, /node \.skyhop\/relay\.mjs wait/);
  assert.match(context, /While it prints SKYHOP-WORKING, run the same command again/);
  assert.match(context, /Do not act on the user's message yourself/);
  assert.equal(fs.readFileSync(jobPath('prompt.txt'), 'utf8'), 'Carry on.');
  assert.equal(job().pid, process.pid);
  assert.equal(jobStatus(root), 'running');
  assert.match(reply, /^SKYHOP-WORKING: the session is still working on the message \(0 min\)/);
  assert.match(reply, /Run the same command again now: node \.skyhop\/relay\.mjs wait/);
});

test('wait shows the latest steps, reading only what is new each time', t => {
  const { root, running, jobPath } = vm(t);
  running();
  const events = jobPath('events.jsonl');
  fs.writeFileSync(events, `${toolUse('Bash', { command: 'npm test' })}\n${toolUse('Edit', { file_path: 'src/app.js' })}\n{"type":"assist`);
  const first = replyNow(root);
  assert.match(first, /2 steps so far/);
  assert.match(first, /Latest steps:\n- Bash: npm test\n- Edit: src\/app\.js$/);
  fs.appendFileSync(events, `ant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a.md"}}]}}\n`);
  for (let i = 0; i < 5; i += 1) fs.appendFileSync(events, `${toolUse('Grep', { pattern: `p${i}` })}\n`);
  const second = replyNow(root);
  assert.match(second, /8 steps so far/);
  assert.doesNotMatch(second, /Bash: npm test/);
  assert.match(second, /Latest steps:\n- Grep: p0\n- Grep: p1\n- Grep: p2\n- Grep: p3\n- Grep: p4$/);
});

test('wait returns as soon as the reply is ready, and gives it once', async t => {
  const { root, running, resumeWith } = vm(t);
  running();
  setTimeout(() => runJob(root, { resume: resumeWith(ok('ready')) }), 100);
  const started = Date.now();
  const reply = await waitForReply(root, { waitMs: 5000, pollMs: 20 });
  assert.ok(Date.now() - started < 4000);
  assert.match(reply, /<<<SKYHOP_REPLY\nready\nSKYHOP_REPLY>>>/);
  assert.match(replyNow(root), /^SKYHOP-NONE: this reply was already given/);
});

test('wait gives up after its time and says to run it again', async t => {
  const { root, running } = vm(t);
  running();
  const reply = await waitForReply(root, { waitMs: 100, pollMs: 20 });
  assert.match(reply, /^SKYHOP-WORKING/);
});

test('with nothing running, wait says so', t => {
  const { root } = vm(t);
  assert.match(replyNow(root), /^SKYHOP-NONE: no Skyhop message is running/);
});

test('a message sent while the session works is not passed on, and the reply asks for it again', t => {
  const { root, calls, running, send, resumeWith } = vm(t);
  running('first');
  const second = send({ prompt: 'second', resume: () => assert.fail('a second run must not start') });
  assert.match(second.context, /still working on the user's previous message, so this new message was not passed to it/);
  assert.match(second.context, /node \.skyhop\/relay\.mjs wait/);
  assert.equal(fs.readFileSync(path.join(root, '.skyhop/job/prompt.txt'), 'utf8'), 'first');
  runJob(root, { resume: resumeWith(ok('the first reply')) });
  const reply = replyNow(root);
  assert.match(reply, /the first reply/);
  assert.match(reply, /was not passed to the session, so they should send it again/);
  assert.deepEqual(calls.map(call => call.prompt), ['first']);
});

test('a reply that finished after the chat stopped waiting is shown with the next message', t => {
  const { root, running, send, resumeWith } = vm(t);
  running('first');
  runJob(root, { resume: resumeWith(ok('finished while nobody waited')) });
  const next = send({ prompt: 'are you done?', resume: () => assert.fail('the old reply comes first') });
  assert.match(next.context, /has finished the user's previous message, but its reply has not been shown yet/);
  assert.match(next.reply, /finished while nobody waited/);
  assert.match(next.reply, /send it again/);
  const after = send({ prompt: 'are you done?', result: ok('yes') });
  assert.match(after.reply, /<<<SKYHOP_REPLY\nyes\nSKYHOP_REPLY>>>/);
});

test('a job whose process is gone is reported instead of waited on forever', t => {
  const { root, running } = vm(t);
  running('first', Number(deadPid()));
  assert.equal(jobStatus(root), 'lost');
  assert.match(replyNow(root), /stopped before it finished this message, so there is no reply/);
  assert.match(replyNow(root), /^SKYHOP-NONE/);
});

test('after a lost job the next message carries on and says what happened', t => {
  const { running, send } = vm(t);
  running('first', Number(deadPid()));
  const { reply } = send({ prompt: 'next', result: ok('carried on') });
  assert.match(reply, /the previous message stopped before it finished[\s\S]*carried on/);
});

test('a job from before the VM restarted is not taken for a running one', t => {
  const { root, running, job, jobPath } = vm(t);
  running();
  fs.writeFileSync(jobPath('job.json'), JSON.stringify({ ...job(), boot: 'an-earlier-boot' }));
  assert.equal(jobStatus(root), 'lost');
});

test('a process that ended but was never collected does not count as running', t => {
  const { root, base, running } = vm(t);
  running('first', process.pid);
  write(base, `proc/${process.pid}/stat`, `${process.pid} (node (relay).mjs) Z 1 ${process.pid} 0\n`);
  write(base, 'proc/self/stat', '1 (x) S 0 1 0\n');
  process.env.SKYHOP_PROC_DIR = path.join(base, 'proc');
  t.after(() => delete process.env.SKYHOP_PROC_DIR);
  assert.equal(jobStatus(root), 'lost');
  fs.writeFileSync(path.join(base, `proc/${process.pid}/stat`), `${process.pid} (node (relay).mjs) S 1 ${process.pid} 0\n`);
  assert.equal(jobStatus(root), 'running');
});

test('a session that went home while its reply was running is not saved over', t => {
  const { send, exists } = vm(t);
  const states = ['open', 'closed'];
  const github = { check: () => ({ state: states.shift() ?? 'closed', target: 'origin', config: {} }), busy: () => 'busy-sha' };
  const { reply } = send({ prompt: 'x', result: ok('late reply'), github, save: () => assert.fail('nothing is saved after going home') });
  assert.match(reply, /late reply[\s\S]*went back to your computer while this reply was running/);
  assert.ok(exists('home'));
});

test('half a line left by a stopped VM is removed before the next run', t => {
  const { base, running, send, calls } = vm(t);
  running('first', Number(deadPid()));
  const transcript = path.join(base, '.claude/projects/skyhop-import/abc.jsonl');
  fs.appendFileSync(transcript, '{"type":"assistant","message":{"cont');
  send({ prompt: 'next' });
  assert.equal(calls.length, 1);
  assert.equal(fs.readFileSync(transcript, 'utf8'), '{}\n');
});

test('trimming never cuts into what was already saved', t => {
  const { base } = vm(t);
  const file = path.join(base, 'lines.jsonl');
  fs.writeFileSync(file, '{"a":1}\n{"b":');
  trimPartialLine(file, 11);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n{"b":');
  trimPartialLine(file, 8);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}\n');
});

test('trimming keeps whole lines and leaves other files alone', t => {
  const { base } = vm(t);
  const file = path.join(base, 'lines.jsonl');
  const long = `${'x'.repeat(100_000)}\n`;
  fs.writeFileSync(file, `${long}${'y'.repeat(70_000)}`);
  trimPartialLine(file);
  assert.equal(fs.readFileSync(file, 'utf8'), long);
  trimPartialLine(file);
  assert.equal(fs.readFileSync(file, 'utf8'), long);
  fs.writeFileSync(file, 'no line break at all');
  trimPartialLine(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'no line break at all');
});

test('skyhop stop ends a running job and its session, and saves what it did', async t => {
  const { root, running, send } = vm(t);
  const pid = sleeper(t);
  running('first', pid);
  const saved = [];
  const { context } = send({ prompt: 'skyhop stop', save: (_root, transcript) => saved.push(transcript) && 'saved note' });
  assert.match(context, /Stopped\. The session's work on that message so far is kept\.\n\nsaved note/);
  assert.ok(!alive(pid), 'stopping waits until the job is gone');
  assert.equal(saved.length, 1);
  await until(() => !alive(pid));
  assert.match(replyNow(root), /^SKYHOP-NONE/);
  assert.equal(send({ prompt: 'skyhop stop' }).context.includes('Nothing is running'), true);
});

test('reads events in chunks, including lines longer than a chunk', t => {
  const { base } = vm(t);
  const file = path.join(base, 'events.jsonl');
  const big = JSON.stringify({ type: 'user', text: 'z'.repeat(3 * 1024 * 1024) });
  fs.writeFileSync(file, `${toolUse('A', {})}\n${big}\n${toolUse('B', {})}\n{"type":"result","result":"end"}`);
  const seen = [];
  const offset = readEvents(file, 0, event => seen.push(event.type));
  assert.deepEqual(seen, ['assistant', 'user', 'assistant']);
  const rest = [];
  assert.equal(readEvents(file, offset, event => rest.push(event.type), { final: true }), fs.statSync(file).size);
  assert.deepEqual(rest, ['result']);
});

test('the real background runner works end to end, and the hook returns at once', async t => {
  const { root, base } = vm(t);
  for (const script of ['relay.mjs', 'sync.mjs', 'secrets.mjs']) fs.copyFileSync(path.join(SCRIPTS, script), path.join(root, '.skyhop', script));
  const env = {
    ...process.env, HOME: base, PATH: `${FIXTURES}:${process.env.PATH}`, FAKE_CLAUDE_DIR: base, FAKE_INNER_SECONDS: '2',
    SKYHOP_FORCE: '1', SKYHOP_INNER: '', CLAUDE_PROJECT_DIR: root, SKYHOP_WAIT_MS: '300',
  };
  const started = Date.now();
  const hook = spawnSync('node', ['.skyhop/relay.mjs'], { cwd: root, env, encoding: 'utf8', input: JSON.stringify({ prompt: 'hello', permission_mode: 'default' }) });
  assert.ok(Date.now() - started < 1800, 'the hook does not wait for the work');
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /node \.skyhop\/relay\.mjs wait/);

  const outputs = [];
  for (let i = 0; i < 40 && !outputs.at(-1)?.startsWith('SKYHOP-REPLY'); i += 1) {
    outputs.push(spawnSync('node', ['.skyhop/relay.mjs', 'wait'], { cwd: root, env, encoding: 'utf8' }).stdout.trim());
  }
  assert.match(outputs[0], /^SKYHOP-WORKING[\s\S]*- Bash: npm test/);
  assert.match(outputs.at(-1), /<<<SKYHOP_REPLY\nfake inner reply\n\nSteps taken:\n- Bash: npm test\nSKYHOP_REPLY>>>/);
  assert.equal(fs.readFileSync(path.join(base, 'inner-prompt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(base, 'inner-env'), 'utf8'), '1', 'the resumed session does not run the relay itself');
  assert.equal(jobStatus(root), 'delivered');
});

test('skyhop stop on the real runner also stops the session under it', async t => {
  const { root, base, job } = vm(t);
  for (const script of ['relay.mjs', 'sync.mjs', 'secrets.mjs']) fs.copyFileSync(path.join(SCRIPTS, script), path.join(root, '.skyhop', script));
  const env = {
    ...process.env, HOME: base, PATH: `${FIXTURES}:${process.env.PATH}`, FAKE_CLAUDE_DIR: base, FAKE_INNER_SECONDS: '3',
    SKYHOP_FORCE: '1', SKYHOP_INNER: '', CLAUDE_PROJECT_DIR: root,
  };
  const hook = prompt => spawnSync('node', ['.skyhop/relay.mjs'], { cwd: root, env, encoding: 'utf8', input: JSON.stringify({ prompt }) });
  hook('a long task');
  await until(() => fs.existsSync(path.join(base, 'inner-prompt')));
  const runner = job().pid;
  assert.match(JSON.parse(hook('skyhop stop').stdout).hookSpecificOutput.additionalContext, /Stopped\./);
  assert.ok(!alive(runner));
  await new Promise(resolve => setTimeout(resolve, 4000));
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.skyhop/job/events.jsonl'), 'utf8'), /fake inner reply/, 'the session under the runner stopped too');
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
  const { send } = vm(t);
  const events = [toolUse('Write', { file_path: 'a.txt' }), JSON.stringify({ type: 'result', result: 'Wrote it' })].join('\n');
  assert.match(send({ prompt: 'x', result: { status: 0, stdout: events } }).reply, /Wrote it\n\nSteps taken:\n- Write: a\.txt/);
});

test('recognizes a mode change sent in the chat', () => {
  assert.equal(modeRequest('skyhop mode auto'), 'auto');
  assert.equal(modeRequest('  Skyhop Mode acceptedits '), 'acceptEdits');
  assert.equal(modeRequest('skyhop mode plan'), 'plan');
  assert.equal(modeRequest('skyhop mode bypassPermissions'), null);
  assert.equal(modeRequest('what is skyhop mode auto about?'), null);
});

test('a mode change is applied to later messages without reaching the session', t => {
  const { calls, send } = vm(t);
  assert.match(send({ prompt: 'skyhop mode acceptEdits' }).context, /Permission mode is now acceptEdits/);
  assert.equal(calls.length, 0);
  send({ prompt: 'do it' });
  assert.equal(calls[0].usedMode, 'acceptEdits');
});

test('a mode change while the session works applies to the next message', t => {
  const { root, running, send, resumeWith, calls } = vm(t);
  running('first');
  assert.match(send({ prompt: 'skyhop mode plan' }).context, /Permission mode is now plan/);
  runJob(root, { resume: resumeWith(ok('one')) });
  replyNow(root);
  send({ prompt: 'two' });
  assert.equal(calls.at(-1).usedMode, 'plan');
});

test('a blocked tool tells the user how to allow it', () => {
  assert.match(deniedNote([{ tool_name: 'Bash' }], 'plan'), /send "skyhop mode acceptEdits"/);
});

test('the key in the first message is stored and never reaches the resumed session', t => {
  const { root, calls, send } = vm(t);
  send({ prompt: 'Carry on.\n\n[skyhop-key:abc123==]' });
  assert.equal(calls[0].prompt, 'Carry on.');
  assert.equal(fs.readFileSync(path.join(root, '.skyhop/sync-key'), 'utf8').trim(), 'abc123==');
  assert.equal(fs.statSync(path.join(root, '.skyhop/sync-key')).mode & 0o777, 0o600);
});

test('a rebuilt VM finds its key again in the chat history', t => {
  const { root, base, send } = vm(t);
  const chat = path.join(base, 'chat.jsonl');
  fs.writeFileSync(chat, '{"message":"Carry on. [skyhop-key:recovered==]"}\n');
  send({ prompt: 'next', chatTranscript: chat });
  assert.equal(fs.readFileSync(path.join(root, '.skyhop/sync-key'), 'utf8').trim(), 'recovered==');
});

test('an encrypted transcript is opened in the VM', t => {
  const { root, base, send } = vm(t);
  const key = newKey();
  fs.rmSync(path.join(root, '.skyhop/session.jsonl'));
  sealTranscript(Buffer.from('{"line":"secret history"}\n'), key, 20).forEach((part, index) => {
    fs.writeFileSync(path.join(root, '.skyhop', `session.enc.${String(index).padStart(3, '0')}`), part);
  });
  send({ prompt: `go [skyhop-key:${key}]` });
  assert.equal(fs.readFileSync(path.join(base, '.claude/projects/skyhop-import/abc.jsonl'), 'utf8'), '{"line":"secret history"}\n');
});

test('the transcript is restored once, so later messages keep their history', t => {
  const { base, send } = vm(t);
  send({ prompt: 'one' });
  const restored = path.join(base, '.claude/projects/skyhop-import/abc.jsonl');
  fs.writeFileSync(restored, 'grown by the resumed session\n');
  send({ prompt: 'two' });
  assert.equal(fs.readFileSync(restored, 'utf8'), 'grown by the resumed session\n');
});

test('the recap is for the user and never reaches the resumed session', t => {
  const { calls, send } = vm(t);
  send({ prompt: 'Carry on.\n\n--- Where we left off (a recap) ---\n\n## Goal\nShip it.\n\n--- End of recap ---\n\n[skyhop-key:abc==]' });
  assert.equal(calls[0].prompt, 'Carry on.');
});

test('a message with no recap is passed on unchanged', () => {
  assert.equal(stripRecap('just a message'), 'just a message');
  assert.equal(stripRecap('--- End of recap --- then --- Where we left off'), '--- End of recap --- then --- Where we left off');
});

test('a save warning is added to the reply, and the reply still arrives', t => {
  const { send } = vm(t);
  assert.match(send({ prompt: 'x', result: ok('the reply'), save: () => 'could not save' }).reply, /the reply[\s\S]*could not save/);
});

test('debug mode tags the reply', t => {
  const { send } = vm(t, { debug: true });
  assert.match(send({ prompt: 'x' }).reply, /\[skyhop-relay hook=default used=auto\]/);
});

test('no debug tag appears in normal use', t => {
  const { send } = vm(t);
  assert.doesNotMatch(send({ prompt: 'x' }).reply, /skyhop-relay hook/);
});

test('a resume that fails on the first message falls back to the brief', t => {
  const { send, exists } = vm(t);
  const { reply } = send({ prompt: 'x', result: { status: 1, stdout: '', stderr: 'No conversation found' } });
  assert.match(reply, /^SKYHOP-FALLBACK: Skyhop could not resume the original session in this VM \(No conversation found\)/);
  assert.match(reply, /\.skyhop\/brief\.md/);
  assert.ok(exists('fallback'));
});

test('a transcript that cannot be opened on the first message falls back to the brief at once', t => {
  const { root, send, exists } = vm(t);
  fs.rmSync(path.join(root, '.skyhop/session.jsonl'));
  const { context } = send({ prompt: 'x', resume: () => assert.fail('nothing to resume') });
  assert.match(context, /could not resume the original session/);
  assert.ok(exists('fallback'));
});

test('after a fallback the outer session handles messages itself', t => {
  const { root, calls, send } = vm(t);
  write(root, '.skyhop/fallback', '');
  assert.equal(send({ prompt: 'x' }).output, null);
  assert.equal(calls.length, 0);
});

test('a failure after a working message reports the error and keeps the relay on', t => {
  const { send, exists } = vm(t);
  send({ prompt: 'one', result: ok('fine') });
  const { reply } = send({ prompt: 'two', result: { status: 1, stdout: '', stderr: 'boom' } });
  assert.match(reply, /Skyhop relay failed \(exit 1\): boom/);
  assert.ok(!exists('fallback'));
});

test('a timeout does not end the relay, even on the first message', t => {
  const { send, exists } = vm(t);
  const timedOut = { status: null, stdout: '', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) };
  assert.match(send({ prompt: 'x', result: timedOut }).reply, /ran out of time/);
  assert.ok(!exists('fallback'));
});

test('an error from the model is shown and does not end the relay', t => {
  const { send, exists } = vm(t);
  const failed = { status: 1, stdout: JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' }) };
  assert.match(send({ prompt: 'x', result: failed }).reply, /rate limited/);
  assert.ok(!exists('fallback'));
});

test('a long reply is saved to a file in the session', t => {
  const { root, send } = vm(t);
  const { reply } = send({ prompt: 'x', result: ok('z'.repeat(12000)) });
  assert.match(reply, /reply\.md/);
  assert.ok(reply.length < 2000);
  assert.equal(fs.readFileSync(path.join(root, '.skyhop/reply.md'), 'utf8').length, 12000);
});

test('a runner that could not start is reported, not waited on', t => {
  const { send } = vm(t);
  const { reply } = send({ prompt: 'x', start: () => null });
  assert.match(reply, /could not start the resumed session/);
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
