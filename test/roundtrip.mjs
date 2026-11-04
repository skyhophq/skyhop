// A repo with a remote, a fake home folder and a fake VM, for tests that hand a
// session off, work in the cloud and bring it home.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePrompt } from '../scripts/relay.mjs';
import { makeRepo, run, write } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '../scripts/skyhop.mjs');
const HOOK = path.join(HERE, '../scripts/homecoming.mjs');
const FIXTURES = path.join(HERE, 'fixtures');
export const SESSION = '11111111-2222-3333-4444-555555555555';
export const LOCAL = `{"type":"user","sessionId":"${SESSION}","message":{"content":"before the handoff"}}\n`;
export const CLOUD = `{"type":"user","sessionId":"${SESSION}","message":{"content":"from my phone"}}\n{"type":"assistant","sessionId":"${SESSION}","message":{"content":[]}}\n`;
export const CLOUD2 = `{"type":"user","sessionId":"${SESSION}","message":{"content":"again from my phone"}}\n{"type":"assistant","sessionId":"${SESSION}","message":{"content":[]}}\n`;

export function setup(t, options) {
  const repo = makeRepo(t, options);
  const home = path.join(repo.base, 'home');
  const briefFile = path.join(home, '.skyhop/briefs/brief.md');
  write(home, '.skyhop/briefs/brief.md', '## Goal\nShip it.\n');
  write(home, `.claude/projects/some-project/${SESSION}.jsonl`, LOCAL);
  const localSession = path.join(home, `.claude/projects/some-project/${SESSION}.jsonl`);
  const vm = path.join(repo.base, 'vm');
  const env = (extra = {}) => ({
    ...process.env, HOME: home, PATH: `${FIXTURES}:${process.env.PATH}`, FAKE_CLAUDE_DIR: repo.base,
    FAKE_CLAUDE_MODE: '', SKYHOP_LAUNCH_WAIT_MS: '5000', SKYHOP_LAUNCH_SETTLE_MS: '100',
    CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '4242', CLAUDE_CODE_REMOTE: '', SKYHOP_INNER: '',
    SKYHOP_LOAD_MARGIN_MS: '0', ...extra,
  });
  const skyhop = (args, extra) => {
    const result = spawnSync('node', [SCRIPT, ...args], { cwd: repo.root, encoding: 'utf8', env: env(extra) });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  // Runs a plugin hook as Claude Code would, and returns its JSON output, or null.
  const hook = (event, input, extra) => {
    const result = spawnSync('node', [HOOK, event], {
      cwd: repo.root, encoding: 'utf8', env: env(extra), input: JSON.stringify({ cwd: repo.root, ...input }),
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  };
  // Each handoff gets a fresh VM, as in the real cloud.
  const handOff = (...flags) => {
    fs.rmSync(vm, { recursive: true, force: true });
    fs.rmSync(path.join(repo.base, 'vm-home'), { recursive: true, force: true });
    const result = skyhop(['--brief', briefFile, '--session', SESSION, '--yes', ...flags]);
    assert.equal(result.status, 0, result.output);
    return vm;
  };
  // Runs the real relay in the fake VM, as the hook would. The first call sends the
  // handoff's first message, later calls send `prompt`.
  const cloudWork = (dir, { chat = CLOUD, code = true, prompt, check = true, busyCheck } = {}) => {
    const realHome = process.env.HOME;
    process.env.HOME = path.join(repo.base, 'vm-home');
    try {
      const output = handlePrompt({
        prompt: prompt ?? fs.readFileSync(path.join(repo.base, 'prompt'), 'utf8'),
        hookMode: 'default',
        root: dir,
        resume: (_root, sessionId) => {
          busyCheck?.();
          fs.appendFileSync(path.join(process.env.HOME, '.claude/projects/skyhop-import', `${sessionId}.jsonl`), chat);
          if (code) write(dir, typeof code === 'string' ? code : 'cloud-work.txt', 'made in the cloud\n');
          return { status: 0, stdout: JSON.stringify({ type: 'result', result: 'done' }) };
        },
      });
      if (check) assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /could not save|Warning/);
      return output;
    } finally {
      process.env.HOME = realHome;
    }
  };
  const remoteBranches = prefix => run(repo.bare, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}`);
  const syncBranches = () => remoteBranches('skyhop-sync');
  const record = () => JSON.parse(fs.readFileSync(path.join(home, `.skyhop/sessions/${SESSION}.json`), 'utf8'));
  return { ...repo, home, briefFile, vm, skyhop, hook, handOff, cloudWork, localSession, syncBranches, remoteBranches, record };
}
