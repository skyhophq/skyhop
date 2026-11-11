#!/usr/bin/env node
// Release check against the real cloud. It is not part of `npm test`: it starts real
// cloud chats on your claude.ai account and pushes test branches to this repository's
// GitHub remote, then removes them. Run it from a clone of a GitHub repository that has
// the Claude GitHub App and that Claude Code already trusts, after each Claude Code
// release and before each Skyhop release:
//
//   node test/live.mjs                  one trip up and home, 3 exchanges replayed
//   node test/live.mjs --again          then a second trip back to the same chat
//   node test/live.mjs --exchanges 50   replay 50 exchanges
//   node test/live.mjs --job 60         make the cloud work on one message for an hour
//                                       (from a Skyhop clone, which has test/live-job.mjs)
//   node test/live.mjs --windows-path   start the chat the way Skyhop does on Windows
//   node test/live.mjs --keep           leave the branches and records for a look
//
// The test session is a throwaway one, made here with Haiku, so no real conversation
// leaves the computer. The uncommitted changes in the folder do go along, sealed, like
// in any handoff. Each step prints how long it took, and the run ends with the chats to
// archive on claude.ai.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runClaude, sendToChat } from '../scripts/cloud.mjs';
import { jobToken } from './live-job.mjs';

const SKYHOP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'skyhop.mjs');
const HOME = os.homedir();
const POLL_MS = 10_000;
const REPLY_WAIT_MS = 15 * 60_000;
// One step of the long job, run by test/live-job.mjs. Claude Code refuses plain `sleep`
// commands, and one shell call can run for at most 10 minutes.
const JOB_STEP_SECONDS = 300;

