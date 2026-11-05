// A session handed off again goes back to the cloud chat it used before, so each
// session has one chat in the cloud as well as one session on the Mac.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { handlePrompt } from '../scripts/relay.mjs';
import { alive, bootId, run, sleeper, write } from './helpers.mjs';
import { CLOUD, CLOUD2, LOCAL, SESSION, setup } from './roundtrip.mjs';

const start = { source: 'startup', session_id: 'aaaaaaaa-0000-4000-8000-000000000000' };
const resume = { source: 'resume', session_id: SESSION };
const prompt = { session_id: SESSION, prompt: 'hello again' };
const TYPED_HERE = `{"type":"user","sessionId":"${SESSION}","message":{"content":"typed on the Mac"}}\n`;
const CHAT = 'session_01FakeSessionForTests';

function comeHome(hook) {
  hook('start', start);
  hook('start', resume);
  const out = hook('prompt', prompt);
  assert.match(out.systemMessage, /back from the cloud/);
}

// One trip to the cloud and back, with the chat's VM left running.
function firstTrip(repo) {
  repo.cloudWork(repo.handOff());
  comeHome(repo.hook);
  return repo.record();
}

test('the first handoff remembers its chat', t => {
  const repo = setup(t);
  repo.handOff();
  const { cloud, sync } = repo.record();
  assert.equal(cloud.sessionId, CHAT);
  assert.equal(cloud.runBranch, sync.runBranch);
  assert.equal(cloud.key, sync.key);
  assert.equal(cloud.reopen, true);
});

test('a second handoff goes back to the same chat, and the session keeps one chat and one ID', t => {
  const repo = setup(t);
  const { root, base, vm, hook, handOffAgain, cloudWork, localSession, remoteBranches, record } = repo;
  const first = firstTrip(repo);
  fs.appendFileSync(localSession, TYPED_HERE);
  fs.rmSync(path.join(root, 'cloud-work.txt'));
  write(vm, '.env.cloud', 'TOKEN=only-in-the-vm\n');

  const output = handOffAgain().output;
  assert.match(output, /Cloud chat: back to this session's earlier chat/);
  assert.match(output, /Sent to this session's earlier cloud chat: https:\/\/claude\.ai\/code\/session_01FakeSessionForTests/);
  assert.doesNotMatch(output, /Cloud session started/);
  assert.equal(fs.readFileSync(path.join(base, 'sent-to'), 'utf8'), CHAT);
  const second = record();
  assert.equal(second.sync.runBranch, first.sync.runBranch);
  assert.equal(second.sync.key, first.sync.key);
  assert.notEqual(second.sync.chatRef, first.sync.chatRef);
  assert.equal(remoteBranches('skyhop-run'), first.sync.runBranch);

  // The running VM swaps to the new handoff and carries on from the Mac's copy.
  const reply = cloudWork(vm, { chat: CLOUD2, code: 'more-cloud-work.txt' });
  assert.match(reply, /SKYHOP-REPLY[\s\S]*done/);
  assert.equal(run(vm, 'symbolic-ref', '--short', 'HEAD'), second.branch);
  assert.ok(!fs.existsSync(path.join(vm, 'cloud-work.txt')), 'a file deleted on the Mac stays deleted');
  assert.ok(fs.existsSync(path.join(vm, '.env.cloud')), 'a sensitive file in the VM is left alone');
  const imported = fs.readFileSync(path.join(base, 'vm-home/.claude/projects/skyhop-import', `${SESSION}.jsonl`), 'utf8');
  assert.equal(imported, LOCAL + CLOUD + TYPED_HERE + CLOUD2);

  comeHome(hook);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD + TYPED_HERE + CLOUD2);
  assert.deepEqual(fs.readdirSync(path.dirname(localSession)), [`${SESSION}.jsonl`]);
  assert.ok(!fs.existsSync(path.join(root, 'cloud-work.txt')));
  assert.equal(fs.readFileSync(path.join(root, 'more-cloud-work.txt'), 'utf8'), 'made in the cloud\n');
  assert.equal(record().cloud.sessionId, CHAT);
});

test('going back to a chat first stops anything still running from the last handoff', t => {
  const repo = setup(t);
  const { vm, handOffAgain, cloudWork } = repo;
  firstTrip(repo);
  handOffAgain();
  const pid = sleeper(t);
  fs.rmSync(path.join(vm, '.skyhop/job'), { recursive: true, force: true });
  write(vm, '.skyhop/job/job.json', JSON.stringify({ pid, boot: bootId(), startedAt: Date.now() }));
  const reply = cloudWork(vm, { chat: CLOUD2, code: false });
  assert.ok(!alive(pid), 'the old job was stopped');
  assert.match(reply, /SKYHOP-REPLY[\s\S]*done/);
});

test('a chat whose VM was shut down picks the handoff up from its start branch', t => {
  const repo = setup(t);
  const { base, bare, hook, handOffAgain, cloudWork, localSession } = repo;
  const first = firstTrip(repo);
  handOffAgain();

  // A fresh VM, cloned from the chat's start branch, with nothing left from before.
  const fresh = path.join(base, 'fresh-vm');
  execFileSync('git', ['clone', '-q', '--branch', first.sync.runBranch, bare, fresh]);
  fs.rmSync(path.join(base, 'vm-home'), { recursive: true, force: true });
  cloudWork(fresh, { chat: CLOUD2, code: false });

  comeHome(hook);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD + CLOUD2);
});

