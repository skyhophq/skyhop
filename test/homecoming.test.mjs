// Coming home with no command: starting Claude Code adds the cloud conversation to
// the session, and the first message here closes the cloud chat and brings the code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { run, tempDir, write } from './helpers.mjs';
import { CLOUD, CLOUD2, LOCAL, SESSION, setup } from './roundtrip.mjs';

const start = { source: 'startup', session_id: 'aaaaaaaa-0000-4000-8000-000000000000' };
const resume = { source: 'resume', session_id: SESSION };
const prompt = { session_id: SESSION, prompt: 'hello again' };
const TYPED_HERE = `{"type":"user","sessionId":"${SESSION}","message":{"content":"typed on the Mac"}}\n`;

test('starting Claude Code adds the cloud conversation and leaves the cloud chat open', t => {
  const { root, hook, handOff, cloudWork, localSession, remoteBranches, record } = setup(t);
  cloudWork(handOff());
  const out = hook('start', start);
  assert.match(out.systemMessage, /now has its cloud conversation here \(1 new message\(s\)\)/);
  assert.match(out.systemMessage, /Pick it in \/resume/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
  assert.notEqual(remoteBranches('skyhop-run'), '');
  assert.ok(!fs.existsSync(path.join(root, 'cloud-work.txt')));
  assert.equal(record().broughtBackAt, undefined);

  assert.match(hook('start', start).systemMessage, /is in the cloud\. Pick it in \/resume/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
});

test('the first message here closes the cloud chat and brings the code', t => {
  const { root, home, vm, hook, handOff, cloudWork, localSession, remoteBranches, syncBranches, record } = setup(t);
  cloudWork(handOff());
  hook('start', start);
  assert.match(hook('start', resume).systemMessage, /comes home when you send a message/);

  const out = hook('prompt', prompt);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /back from the cloud, and its cloud chat is closed/);
  assert.match(out.hookSpecificOutput.additionalContext, /in your files on main/);
  assert.equal(fs.readFileSync(path.join(root, 'cloud-work.txt'), 'utf8'), 'made in the cloud\n');
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
  assert.equal(remoteBranches('skyhop-run'), '');
  assert.equal(syncBranches(), '');
  assert.ok(record().broughtBackAt);
  assert.deepEqual(fs.readdirSync(path.join(home, '.skyhop/sessions')).filter(name => name.endsWith('.loaded')), []);
  assert.equal(hook('prompt', prompt), null);

  // The cloud chat now says where the session went, and saves nothing.
  const reply = cloudWork(vm, { prompt: 'still there?', check: false });
  assert.match(reply, /gone back to your computer/);
  assert.equal(syncBranches(), '');
  assert.equal(remoteBranches('skyhop-run'), '');
});

test('a window that had the session open before the cloud part arrived is stopped', t => {
  const { hook, handOff, cloudWork, record } = setup(t);
  cloudWork(handOff());
  hook('start', start);
  // This window never reported opening the session, so it has the old copy loaded.
  const out = hook('prompt', prompt);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /This window doesn't show the session's cloud conversation, so Skyhop stopped this message/);
  assert.equal(record().broughtBackAt, undefined);

  hook('start', resume);
  assert.match(hook('prompt', prompt).systemMessage, /back from the cloud/);
});

test('opening the session while the cloud part is arriving counts as too early', t => {
  const { hook, handOff, cloudWork } = setup(t);
  cloudWork(handOff());
  hook('start', resume, { SKYHOP_LOAD_MARGIN_MS: '0' });
  hook('start', start);
  assert.equal(hook('prompt', prompt).decision, 'block');
});

test('cloud messages that are not loaded here stop the first message', t => {
  const { vm, hook, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  hook('start', start);
  hook('start', resume);
  cloudWork(vm, { prompt: 'one more', chat: CLOUD2, code: false });

  const out = hook('prompt', prompt);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /new messages from the cloud that are not loaded in this window/);

  hook('start', start);
  hook('start', resume);
  assert.match(hook('prompt', prompt).systemMessage, /back from the cloud/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD + CLOUD2);
});

// Lines shaped like Claude Code's: each conversation line names the one before, and
// Claude Code carries on from the last conversation line in the file.
const line = fields => `${JSON.stringify({ sessionId: SESSION, ...fields })}\n`;
const LINKED_LOCAL = line({ type: 'user', uuid: 'local-1', parentUuid: null, message: { content: 'before the handoff' } });
const LINKED_CLOUD = line({ type: 'user', uuid: 'cloud-1', parentUuid: 'local-1', message: { content: 'from my phone' } })
  + line({ type: 'assistant', uuid: 'cloud-2', parentUuid: 'cloud-1', message: { content: [] } });