const { values: flags } = parseArgs({
  options: {
    again: { type: 'boolean', default: false },
    exchanges: { type: 'string', default: '3' },
    job: { type: 'string' },
    'windows-path': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const exchangeCount = Number(flags.exchanges);
const jobMinutes = flags.job === undefined ? 0 : Number(flags.job);
if (!Number.isInteger(exchangeCount) || exchangeCount < 1 || exchangeCount > 200) throw new Error('--exchanges takes 1 to 200');
if (!Number.isFinite(jobMinutes) || jobMinutes < 0) throw new Error('--job takes a number of minutes');

const started = Date.now();
const stamp = () => `[${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s]`;
const say = text => console.log(`${stamp()} ${text}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  return ok;
}

function run(command, args, { env = {}, cwd = root } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const git = args => run('git', args).out.trim();
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
if (!root) throw new Error('Run this from inside a git repository with a GitHub remote.');

function signedIn() {
  const status = runClaude(['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const parsed = JSON.parse(status.stdout);
    const days = parsed.loginExpiresAt ? (Date.parse(parsed.loginExpiresAt) - Date.now()) / 86_400_000 : null;
    if (days !== null && days < 2) say(`Note: the sign-in expires in ${days.toFixed(1)} days. Run claude auth login soon.`);
    return parsed.loggedIn === true;
  } catch {
    return false;
  }
}

// The prompt goes through stdin, because on Windows the command line passes through cmd.exe.
function claudeSays(sessionId, prompt, first = false) {
  const args = ['-p', '--model', 'haiku', first ? '--session-id' : '--resume', sessionId];
  return runClaude(args, { cwd: root, input: prompt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).status === 0;
}

const recordFile = sessionId => path.join(HOME, '.skyhop', 'sessions', `${sessionId}.json`);
const readRecord = sessionId => JSON.parse(fs.readFileSync(recordFile(sessionId), 'utf8'));

function headsNow(names) {
  const out = git(['ls-remote', 'origin', ...names.map(name => `refs/heads/${name}`)]);
  const heads = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    heads[ref.replace('refs/heads/', '')] = sha;
  }
  return heads;
}

// A reply is saved when the chat branch has moved and matches the pulse branch,
// which the relay moves ahead at the start of each reply.
async function waitSaved(chatRef, before, waitMs) {
  const pulse = chatRef.replace(/-chat$/, '-pulse');
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const heads = headsNow([chatRef, pulse]);
    const chat = heads[chatRef];
    if (chat && chat !== before && chat === heads[pulse]) return chat;
    await sleep(POLL_MS);
  }
  return null;
}

function repliesNaming(sessionId, word) {
  const dir = path.join(HOME, '.claude', 'projects');
  for (const project of fs.readdirSync(dir)) {
    const file = path.join(dir, project, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return {}; } })
      .filter(entry => entry.type === 'assistant')
      .flatMap(entry => (entry.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text))
      .filter(text => text.includes(word));
  }
  return [];
}

function handOff(sessionId, brief, { newChat }) {
  const args = [SKYHOP, '--brief', brief, '--session', sessionId, '--yes', '--history', String(exchangeCount)];
  if (newChat) args.push('--new-chat');
  return run('node', args, { env: flags['windows-path'] ? { SKYHOP_LAUNCH: 'hidden' } : {} });
}

function comeHome(sessionId) {
  return run('node', [SKYHOP, '--back', '--session', sessionId]);
}

function showLog(sessionId) {
  const file = path.join(HOME, '.skyhop', 'logs', `cloud-${sessionId}.log`);
  if (!fs.existsSync(file)) return;
  console.log(`--- last lines of ${file}`);
  console.log(fs.readFileSync(file, 'utf8').trim().split('\n').slice(-15).join('\n'));
}

async function ask(chat, chatRef, before, question, word, waitMs) {
  const sent = sendToChat(chat, question);
  if (!check('message posted to the chat', sent.ok, sent.error)) return null;
  const saved = await waitSaved(chatRef, before, waitMs);
  check(`reply saved for "${question.slice(0, 50)}..."`, Boolean(saved));
  return saved;
}

async function trip({ sessionId, brief, newChat, word, expect }) {
  say(newChat ? 'Handing off to a new chat...' : 'Handing off again, to the same chat...');
  const up = handOff(sessionId, brief, { newChat });
  const launched = newChat ? /Cloud session started on/.test(up.out) : /Back in this session's earlier cloud chat/.test(up.out);
  if (!check(newChat ? 'chat started' : 'earlier chat picked it up', launched && up.code === 0, launched ? '' : up.out.trim().split('\n').slice(-6).join(' | '))) {
    showLog(sessionId);
    return false;
  }
  const shown = up.out.match(/now shows (\d+) exchange/);
  const partly = up.out.match(/shows (\d+) of (\d+) exchange/);
  check('earlier conversation replayed', Number(shown?.[1] ?? partly?.[1] ?? 0) === expect,
    shown ? `${shown[1]} of ${expect}` : partly ? `${partly[1]} of ${partly[2]}, wanted ${expect}` : 'no replay line');

  const record = readRecord(sessionId);
  const chat = record.cloud.sessionId;
  const chatRef = record.sync.chatRef;
  chats.add(record.cloud.url);
  tails.add(chatRef.replace(/^skyhop-sync\//, '').replace(/-chat$/, ''));
  tails.add(record.cloud.runBranch.replace(/^skyhop-run\//, ''));

  let saved = await waitSaved(chatRef, headsNow([chatRef])[chatRef] ?? '', REPLY_WAIT_MS);
  if (!check('first reply saved', Boolean(saved))) return false;
  saved = await ask(chat, chatRef, saved, 'What is the newest codeword in this session? Reply with just the codeword.', word, REPLY_WAIT_MS);
  if (!saved) return false;
  let token = null;
  if (jobMinutes > 0 && newChat) {
    const steps = Math.max(1, Math.round((jobMinutes * 60) / JOB_STEP_SECONDS));
    const seconds = Math.round((jobMinutes * 60) / steps);
    const jobWord = `JOB-${randomBytes(3).toString('hex').toUpperCase()}`;
    token = jobToken(jobWord, steps);
    say(`Long job: ${steps} step(s) of ${seconds}s, about ${jobMinutes} minutes...`);
    const jobStarted = Date.now();
    saved = await ask(chat, chatRef, saved,
      `This is a long-job test. Run node test/live-job.mjs ${jobWord} N ${seconds} for N = 1 to ${steps}, one step at a time and in order, each as its own Bash call with the timeout set to 600000 ms. Each step works for about ${Math.round(seconds / 60)} minutes and ends by printing a token. Wait for each step to finish before starting the next, and don't run them in the background or in parallel. After step ${steps}, reply with just the token it printed.`,
      token, (jobMinutes * 2 + 15) * 60_000);
    if (!saved) return false;
    const minutes = (Date.now() - jobStarted) / 60_000;
    check('the long job ran its full length', minutes >= jobMinutes * 0.8, `${minutes.toFixed(1)} of about ${jobMinutes} minutes`);
  }
  await sleep(5000);

  say('Coming home...');
  const home = comeHome(sessionId);
  check('came home', home.code === 0, home.code === 0 ? '' : home.out.trim().split('\n').slice(-4).join(' | '));
  const named = repliesNaming(sessionId, word);
  check(`a reply that came home names ${word}`, named.length > 0);
  if (token) check(`the long job's reply came home with its last token (${token})`, repliesNaming(sessionId, token).length > 0);
  return true;
}

function cleanUp(sessionId, brief) {
  const names = git(['ls-remote', '--heads', 'origin']).split('\n').filter(Boolean)
    .map(line => line.split('\t')[1].replace('refs/heads/', ''))
    .filter(name => [...tails].some(tail => name.includes(tail)));
  if (names.length > 0) {
    const removed = run('git', ['push', '-q', 'origin', '--delete', ...names]);
    say(removed.code === 0 ? `Removed ${names.length} test branch(es).` : `Could not remove the test branches: ${removed.out.trim()}`);
  }
  for (const file of [recordFile(sessionId), brief, `${brief}.prompt.md`]) fs.rmSync(file, { force: true });
}

const chats = new Set();
const tails = new Set();

async function main() {
  say(`Skyhop live check in ${root}: ${exchangeCount} exchange(s)${flags.again ? ', a second trip' : ''}${jobMinutes ? `, a ${jobMinutes}-minute job` : ''}${flags['windows-path'] ? ', Windows launch path' : ''}.`);
  if (!check('signed in to Claude Code', signedIn())) return;
  if (!check('origin is on GitHub', /github\.com/.test(git(['remote', 'get-url', 'origin'])))) return;
  // The cloud runs the job from its copy of this folder.
  if (jobMinutes > 0 && !check('test/live-job.mjs is in this folder, for --job', fs.existsSync(path.join(root, 'test', 'live-job.mjs')))) return;

  const sessionId = randomUUID();
  const word = `LIVE-${randomBytes(3).toString('hex').toUpperCase()}`;
  say(`Making a throwaway session ${sessionId} with ${exchangeCount} exchange(s)...`);
  let made = claudeSays(sessionId, `This is a Skyhop live check. Remember this codeword: ${word}. Reply with just OK. Use no tools.`, true);
  for (let n = 2; made && n <= exchangeCount; n += 1) {
    made = claudeSays(sessionId, `Exchange ${n}. Reply with just the number ${n}. Use no tools.`);
  }
  if (!check('test session made', made)) return;

  const brief = path.join(HOME, '.skyhop', 'briefs', `live-${sessionId}.md`);
  fs.mkdirSync(path.dirname(brief), { recursive: true });
  fs.writeFileSync(brief, '## Goal\nSkyhop live check.\n\n## Remaining work\nNothing. When asked, reply in one short line.\n', { mode: 0o600 });
  try {
    if (!await trip({ sessionId, brief, newChat: true, word, expect: exchangeCount })) return;
    if (flags.again) {
      const second = `LIVE-${randomBytes(3).toString('hex').toUpperCase()}`;
      say('One exchange on this computer before going up again...');
      check('local exchange', claudeSays(sessionId, `New codeword for this session: ${second}. Reply with just OK. Use no tools.`));
      await trip({ sessionId, brief, newChat: false, word: second, expect: 1 });
    }
  } finally {
    if (flags.keep) say(`Kept the branches and the record for ${sessionId}.`);
    else cleanUp(sessionId, brief);
  }
}

await main();
const failed = results.filter(result => !result.ok);
console.log(`\n${failed.length === 0 ? 'All passed' : `${failed.length} check(s) failed`} (${results.length} checks, ${Math.round((Date.now() - started) / 60_000)} min).`);
if (chats.size > 0) console.log(`Archive the test chat(s) on claude.ai when you're done:\n${[...chats].map(url => `  ${url}`).join('\n')}`);
process.exitCode = failed.length === 0 && results.length > 0 ? 0 : 1;
