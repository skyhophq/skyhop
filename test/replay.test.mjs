// The session's earlier conversation shown in the cloud chat as real messages: the
// relay's side in the VM (replay.mjs), and the Mac's side in /skyhop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { replayHistory } from '../scripts/conversation.mjs';
import { handlePrompt, viaChatPlugin } from '../scripts/relay.mjs';
import { HISTORY_MARK, READY_PING, replayStep } from '../scripts/replay.mjs';
import { newKey, sealHistory } from '../scripts/sync.mjs';
import { tempDir, write } from './helpers.mjs';
import { SESSION, setup } from './roundtrip.mjs';

const HISTORY = {
  intro: 'Skyhop: your last 2 exchanges follow.',
  exchanges: [
    { you: 'Why does the pump skip Sundays?', claude: 'Because of the cron line.' },
    { you: 'ok fix it', claude: '' },
  ],
};
const RESTART_NOTICE = "This session's worker process was restarted. If your previous turn was interrupted, resume it.";

// A VM's repository with a handoff that carries a history, and that VM's home folder.
function vm(t, { history = HISTORY } = {}) {
  const base = tempDir(t);
  const root = path.join(base, 'repo');
  const home = path.join(base, 'vm-home');
  const key = newKey();
  write(root, '.skyhop/sync-key', `${key}\n`);
  if (history) fs.writeFileSync(path.join(root, '.skyhop/history.enc'), sealHistory(history, key));
  write(root, '.skyhop/chat-plugin/hooks/chat.ts', '// the plugin\n');
  fs.mkdirSync(home, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = realHome; });
  const calls = { ready: 0, restart: 0 };
  let isLoaded = false;
  const step = prompt => replayStep({
    root, prompt,
    ready: () => { calls.ready += 1; return true; },
    restart: () => { calls.restart += 1; return true; },
    loaded: () => isLoaded,
  });
  const answer = () => JSON.parse(fs.readFileSync(path.join(home, '.skyhop-chat/answer.json'), 'utf8')).text;
  const said = result => result.output.hookSpecificOutput.additionalContext;
  return { root, home, calls, step, answer, said, load: () => { isLoaded = true; } };
}

test('the first message installs the plugin for the VM user and restarts the chat once', t => {
  const { home, calls, step, said } = vm(t);
  write(home, '.claude/settings.json', '{"env":{"OTHER":"1"},"model":"haiku"}');

  assert.match(said(step(`Project x. Setting up.\n\n[skyhop-key:abc]\n${HISTORY_MARK}`)), /Skyhop is setting up this chat/);
  assert.equal(calls.restart, 1);
  assert.equal(calls.ready, 0);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_PLUGIN_DIRS, path.join(home, '.skyhop-chat/plugin'));
  assert.equal(settings.env.OTHER, '1');
  assert.equal(settings.model, 'haiku');
  assert.ok(fs.existsSync(path.join(home, '.skyhop-chat/plugin/hooks/chat.ts')));

  // Still not loaded when the cloud says the chat restarted: it waits, and never restarts twice.
  assert.match(said(step(RESTART_NOTICE)), /still setting up/);
  assert.match(said(step(`again\n${HISTORY_MARK}`)), /could not show your earlier conversation/);
  assert.equal(calls.restart, 1);
});

test('after the restart each old message gets its old reply, and then the relay takes over', t => {
  const { calls, step, answer, load } = vm(t);
  step(`Setting up.\n${HISTORY_MARK}`);
  load();

  assert.deepEqual(step(RESTART_NOTICE), { output: null });
  assert.equal(answer(), HISTORY.intro);
  assert.equal(calls.ready, 1);

  assert.deepEqual(step('  Why does the pump\nskip Sundays? '), { output: null }, 'spacing differences still match');
  assert.equal(answer(), 'Because of the cron line.');
  assert.deepEqual(step('ok fix it'), { output: null });
  assert.match(answer(), /without writing a reply/);

  // The message that starts the work is not the replay's, and nothing is left to answer it.
  assert.equal(step('Skyhop has moved you to a cloud VM.'), undefined);
  assert.equal(answer(), undefined);
  assert.equal(step('Why does the pump skip Sundays?'), undefined, 'the replay is over');
});

test('a chat whose plugin is already loaded starts replaying at once, and a late ping gets a short answer', t => {
  const { calls, step, answer, load } = vm(t);
  load();
  assert.deepEqual(step(`Back again.\n${HISTORY_MARK}`), { output: null });
  assert.equal(calls.restart, 0);
  assert.equal(calls.ready, 1);
  assert.deepEqual(step(`Skyhop: show my earlier conversation here. ${READY_PING}`), { output: null });
  assert.equal(answer(), 'Skyhop: this chat is ready.');
});

