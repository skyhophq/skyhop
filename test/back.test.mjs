// The full round trip: hand off, work in a fake VM, then bring it all home.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cloudShown, localTurnsAfter, putCloudLast, remoteControlEntry } from '../scripts/back.mjs';
import { dirty, run, tempDir, write } from './helpers.mjs';
import { CLOUD, LOCAL, SESSION, setup } from './roundtrip.mjs';

test('the handoff pushes one start branch with the transcript encrypted', t => {
  const { bare, base, handOff, syncBranches } = setup(t);
  handOff();
  assert.equal(syncBranches(), '');
  assert.equal(fs.readFileSync(path.join(base, 'force-bundle'), 'utf8'), 'unset');
  const start = run(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/skyhop-run');
  assert.match(start, /^skyhop-run\//);
  const files = run(bare, 'ls-tree', '-r', '--name-only', start).split('\n');
  assert.ok(files.includes('.skyhop/session.enc.000'));
  assert.ok(!files.includes('.skyhop/session.jsonl'));
  assert.ok(!files.includes('.skyhop/sync-key'));
});

test('the first message carries the key, and the saved prompt is private', t => {
  const { base, home, handOff } = setup(t);
  handOff();
  const record = JSON.parse(fs.readFileSync(path.join(home, `.skyhop/sessions/${SESSION}.json`), 'utf8'));
  assert.ok(fs.readFileSync(path.join(base, 'prompt'), 'utf8').endsWith(`[skyhop-key:${record.sync.key}]`));
  assert.equal(fs.statSync(path.join(home, '.skyhop/briefs/brief.md.prompt.md')).mode & 0o777, 0o600);
});

test('the plan says what will be synced', t => {
  const { skyhop, home } = setup(t);
  const output = skyhop(['--brief', path.join(home, '.skyhop/briefs/brief.md'), '--session', SESSION, '--full-resume', '--dry-run']).output;
  assert.match(output, /Sync:\s+after each reply/);
  assert.match(output, /skyhop mode/);
});

test('the key never reaches GitHub', t => {
  const { bare, home, handOff, cloudWork } = setup(t);
  cloudWork(handOff());
  const record = JSON.parse(fs.readFileSync(path.join(home, `.skyhop/sessions/${SESSION}.json`), 'utf8'));
  const everything = spawnSync('sh', ['-c', 'git rev-list --all --objects | cut -d" " -f1 | git cat-file --batch'], { cwd: bare }).stdout;
  assert.ok(record.sync.key.length > 20);
  assert.ok(!everything.includes(record.sync.key));
  assert.ok(!everything.includes('from my phone'));
  assert.ok(!everything.includes('before the handoff'));
  // The brief stays off GitHub too: the chat's first message has it.
  assert.ok(!everything.includes('Ship it.'));
  assert.equal(fs.statSync(path.join(home, `.skyhop/sessions/${SESSION}.json`)).mode & 0o777, 0o600);
});

test('~/.skyhop and the files Skyhop keeps there are private, even ones older versions left open', t => {
  const { home, briefFile, handOff, cloudWork, hook } = setup(t);
  fs.chmodSync(path.join(home, '.skyhop'), 0o755);
  fs.chmodSync(briefFile, 0o644);
  write(home, `.skyhop/sessions/${SESSION}.json`, '{}');
  fs.chmodSync(path.join(home, `.skyhop/sessions/${SESSION}.json`), 0o644);
  cloudWork(handOff());
  hook('start', { source: 'startup', session_id: 'aaaaaaaa-0000-4000-8000-000000000000' });
  const mode = file => fs.statSync(path.join(home, file)).mode & 0o777;
  assert.equal(mode('.skyhop'), 0o700);
  assert.equal(mode('.skyhop/briefs/brief.md'), 0o600);
  assert.equal(mode(`.skyhop/sessions/${SESSION}.json`), 0o600);
  assert.equal(mode('.skyhop/history.json'), 0o600);
  assert.equal(mode(`.skyhop/backups/${SESSION}.jsonl`), 0o600);
});

test('the round trip adds the cloud conversation to the same session and brings the code', t => {
  const { root, bare, home, skyhop, handOff, cloudWork, localSession, syncBranches } = setup(t);
  dirty(root);
  const staged = run(root, 'diff', '--cached', '--name-only');
  cloudWork(handOff());

  const result = skyhop(['--back']);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
  assert.ok(result.output.includes(`claude --resume ${SESSION}`));
  assert.match(result.output, /in your files on main, not committed/);

  // The cloud's work joins the local work on the same branch, with no new commits.
  assert.equal(run(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(run(root, 'rev-parse', 'main'), run(root, 'rev-parse', 'origin/main'));
  assert.equal(run(root, 'diff', '--cached', '--name-only'), staged);
  assert.equal(fs.readFileSync(path.join(root, 'cloud-work.txt'), 'utf8'), 'made in the cloud\n');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(root, 'new-file.txt'), 'utf8'), 'untracked\n');
  assert.equal(fs.readFileSync(path.join(root, 'ignored.txt'), 'utf8'), 'ignored\n');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'NAME=value\n');
  assert.equal(run(root, 'branch', '--list', 'skyhop/*'), '');

  assert.equal(syncBranches(), '');
  assert.equal(run(bare, 'for-each-ref', 'refs/heads/skyhop-run'), '');
  assert.equal(fs.readFileSync(path.join(home, `.skyhop/backups/${SESSION}.jsonl`), 'utf8'), LOCAL);
  assert.equal(run(root, 'for-each-ref', 'refs/skyhop'), '');
});

test('after the first message the VM works on its own branch, without the relay commit', t => {
  const { base, bare, handOff, cloudWork } = setup(t);
  const vm = handOff();
  cloudWork(vm);
  const branch = run(vm, 'symbolic-ref', '--short', 'HEAD');
  assert.match(branch, /^skyhop\/main-/);
  assert.doesNotMatch(run(vm, 'log', '--format=%s'), /Skyhop relay files/);
  assert.ok(!run(vm, 'ls-files').includes('.skyhop'));
  assert.equal(run(vm, 'status', '--porcelain'), '?? cloud-work.txt');
  run(vm, 'push', '-q', 'origin', 'HEAD');
  assert.ok(run(bare, 'rev-parse', '--verify', `refs/heads/${branch}`));
  assert.ok(base);
});

test('bringing back twice does not add the conversation twice', t => {
  const { skyhop, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  skyhop(['--back']);
  const second = skyhop(['--back']);
  assert.equal(second.status, 0);
  assert.match(second.output, /already brought the session you handed off on .* home/);
  assert.ok(second.output.includes(`claude --resume ${SESSION}`));
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
});

test('the local tail from the handoff itself does not block the merge', t => {
  const { skyhop, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  const tail = '{"type":"assistant","message":{"content":[]}}\n{"type":"user","toolUseResult":{},"message":{"content":[{"type":"tool_result"}]}}\n';
  fs.appendFileSync(localSession, tail);
  const result = skyhop(['--back']);
  assert.match(result.output, /in your original session/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + tail + CLOUD);
});

test('work typed locally after the handoff is kept, and the cloud work becomes a new session', t => {
  const { skyhop, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  const typed = `{"type":"user","sessionId":"${SESSION}","message":{"content":"I kept working here"}}\n`;
  fs.appendFileSync(localSession, typed);

  const result = skyhop(['--back']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /new session, because you typed 1 message/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + typed);

  const newId = result.output.match(/claude --resume (\S+)/)[1];
  assert.notEqual(newId, SESSION);
  const forked = fs.readFileSync(path.join(path.dirname(localSession), `${newId}.jsonl`), 'utf8');
  assert.equal(forked, (LOCAL + CLOUD).replaceAll(SESSION, newId));
});

test('a session still open in a window is left alone, with no extra session made', t => {
  const { skyhop, handOff, cloudWork, localSession, remoteBranches } = setup(t);
  cloudWork(handOff());
  const result = skyhop(['--back'], { FAKE_CLAUDE_AGENTS: JSON.stringify([{ sessionId: SESSION, status: 'idle' }]) });
  assert.equal(result.status, 1);
  assert.match(result.output, /open in a Claude Code window, maybe this one, so nothing was changed/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
  assert.equal(fs.readdirSync(path.dirname(localSession)).length, 1);
  assert.notEqual(remoteBranches('skyhop-run'), '');
});

test('local changes since the handoff are left alone, and the code waits on a branch', t => {
  const { root, skyhop, handOff, cloudWork } = setup(t);
  cloudWork(handOff());
  write(root, 'tracked.txt', 'edited after the handoff\n');
  const result = skyhop(['--back']);
  assert.equal(result.status, 0, result.output);
  assert.equal(run(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'edited after the handoff\n');
  assert.ok(!fs.existsSync(path.join(root, 'cloud-work.txt')));
  const branch = result.output.match(/git switch (\S+)/)[1];
  assert.equal(run(root, 'show', `${branch}:cloud-work.txt`), 'made in the cloud');
});

test('a local edit to a tracked sensitive file is never overwritten', t => {
  const { root, skyhop, handOff, cloudWork } = setup(t);
  write(root, 'server.pem', 'old\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'add pem');
  run(root, 'push', '-q', 'origin', 'main');
  write(root, 'server.pem', 'edited\n');
  cloudWork(handOff());
  assert.equal(skyhop(['--back']).status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'server.pem'), 'utf8'), 'edited\n');
  assert.equal(run(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('a dry run reports the plan and changes nothing', t => {
  const { root, skyhop, handOff, cloudWork, localSession, syncBranches } = setup(t);
  cloudWork(handOff());
  const before = syncBranches();
  const result = skyhop(['--back', '--dry-run']);
  assert.match(result.output, /would be added to your original session/);
  assert.match(result.output, /Dry run: nothing was changed/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
  assert.equal(run(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  assert.equal(syncBranches(), before);
});

test('a session with no cloud changes brings back only the conversation', t => {
  const { root, skyhop, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff(), { code: false });
  const result = skyhop(['--back']);
  assert.match(result.output, /made no code changes/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
  assert.equal(run(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
});

test('with nothing saved yet it says so', t => {
  const { skyhop, handOff, localSession } = setup(t);
  handOff();
  assert.match(skyhop(['--back']).output, /Nothing has been saved yet/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
});

test('an unreachable remote is reported and changes nothing', t => {
  const { root, skyhop, handOff, localSession } = setup(t);
  handOff();
  run(root, 'remote', 'set-url', 'origin', '/nowhere/at/all.git');
  const result = skyhop(['--back']);
  assert.equal(result.status, 1);
  assert.match(result.output, /Could not reach origin/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
});

test('a wrong key is refused and changes nothing', t => {
  const { home, skyhop, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  const file = path.join(home, `.skyhop/sessions/${SESSION}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.sync.key = Buffer.alloc(32, 7).toString('base64');
  fs.writeFileSync(file, JSON.stringify(record));
  const result = skyhop(['--back']);
  assert.equal(result.status, 1);
  assert.match(result.output, /could not be read/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
});

test('--no-sync means nothing is saved, and the plan says so', t => {
  const { base, skyhop, handOff, home, syncBranches } = setup(t);
  const vm = handOff('--no-sync');
  assert.ok(!fs.existsSync(path.join(vm, '.skyhop/sync.json')));
  assert.equal(syncBranches(), '');
  assert.match(skyhop(['--back']).output, /no saved progress/);
  assert.match(skyhop(['--brief', path.join(home, '.skyhop/briefs/brief.md'), '--session', SESSION, '--full-resume', '--dry-run', '--no-sync']).output, /Sync:\s+off/);
  assert.ok(base);
});

test('with no remote, sync is off and the handoff still works', t => {
  const { skyhop, handOff } = setup(t, { remote: false });
  assert.ok(!fs.existsSync(path.join(handOff(), '.skyhop/sync.json')));
  assert.match(skyhop(['--back']).output, /no saved progress/);
});

test('with no full resume to bring back, it explains', t => {
  const { skyhop } = setup(t);
  const result = skyhop(['--back']);
  assert.equal(result.status, 1);
  assert.match(result.output, /no full-resume handoff/);
});

test('after a brief handoff it explains how to get that session', t => {
  const { skyhop, home } = setup(t);
  assert.equal(skyhop(['--brief', path.join(home, '.skyhop/briefs/brief.md'), '--yes', '--summary']).status, 0);
  const output = skyhop(['--back']).output;
  assert.match(output, /summary handoff/);
  assert.match(output, /claude --teleport session_01FakeSessionForTests/);
  assert.match(output, /git fetch origin skyhop\//);
});

test('typed local messages are counted, and tool results and notes are not', t => {
  const file = path.join(tempDir(t), 's.jsonl');
  const lines = [
    '{"type":"user","message":{"content":"typed"}}',
    '{"type":"user","message":{"content":[{"type":"text","text":"typed too"}]}}',
    '{"type":"user","toolUseResult":{},"message":{"content":[{"type":"tool_result"}]}}',
    '{"type":"user","isMeta":true,"message":{"content":"note"}}',
    '{"type":"assistant","message":{"content":[]}}',
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.equal(localTurnsAfter(file, 0), 2);
});

test('an unreadable line counts as local work, which is the safer path', t => {
  const file = path.join(tempDir(t), 's.jsonl');
  fs.writeFileSync(file, 'not json\n');
  assert.equal(localTurnsAfter(file, 0), 1);
});

test('coming home brings the cloud log, and neither log holds the conversation or the key', t => {
  const { home, skyhop, handOff, cloudWork, record } = setup(t);
  cloudWork(handOff());
  const { key } = record().sync;
  assert.equal(skyhop(['--back']).status, 0);

  const cloud = fs.readFileSync(path.join(home, `.skyhop/logs/cloud-${SESSION}.log`), 'utf8');
  assert.match(cloud, / cloud session set up saved-progress=none/);
  assert.match(cloud, / cloud job end minutes=\S+ outcome=reply/);
  const local = fs.readFileSync(path.join(home, '.skyhop/logs/skyhop.log'), 'utf8');
  assert.match(local, / handoff start version=\S+ node=v\d+/);
  assert.match(local, / handoff plan repo=repo remote=yes sync=on chat="new chat"/);
  assert.match(local, / handoff launch result=started chat=session_01FakeSessionForTests/);
  assert.match(local, / back brought home session=11111111 turns=1 conversation="same session" code=apply/);
  for (const text of [cloud, local]) {
    assert.doesNotMatch(text, /from my phone|before the handoff|Ship it/);
    assert.ok(!text.includes(key));
  }
});

test('a message that brings the session home is logged with what Skyhop said', t => {
  const { home, hook, handOff, cloudWork } = setup(t);
  cloudWork(handOff());
  hook('start', { source: 'startup', session_id: 'other' });
  hook('start', { source: 'resume', session_id: SESSION });
  hook('prompt', { session_id: SESSION });
  const local = fs.readFileSync(path.join(home, '.skyhop/logs/skyhop.log'), 'utf8');
  assert.match(local, / home startup session=11111111 said="Skyhop: the session you handed off on .* now has its cloud conversation here/);
  assert.match(local, / home opened session=11111111 github=reached said="Skyhop: this session was in the cloud/);
  assert.match(local, / home message session=11111111 outcome="let through" said="Skyhop: this session is back from the cloud/);
  assert.ok(fs.existsSync(path.join(home, `.skyhop/logs/cloud-${SESSION}.log`)));
});

const typedLine = text => `${JSON.stringify({ type: 'user', message: { content: text } })}\n`;
const bridgeLine = id => `${JSON.stringify({ type: 'bridge-session', sessionId: 'x', bridgeSessionId: id, lastSequenceNum: 0 })}\n`;

test('the Remote Control link comes from the newest bridge record', t => {
  const file = path.join(tempDir(t), 'session.jsonl');
  fs.writeFileSync(file, typedLine('hi') + bridgeLine('cse_01OlderEntryAbc') + typedLine('more') + bridgeLine('cse_01NewerEntryXyz') + typedLine('last'));
  assert.deepEqual(remoteControlEntry(file), { url: 'https://claude.ai/code/session_01NewerEntryXyz', missing: 0 });
});

test('a session that never had Remote Control has no link, and odd records are skipped', t => {
  const file = path.join(tempDir(t), 'session.jsonl');
  fs.writeFileSync(file, typedLine('hi'));
  assert.equal(remoteControlEntry(file), null);
  assert.equal(remoteControlEntry(path.join(tempDir(t), 'missing.jsonl')), null);
  fs.writeFileSync(file, bridgeLine('cse_01GoodEntryAbcd') + typedLine('the word "bridge-session" in a message') + bridgeLine('cse_bad/../x') + '{"type":"bridge-session" broken\n');
  assert.equal(remoteControlEntry(file).url, 'https://claude.ai/code/session_01GoodEntryAbcd');
});

test('messages typed long after the last bridge record are counted as possibly missing', t => {
  const file = path.join(tempDir(t), 'session.jsonl');
  fs.writeFileSync(file, bridgeLine('cse_01SomeEntryAbcd') + Array.from({ length: 12 }, (_, i) => typedLine(`m${i}`)).join(''));
  assert.deepEqual(remoteControlEntry(file), { url: 'https://claude.ai/code/session_01SomeEntryAbcd', missing: 12 });
});


const linked = (uuid, parentUuid, type = 'system') => `${JSON.stringify({ type, uuid, parentUuid })}\n`;

test('two cloud parts with stray lines between and after them end up last, in order, with nothing lost', t => {
  const file = path.join(tempDir(t), 'session.jsonl');
  const local = linked('l1', null, 'user');
  const cloud1 = linked('c1', 'l1', 'user') + linked('c2', 'c1', 'assistant');
  const stray1 = linked('s1', 'l1') + bridgeLine('cse_x');
  const cloud2 = linked('c3', 'c2', 'user') + linked('c4', 'c3', 'assistant');
  const stray2 = linked('s2', 's1');
  const text = local + cloud1 + stray1 + cloud2 + stray2;
  fs.writeFileSync(file, text);
  const at = part => text.indexOf(part);
  const record = { cloudLeaf: 'c4', blocks: [[at(cloud1), at(cloud1) + cloud1.length], [at(cloud2), at(cloud2) + cloud2.length]] };

  assert.equal(cloudShown(file, record), false);
  assert.ok(putCloudLast(file, record, { dryRun: true }));
  assert.equal(fs.readFileSync(file, 'utf8'), text);

  const fixed = putCloudLast(file, record);
  assert.equal(fs.readFileSync(file, 'utf8'), local + stray1 + stray2 + cloud1 + cloud2);
  assert.deepEqual(fixed, { blocks: [[local.length + stray1.length + stray2.length, text.length]], localTo: text.length });
  assert.equal(cloudShown(file, { ...record, ...fixed }), true);

  // A window that loads it now writes on top of the cloud part, which keeps it shown.
  fs.appendFileSync(file, linked('w1', 'c4') + bridgeLine('cse_y'));
  assert.equal(cloudShown(file, { ...record, ...fixed }), true);
});

test('a typed message or a cut-off line after the cloud part is never moved', t => {
  const file = path.join(tempDir(t), 'session.jsonl');
  const local = linked('l1', null, 'user');
  const cloud = linked('c1', 'l1', 'user');
  const record = { cloudLeaf: 'c1', blocks: [[local.length, local.length + cloud.length]] };
  for (const after of [typedLine('typed without the cloud part'), '{"type":"system","uuid":"s1"']) {
    fs.writeFileSync(file, local + cloud + after);
    assert.equal(putCloudLast(file, record), null);
    assert.equal(fs.readFileSync(file, 'utf8'), local + cloud + after);
  }
  // Handoffs pulled before Skyhop tracked the cloud part count as shown, as before.
  assert.equal(cloudShown(file, {}), true);
});

test("the cloud's own commit nudge can't pick up sensitive files, and the chat is told not to push", async t => {
  const { handOff, cloudWork } = setup(t);
  const vm = handOff();
  cloudWork(vm);
  for (const file of ['.env', '.env.local', 'deploy.key', 'config/secrets.json', '.env.example', 'notes.txt']) write(vm, file, 'x\n');
  const offered = run(vm, 'status', '--porcelain', '--untracked-files=all').split('\n').map(line => line.slice(3)).filter(Boolean);
  assert.deepEqual(offered.filter(file => file !== 'cloud-work.txt').sort(), ['.env.example', 'notes.txt']);
  const { relayOutput } = await import('../scripts/relay.mjs');
  assert.match(relayOutput('done', () => '').hookSpecificOutput.additionalContext, /Do not commit or push anything, even if a hook asks you to/);
});
