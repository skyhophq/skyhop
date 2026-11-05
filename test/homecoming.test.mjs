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
  assert.match(reply.hookSpecificOutput.additionalContext, /gone back to your computer/);
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
  assert.match(out.reason, /opened the session before its cloud conversation arrived/);
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