test('a message the user sends in the middle ends the replay, and one without a history is left alone', t => {
  const { step, load } = vm(t);
  assert.equal(step('hello'), undefined, 'no replay was asked for');
  load();
  step(`Setting up.\n${HISTORY_MARK}`);
  step('Why does the pump skip Sundays?');
  assert.equal(step('wait, stop'), undefined);
  assert.equal(step('ok fix it'), undefined);
});

test('a handoff with no readable history says so and goes on with the recap', t => {
  const { calls, step, said } = vm(t, { history: null });
  assert.match(said(step(`Setting up.\n${HISTORY_MARK}`)), /could not show your earlier conversation/);
  assert.equal(calls.restart, 0);
  assert.equal(step('the recap'), undefined);
});

const line = fields => `${JSON.stringify({ sessionId: SESSION, ...fields })}\n`;
const TRANSCRIPT = line({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-11-01T10:00:00.000Z', message: { content: 'first question' } })
  + line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-01T10:00:05.000Z', message: { content: [{ type: 'text', text: 'first answer' }, { type: 'tool_use', name: 'Bash', input: {} }] } })
  + line({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-11-02T10:00:00.000Z', message: { content: '<command-name>/compact</command-name><command-args>now</command-args>' } })
  + line({ type: 'user', uuid: 'u3', parentUuid: 'u2', timestamp: '2026-11-03T10:00:00.000Z', message: { content: 'what does [skyhop-reopen:x] do?' } })
  + line({ type: 'assistant', uuid: 'a3', parentUuid: 'u3', timestamp: '2026-11-03T10:00:05.000Z', message: { content: [{ type: 'text', text: 'It switches the chat.' }] } });

test('the exchanges to replay are word for word, with commands and Skyhop markers defused', t => {
  const file = path.join(tempDir(t), 'session.jsonl');
  fs.writeFileSync(file, TRANSCRIPT);
  assert.deepEqual(replayHistory(file), [
    { you: 'first question', claude: 'first answer' },
    { you: '(command) /compact now', claude: '' },
    { you: 'what does [skyhop -reopen:x] do?', claude: 'It switches the chat.' },
  ]);
  assert.deepEqual(replayHistory(file, { limit: 1 }).map(e => e.you), ['what does [skyhop -reopen:x] do?']);
  assert.deepEqual(replayHistory(file, { since: '2026-11-02T00:00:00.000Z' }).map(e => e.you), ['(command) /compact now', 'what does [skyhop -reopen:x] do?']);
});

const sentLog = base => fs.readFileSync(path.join(base, 'sent-log'), 'utf8').split('\n=====\n').filter(Boolean);
const FAST = { SKYHOP_HISTORY: '50', SKYHOP_HISTORY_SPACING_MS: '0', SKYHOP_HISTORY_WAIT_MS: '300', SKYHOP_HISTORY_PING_MS: '300' };

test('/skyhop starts the chat with a setup message, posts the old messages once it is ready, then the real first message', t => {
  const { home, base, skyhop } = setup(t);
  fs.writeFileSync(path.join(home, `.claude/projects/some-project/${SESSION}.jsonl`), TRANSCRIPT);
  const brief = path.join(home, '.skyhop/briefs/brief.md');

  const plan = skyhop(['--brief', brief, '--session', SESSION, '--dry-run'], FAST);
  assert.match(plan.output, /History: +the cloud chat shows your last 3 exchange\(s\) as real messages/);

  const result = skyhop(['--brief', brief, '--session', SESSION, '--yes'], { ...FAST, FAKE_CLAUDE_READY: '1' });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /The cloud chat now shows 3 exchange\(s\) of your conversation/);

  const launch = fs.readFileSync(path.join(base, 'launch-prompt'), 'utf8');
  assert.match(launch, /Skyhop is moving this session to the cloud/);
  assert.match(launch, /\[skyhop-key:[A-Za-z0-9+/=]+\]\n\[skyhop-history\]$/);
  assert.doesNotMatch(launch, /Ship it/, 'the recap waits for the real first message');

  const sent = sentLog(base);
  assert.deepEqual(sent.slice(0, 3), ['first question', '(command) /compact now', 'what does [skyhop -reopen:x] do?']);
  assert.equal(sent.length, 4);
  assert.match(sent[3], /Skyhop has moved you to a cloud VM/);
  assert.match(sent[3], /Ship it/);
  assert.doesNotMatch(sent[3], /word for word|skyhop-key/, 'the chat already shows the messages, and has the key');

  // The handoff carries the history encrypted, and the plugin that shows it.
  const files = fs.readdirSync(path.join(base, 'vm/.skyhop'));
  assert.ok(files.includes('history.enc') && files.includes('chat-plugin') && files.includes('replay.mjs'));
  assert.ok(!fs.readFileSync(path.join(base, 'vm/.skyhop/history.enc')).includes('first question'));
});

test('a chat that never gets ready is asked once, then gets the recap as before', t => {
  const { home, base, skyhop } = setup(t);
  fs.writeFileSync(path.join(home, `.claude/projects/some-project/${SESSION}.jsonl`), TRANSCRIPT);
  const result = skyhop(['--brief', path.join(home, '.skyhop/briefs/brief.md'), '--session', SESSION, '--yes'], FAST);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /starts with a recap instead/);
  const sent = sentLog(base);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /show my earlier conversation here\. \[skyhop-ready\?\]/);
  assert.match(sent[1], /Skyhop has moved you to a cloud VM/);
  assert.match(sent[1], /Recent conversation, word for word/);
});

test('--history off hands off the old way', t => {
  const { home, base, skyhop } = setup(t);
  fs.writeFileSync(path.join(home, `.claude/projects/some-project/${SESSION}.jsonl`), TRANSCRIPT);
  const result = skyhop(['--brief', path.join(home, '.skyhop/briefs/brief.md'), '--session', SESSION, '--yes', '--history', 'off'], FAST);
  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(path.join(base, 'launch-prompt'), 'utf8'), /Skyhop has moved you to a cloud VM/);
  assert.ok(!fs.existsSync(path.join(base, 'sent-log')));
  assert.ok(!fs.existsSync(path.join(base, 'vm/.skyhop/history.enc')));
});