// What a window that loaded the session without its cloud part writes, such as
// Skyhop's own note when it stops a message there.
const STALE_NOTE = line({ type: 'system', subtype: 'informational', uuid: 'stale-1', parentUuid: 'local-1', content: 'stopped' });
const BOOKKEEPING = line({ type: 'last-prompt', lastPrompt: 'x' });

function linkedSetup(t) {
  const context = setup(t);
  fs.writeFileSync(context.localSession, LINKED_LOCAL);
  context.cloudWork(context.handOff(), { chat: LINKED_CLOUD });
  context.hook('start', start);
  assert.equal(fs.readFileSync(context.localSession, 'utf8'), LINKED_LOCAL + LINKED_CLOUD);
  return context;
}

test('a line written after the cloud part by a window without it stops the message, and the next start puts the cloud part last', t => {
  const { hook, localSession, record } = linkedSetup(t);
  fs.appendFileSync(localSession, STALE_NOTE + BOOKKEEPING);

  assert.match(hook('start', resume).systemMessage, /this window doesn't show the session's cloud conversation/);
  const out = hook('prompt', prompt);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /doesn't show the session's cloud conversation/);
  assert.equal(record().broughtBackAt, undefined);

  assert.match(hook('start', start).systemMessage, /is in the cloud\. Pick it in \/resume/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LINKED_LOCAL + STALE_NOTE + BOOKKEEPING + LINKED_CLOUD);
  assert.match(hook('start', resume).systemMessage, /comes home when you send a message/);
  assert.match(hook('prompt', prompt).systemMessage, /back from the cloud/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LINKED_LOCAL + STALE_NOTE + BOOKKEEPING + LINKED_CLOUD);
});

test('lines a window writes on top of the cloud part keep it in view', t => {
  const { hook, localSession } = linkedSetup(t);
  assert.match(hook('start', resume).systemMessage, /comes home when you send a message/);
  fs.appendFileSync(localSession, line({ type: 'attachment', uuid: 'open-1', parentUuid: 'cloud-2' }) + BOOKKEEPING);
  assert.match(hook('prompt', prompt).systemMessage, /back from the cloud/);
});

test('a window that opens the session while the cloud part downloads leaves it for the next start', t => {
  const { hook, handOff, cloudWork, localSession, record } = setup(t);
  fs.writeFileSync(localSession, LINKED_LOCAL);
  cloudWork(handOff(), { chat: LINKED_CLOUD });
  // The fake `claude agents` writes a line, as a window opening the session would.
  const out = hook('start', start, { FAKE_CLAUDE_OPENS: localSession, FAKE_CLAUDE_OPENS_LINE: STALE_NOTE.trim() });
  assert.match(out.systemMessage, /a window opened it while they were downloading/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LINKED_LOCAL + STALE_NOTE);
  assert.equal(record().pulledChat, undefined);

  hook('start', start);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LINKED_LOCAL + STALE_NOTE + LINKED_CLOUD);
  hook('start', resume);
  assert.match(hook('prompt', prompt).systemMessage, /back from the cloud/);
});

test('a message typed without the cloud part is left for /skyhop-back, which splits the cloud part off', t => {
  const { hook, skyhop, localSession } = linkedSetup(t);
  const typed = line({ type: 'user', uuid: 'stale-2', parentUuid: 'local-1', message: { content: 'typed without the cloud part' } });
  fs.appendFileSync(localSession, typed);
  assert.match(hook('start', start).systemMessage, /typed in it here without it\. Run \/skyhop-back/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LINKED_LOCAL + LINKED_CLOUD + typed);

  const result = skyhop(['--back']);
  assert.equal(result.status, 0, result.output);
  const newId = result.output.match(/claude --resume (\S+)/)[1];
  assert.notEqual(newId, SESSION);
  const forked = fs.readFileSync(path.join(path.dirname(localSession), `${newId}.jsonl`), 'utf8');
  assert.equal(forked, (LINKED_LOCAL + LINKED_CLOUD).replaceAll(SESSION, newId));
  assert.equal(fs.readFileSync(localSession, 'utf8'), LINKED_LOCAL + LINKED_CLOUD + typed);
});

