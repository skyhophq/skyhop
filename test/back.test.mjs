// The full round trip: hand off, work in a fake VM, then bring it all home.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { localTurnsAfter } from '../scripts/back.mjs';
import { handlePrompt } from '../scripts/relay.mjs';
import { dirty, makeRepo, run, tempDir, write } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '../scripts/skyhop.mjs');
const FIXTURES = path.join(HERE, 'fixtures');
const SESSION = '11111111-2222-3333-4444-555555555555';
const LOCAL = `{"type":"user","sessionId":"${SESSION}","message":{"content":"before the handoff"}}\n`;
const CLOUD = `{"type":"user","sessionId":"${SESSION}","message":{"content":"from my phone"}}\n{"type":"assistant","sessionId":"${SESSION}","message":{"content":[]}}\n`;

function setup(t, options) {
  const repo = makeRepo(t, options);
  const home = path.join(repo.base, 'home');
  const briefFile = path.join(home, '.skyhop/briefs/brief.md');
  write(home, '.skyhop/briefs/brief.md', '## Goal\nShip it.\n');
  write(home, `.claude/projects/some-project/${SESSION}.jsonl`, LOCAL);
  const localSession = path.join(home, `.claude/projects/some-project/${SESSION}.jsonl`);
  const skyhop = (args, env = {}) => {
    const result = spawnSync('node', [SCRIPT, ...args], {
      cwd: repo.root,
      encoding: 'utf8',
      env: {
        ...process.env, HOME: home, PATH: `${FIXTURES}:${process.env.PATH}`, FAKE_CLAUDE_DIR: repo.base,
        FAKE_CLAUDE_MODE: '', SKYHOP_LAUNCH_WAIT_MS: '5000', SKYHOP_LAUNCH_SETTLE_MS: '100', ...env,
      },
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const handOff = (...flags) => {
    const result = skyhop(['--brief', briefFile, '--session', SESSION, '--yes', '--full-resume', ...flags]);
    assert.equal(result.status, 0, result.output);
    return path.join(repo.base, 'vm');
  };
  // Runs the real relay in the fake VM, as the hook would for the first message.
  const cloudWork = (vm, { chat = CLOUD, code = true } = {}) => {
    const realHome = process.env.HOME;
    process.env.HOME = path.join(repo.base, 'vm-home');
    try {
      const first = fs.readFileSync(path.join(repo.base, 'prompt'), 'utf8');
      const output = handlePrompt({
        prompt: first,
        hookMode: 'default',
        root: vm,
        resume: (_root, sessionId) => {
          fs.appendFileSync(path.join(process.env.HOME, '.claude/projects/skyhop-import', `${sessionId}.jsonl`), chat);
          if (code) write(vm, 'cloud-work.txt', 'made in the cloud\n');
          return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'done' }) };
        },
      });
      assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /could not save|Warning/);
    } finally {
      process.env.HOME = realHome;
    }
  };
  const syncBranches = () => run(repo.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/skyhop-sync');
  return { ...repo, home, skyhop, handOff, cloudWork, localSession, syncBranches };
}

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
  assert.equal(fs.statSync(path.join(home, `.skyhop/sessions/${SESSION}.json`)).mode & 0o777, 0o600);
});

test('the round trip adds the cloud conversation to the same session and brings the code', t => {
  const { root, bare, home, skyhop, handOff, cloudWork, localSession, syncBranches } = setup(t);
  dirty(root);
  cloudWork(handOff());

  const result = skyhop(['--back']);
  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL + CLOUD);
  assert.ok(result.output.includes(`claude --resume ${SESSION}`));

  assert.match(run(root, 'symbolic-ref', '--short', 'HEAD'), /^skyhop\/back-/);
  assert.equal(fs.readFileSync(path.join(root, 'cloud-work.txt'), 'utf8'), 'made in the cloud\n');
  assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'NAME=value\n');
  assert.equal(run(root, 'rev-parse', 'main'), run(root, 'rev-parse', 'origin/main'));

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
  assert.equal(second.status, 1);
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

test('a session still open in a window becomes a new session', t => {
  const { skyhop, handOff, cloudWork, localSession } = setup(t);
  cloudWork(handOff());
  const result = skyhop(['--back'], { FAKE_CLAUDE_AGENTS: JSON.stringify([{ sessionId: SESSION, status: 'idle' }]) });
  assert.match(result.output, /still open in a Claude Code window/);
  assert.equal(fs.readFileSync(localSession, 'utf8'), LOCAL);
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