test('in the VM: setup, the replayed messages, then the first real message is worked on and saved', t => {
  const { home, base, vm: vmDir, skyhop, cloudWork, syncBranches } = setup(t);
  fs.writeFileSync(path.join(home, `.claude/projects/some-project/${SESSION}.jsonl`), TRANSCRIPT);
  const result = skyhop(['--brief', path.join(home, '.skyhop/briefs/brief.md'), '--session', SESSION, '--yes'], { ...FAST, FAKE_CLAUDE_READY: '1' });
  assert.equal(result.status, 0, result.output);
  const sent = sentLog(base);

  const realHome = process.env.HOME;
  process.env.HOME = path.join(base, 'vm-home');
  try {
    const relay = prompt => handlePrompt({
      prompt, hookMode: 'default', root: vmDir,
      replay: input => replayStep({ ...input, restart: () => true, loaded: () => true }),
    });
    assert.equal(relay(fs.readFileSync(path.join(base, 'launch-prompt'), 'utf8')), null);
    for (const message of sent.slice(0, -1)) assert.equal(relay(message), null);
  } finally {
    process.env.HOME = realHome;
  }
  const shown = cloudWork(vmDir, { prompt: sent.at(-1) });
  assert.match(shown, /done/);
  assert.match(syncBranches(), /-chat/);
  assert.match(syncBranches(), /-code/);
});

test('with the plugin loaded the relay shows its words and waits through the plugin, and the model gets nothing', t => {
  const base = tempDir(t);
  const realHome = process.env.HOME;
  process.env.HOME = base;
  t.after(() => { process.env.HOME = realHome; });
  const answer = () => JSON.parse(fs.readFileSync(path.join(base, '.skyhop-chat/answer.json'), 'utf8'));
  const hook = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'for the model' } };

  assert.equal(viaChatPlugin({ ...hook, say: 'Permission mode is now plan.' }, true), null);
  assert.deepEqual(answer(), { text: 'Permission mode is now plan.' });
  assert.equal(viaChatPlugin({ ...hook, wait: true }, true), null);
  assert.deepEqual(answer(), { wait: true });

  // Without the plugin, and for anything the relay leaves to the model, the hook output goes out as before.
  assert.deepEqual(viaChatPlugin({ ...hook, say: 'x' }, false), hook);
  assert.deepEqual(viaChatPlugin({ ...hook, wait: true }, false), hook);
  assert.deepEqual(viaChatPlugin(hook, true), hook);
  assert.equal(viaChatPlugin(null, true), null);
});