test('/skyhop-back puts a hidden cloud part back in view', t => {
  const { skyhop, localSession } = linkedSetup(t);
  fs.appendFileSync(localSession, STALE_NOTE);
  const result = skyhop(['--back']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /now in your original session/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LINKED_LOCAL + STALE_NOTE + LINKED_CLOUD);
});

// While a reply runs, the pulse branch is a commit ahead of the chat branch.
function pretendBusy({ bare, record }) {
  const { chatRef } = record().sync;
  const pulse = chatRef.replace(/-chat$/, '-pulse');
  const tree = run(bare, 'rev-parse', `refs/heads/${chatRef}^{tree}`);
  const busy = run(bare, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit-tree', tree, '-p', `refs/heads/${chatRef}`, '-m', 'busy');
  run(bare, 'update-ref', `refs/heads/${pulse}`, busy);
}

test('a reply still running in the cloud waits, unless the message is sent again', t => {
  const repo = setup(t);
  const { hook, handOff, cloudWork, syncBranches } = repo;
  cloudWork(handOff());
  hook('start', start);
  hook('start', resume);
  pretendBusy(repo);
  assert.match(hook('start', start).systemMessage, /working on a reply there/);

  const first = hook('prompt', prompt);
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /still working on a reply/);
  const second = hook('prompt', prompt);
  assert.match(second.systemMessage, /back from the cloud/);
  assert.equal(syncBranches(), '');
});