test('--new-chat starts a new chat instead', t => {
  const repo = setup(t);
  const first = firstTrip(repo);
  const output = repo.skyhop(['--brief', repo.briefFile, '--session', SESSION, '--yes', '--new-chat']).output;
  assert.match(output, /Cloud chat: a new chat/);
  assert.match(output, /Cloud session started/);
  assert.ok(!fs.existsSync(path.join(repo.base, 'sent-to')));
  assert.notEqual(repo.record().sync.runBranch, first.sync.runBranch);
});

test('a chat that was archived or deleted falls back to a new chat', t => {
  const repo = setup(t);
  firstTrip(repo);
  fs.rmSync(repo.vm, { recursive: true, force: true });
  const output = repo.handOffAgain({ FAKE_CLAUDE_SEND: 'archived' }).output;
  assert.match(output, /earlier cloud chat couldn't take the handoff \(cloud session .* is archived/);
  assert.match(output, /Cloud session started/);
  assert.equal(repo.record().cloud.sessionId, CHAT);
});

test('a session still in the cloud is not handed off again', t => {
  const repo = setup(t);
  repo.cloudWork(repo.handOff());
  const result = repo.skyhop(['--brief', repo.briefFile, '--session', SESSION, '--yes']);
  assert.equal(result.status, 1);
  assert.match(result.output, /still in the cloud from its last handoff/);
});

test('a handoff branch left on the remote is replaced', t => {
  const repo = setup(t);
  const first = firstTrip(repo);
  // A commit unrelated to the new handoff, so pushing over it would be refused.
  const stray = run(repo.root, 'commit-tree', 'main^{tree}', '-m', 'left behind');
  run(repo.root, 'push', '-q', 'origin', `${stray}:refs/heads/${first.sync.runBranch}`);
  repo.handOffAgain();
  const tip = run(repo.bare, 'log', '-1', '--format=%B', `refs/heads/${first.sync.runBranch}`);
  assert.match(tip, /skyhop-relay-commit/);
});

test('a reopen that cannot find its handoff says so and changes nothing', t => {
  const repo = setup(t);
  const vm = repo.handOff();
  const head = run(vm, 'rev-parse', 'HEAD');
  const output = handlePrompt({ prompt: 'hi [skyhop-reopen:skyhop-run/nowhere]', hookMode: 'default', root: vm });
  assert.match(output.hookSpecificOutput.additionalContext, /could not reconnect this chat/);
  assert.equal(run(vm, 'rev-parse', 'HEAD'), head);
  assert.ok(fs.existsSync(path.join(vm, '.skyhop/relay.mjs')));

  run(repo.root, 'push', '-q', 'origin', 'main:refs/heads/skyhop-run/not-a-handoff');
  const refused = handlePrompt({ prompt: 'hi [skyhop-reopen:skyhop-run/not-a-handoff]', hookMode: 'default', root: vm });
  assert.match(refused.hookSpecificOutput.additionalContext, /does not hold a Skyhop handoff/);
  assert.equal(run(vm, 'rev-parse', 'HEAD'), head);
  assert.ok(fs.existsSync(path.join(vm, '.skyhop/relay.mjs')));
});