test('/skyhop-back waits for a running reply too, and a second run goes ahead', t => {
  const repo = setup(t);
  const { skyhop, handOff, cloudWork, localSession, syncBranches } = repo;
  cloudWork(handOff());
  pretendBusy(repo);
  const first = skyhop(['--back']);
  assert.equal(first.status, 1);
  assert.match(first.output, /still working on a reply/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
  assert.equal(skyhop(['--back']).status, 0);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
  assert.equal(syncBranches(), '');
});

test('the relay marks itself busy during a reply, and the save catches the pulse up', t => {
  const { bare, handOff, cloudWork, vm, record } = setup(t);
  const tip = name => run(bare, 'rev-parse', `refs/heads/${record().sync[name]}`);
  const pulse = () => run(bare, 'rev-parse', `refs/heads/${record().sync.chatRef.replace(/-chat$/, '-pulse')}`);
  let during = null;
  cloudWork(handOff(), { busyCheck: () => { during = pulse(); } });
  assert.ok(during);
  assert.equal(pulse(), tip('chatRef'));
  assert.notEqual(during, tip('chatRef'));

  cloudWork(vm, { prompt: 'one more', chat: CLOUD2, code: false, busyCheck: () => { during = pulse(); } });
  assert.notEqual(during, tip('chatRef'));
  assert.equal(pulse(), tip('chatRef'));
  // The chat only ever moved forward.
  assert.equal(run(bare, 'merge-base', '--is-ancestor', during, tip('chatRef')), '');
});

test('when both sides kept going, the cloud part becomes its own session', t => {
  const { vm, hook, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  hook('start', start);
  hook('start', resume);
  fs.appendFileSync(localSession, TYPED_HERE);
  cloudWork(vm, { prompt: 'one more', chat: CLOUD2, code: false });

  const out = hook('prompt', prompt);
  const newId = out.systemMessage.match(/separate session: claude --resume (\S+)/)[1];
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD + TYPED_HERE);
  const forked = fs.readFileSync(path.join(path.dirname(localSession), `${newId}.jsonl`), 'utf8');
  assert.equal(forked, (LOCAL + CLOUD + CLOUD2).replaceAll(SESSION, newId));
});

test('a second round trip keeps the one session', t => {
  const { root, vm, hook, handOff, handOffAgain, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  hook('start', start);
  hook('start', resume);
  hook('prompt', prompt);
  fs.appendFileSync(localSession, TYPED_HERE);

  handOffAgain();
  cloudWork(vm, { chat: CLOUD2, code: 'more-cloud-work.txt' });
  hook('start', start);
  hook('start', resume);
  assert.match(hook('prompt', prompt).systemMessage, /back from the cloud/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD + TYPED_HERE + CLOUD2);
  assert.deepEqual(fs.readdirSync(path.dirname(localSession)), [`${SESSION}.jsonl`]);
  assert.ok(fs.existsSync(path.join(root, 'cloud-work.txt')));
  assert.ok(fs.existsSync(path.join(root, 'more-cloud-work.txt')));
  assert.equal(run(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('the startup hook leaves a session that is open in another window alone', t => {
  const { hook, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  const out = hook('start', start, { FAKE_CLAUDE_AGENTS: JSON.stringify([{ sessionId: SESSION, status: 'idle' }]) });
  assert.match(out.systemMessage, /open in another Claude Code window/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
});

test('a local message typed after the handoff stops the startup hook from adding anything', t => {
  const { hook, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  fs.appendFileSync(localSession, TYPED_HERE);
  assert.match(hook('start', start).systemMessage, /you also typed in it here/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + TYPED_HERE);
});

test('scripted runs and other folders skip the startup hook', t => {
  const { hook, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  assert.equal(hook('start', start, { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }), null);
  assert.equal(hook('start', { ...start, cwd: tempDir(t) }), null);
  assert.equal(hook('start', start, { CLAUDE_CODE_REMOTE: 'true' }), null);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
});

test('with no handoffs the hooks do nothing', t => {
  const { hook } = setup(t);
  assert.equal(hook('start', start), null);
  assert.equal(hook('start', resume), null);
  assert.equal(hook('prompt', prompt), null);
});

test('an unreachable remote lets the message through and keeps the handoff waiting', t => {
  const { root, hook, handOff, cloudWork, record } = setup(t);
  cloudWork(handOff());
  run(root, 'remote', 'set-url', 'origin', '/nowhere/at/all.git');
  assert.match(hook('start', start).systemMessage, /couldn't be reached/);
  const out = hook('prompt', prompt);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /couldn't reach origin/);
  assert.equal(record().broughtBackAt, undefined);
});

test('status lists leftovers, and --clean removes only what is safe', t => {
  const { root, bare, briefFile, skyhop, handOff, cloudWork, remoteBranches } = setup(t);
  assert.equal(skyhop(['--brief', briefFile, '--yes', '--summary']).status, 0);
  const merged = remoteBranches('skyhop/');
  run(root, 'push', '-q', 'origin', 'main:refs/heads/skyhop-sync/old-20990101-000000-chat');
  run(root, 'branch', 'skyhop/back-20990101-000000', 'main');
  run(root, 'switch', '-q', '-c', 'scratch');
  write(root, 'only-on-github.txt', 'work\n');
  run(root, 'add', 'only-on-github.txt');
  run(root, 'commit', '-q', '-m', 'work');
  run(root, 'push', '-q', 'origin', 'scratch:refs/heads/skyhop/main-20990101-000000');
  run(root, 'switch', '-q', 'main');
  run(root, 'branch', '-q', '-D', 'scratch');
  cloudWork(handOff());

  const status = skyhop(['--status']).output;
  assert.match(status, /In the cloud now/);
  const [safe, kept] = status.split('  Kept:');
  assert.match(safe, /origin\/skyhop-sync\/old-20990101-000000-chat/);
  assert.ok(safe.includes(`origin/${merged}`));
  assert.match(safe, /skyhop\/back-20990101-000000/);
  assert.match(kept, /origin\/skyhop\/main-20990101-000000/);
  assert.doesNotMatch(status, /skyhop-run\//);

  const cleaned = skyhop(['--status', '--clean']);
  assert.equal(cleaned.status, 0, cleaned.output);
  assert.equal(remoteBranches('skyhop/'), 'skyhop/main-20990101-000000');
  assert.notEqual(remoteBranches('skyhop-run'), '');
  assert.match(remoteBranches('skyhop-sync'), /-chat$/m);
  assert.doesNotMatch(remoteBranches('skyhop-sync'), /old-/);
  assert.equal(run(root, 'branch', '--list', 'skyhop/*'), '');
  assert.ok(bare);
});

test('code someone else pushed to the code branch is not put in your files', t => {
  const { root, bare, base, hook, handOff, cloudWork, record } = setup(t);
  cloudWork(handOff());
  // Someone with push access swaps the code branch for their own commit.
  const codeRef = record().sync.codeRef;
  const other = path.join(base, 'other');
  run(base, 'clone', '-q', '--branch', codeRef, bare, other);
  write(other, 'cloud-work.txt', 'not from your cloud session\n');
  run(other, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qam', 'swap');
  run(other, 'push', '-q', 'origin', `HEAD:${codeRef}`);

  hook('start', start);
  hook('start', resume);
  const out = hook('prompt', prompt);
  assert.match(out.systemMessage, /The code on GitHub doesn't match what your cloud session saved/);
  assert.ok(!fs.existsSync(path.join(root, 'cloud-work.txt')));
  const branch = out.systemMessage.match(/put that code on (\S+)\./)[1];
  assert.equal(run(root, 'show', `${branch}:cloud-work.txt`), 'not from your cloud session');
});
