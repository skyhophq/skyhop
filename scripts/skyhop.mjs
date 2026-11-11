#!/usr/bin/env node
// Main entry point for /skyhop and /skyhop-status.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  bringBack, forgetHandoff, readRecord, remoteControlEntry, saveHandoffRecord, waitingRecords,
} from './back.mjs';
import { briefPrompt, loadBrief, reconnectPrompt, redactPaths, resumePrompt } from './brief.mjs';
import {
  hiddenLaunch, launchHidden, launchSession, launchTimes, pasteCommand, readHistory, recordHandoff, reopenWaitMs, requireSignIn,
  runClaude, sendToChat, waitForBranch, waitForPulse,
} from './cloud.mjs';
import { addRelayCommit, findTranscript, LARGE_TRANSCRIPT_BYTES, measureUpload } from './fullresume.mjs';
import { MAX_MEMORY_BYTES, memoryDir, memoryEnabled, memoryHashes, readMemory } from './memory.mjs';
import { HISTORY_EXCHANGES, recentConversation, replayHistory } from './conversation.mjs';
import { HISTORY_MARK, READY_PING } from './replay.mjs';
import {
  createSnapshot, git, maskUrl, pendingCommitCount, pendingDiff, prepareLaunchFolder, publicRemoteUrl,
  pushBranch, removeLaunchFolder, repoBytes, repoInfo, skyhopBranch, SkyhopError, snapshotStat, tryGit,
} from './git.mjs';
import { findLeftovers, formatLeftovers, removeLeftovers } from './leftovers.mjs';
import { log, logDir, privateFile, privateHome, skyhopVersion } from './log.mjs';
import { formatFinding, isSensitivePath, scanDiff, scanText } from './secrets.mjs';
import { newKey, PULSE_READY, pulseRef } from './sync.mjs';

const MODES = ['auto', 'acceptEdits', 'plan'];
const EXIT_NEEDS_CONFIRMATION = 2;
const EXIT_NEEDS_TERMINAL = 3;
const STATUS_LIMIT = 10;
const STAMP_LENGTH = '20261102-154402'.length;
const MAX_HISTORY = 200;
// How long the cloud chat gets to restart with Skyhop's plugin, and the pause
// between two replayed messages, so each gets its own reply.
const historyWaitMs = () => Number(process.env.SKYHOP_HISTORY_WAIT_MS ?? 180_000);
// The chat normally says it is ready by itself, about a minute and a half after the
// setup message. If it hasn't by then, Skyhop asks once.
const historyPingMs = () => Number(process.env.SKYHOP_HISTORY_PING_MS ?? 150_000);
const historySpacingMs = () => Number(process.env.SKYHOP_HISTORY_SPACING_MS ?? 3000);
const HISTORY_PROGRESS_EVERY = 10;
// Claude runs /skyhop as a shell command, which stops after 10 minutes at most. The
// replay fits in what is left, leaving out the oldest exchanges when it must, so the
// message that starts the work always gets sent.
const STARTED_AT = Date.now();
const timeBudgetMs = () => Number(process.env.SKYHOP_TIME_BUDGET_MS ?? 9 * 60_000);
const FINAL_MESSAGE_MS = 30_000;
const SEND_ESTIMATE_MS = 2500;
const timeLeft = () => STARTED_AT + timeBudgetMs() - Date.now();

function readOptions(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        brief: { type: 'string' },
        session: { type: 'string' },
        name: { type: 'string' },
        mode: { type: 'string', default: 'auto' },
        'dry-run': { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        summary: { type: 'boolean', default: false },
        'full-resume': { type: 'boolean', default: false },
        'allow-secrets': { type: 'boolean', default: false },
        status: { type: 'boolean', default: false },
        back: { type: 'boolean', default: false },
        clean: { type: 'boolean', default: false },
        'no-sync': { type: 'boolean', default: false },
        'new-chat': { type: 'boolean', default: false },
        history: { type: 'string', default: process.env.SKYHOP_HISTORY || String(HISTORY_EXCHANGES) },
      },
    }).values;
  } catch (error) {
    throw new SkyhopError(error.message, 'Flags are --summary, --name, --dry-run, --yes, --mode, --history, --no-sync, --new-chat and --allow-secrets.');
  }
  // The skill passes ~/.skyhop/briefs/..., which not every shell expands.
  if (/^~[\\/]/.test(parsed.brief ?? '')) parsed.brief = path.join(os.homedir(), parsed.brief.slice(2));
  parsed.historyCount = /^(off|none|no)$/i.test(parsed.history) ? 0 : Number(parsed.history);
  if (!Number.isInteger(parsed.historyCount) || parsed.historyCount < 0 || parsed.historyCount > MAX_HISTORY) {
    throw new SkyhopError(`Unknown --history value: ${parsed.history}`, `Use a number of exchanges from 0 to ${MAX_HISTORY}, or off.`);
  }
  if (!MODES.includes(parsed.mode)) throw new SkyhopError(`Unknown mode: ${parsed.mode}`, `Use one of: ${MODES.join(', ')}.`);
  if (parsed.summary && parsed['full-resume']) throw new SkyhopError('--summary and --full-resume ask for different handoffs.', 'Use one of them.');
  // Full resume is the default. --full-resume still works, for older habits.
  parsed['full-resume'] = !parsed.summary;
  return parsed;
}

function syncEnabled(info, options) {
  return Boolean(info.remoteUrl) && !options['no-sync'];
}

// The project's memory notes, which go along with a full resume. Null when auto
// memory is off here, and `tooBig` when they're over the limit and stay behind.
function handoffMemory(transcriptPath, root) {
  if (!memoryEnabled({ root })) return null;
  const dir = memoryDir({ transcriptPath, root });
  const { files, bytes } = readMemory(dir);
  return { dir, files, count: Object.keys(files).length, tooBig: bytes > MAX_MEMORY_BYTES };
}

function memoryLine(memory) {
  if (!memory) return '  Memory:     auto memory is off here, so no notes go along';
  if (memory.tooBig) return "  Memory:     this project's memory notes are over 1 MB, so they stay here";
  return memory.count > 0
    ? `  Memory:     ${memory.count} memory note(s) from this project go along, encrypted, and the cloud's changes come back`
    : '  Memory:     no memory notes for this project yet. Notes the cloud session saves come back';
}

function printPlan({ info, branch, snapshot, pending, options, transcript, reuse, remote, memory, recent, history }) {
  const fullResume = options['full-resume'];
  const lines = [
    'Skyhop plan',
    `  Mode:       ${fullResume ? 'full resume, the same session continues in the cloud' : 'summary handoff, a new session starts from a brief'}`,
    `  Branch:     ${branch}${fullResume ? ' (not pushed)' : ''}`,
    `  Remote:     ${info.remote ? `${info.remote} (${maskUrl(info.remoteUrl)})` : 'none'}`,
    `  Changes:    ${snapshot.created ? `${snapshot.files.length} uncommitted file(s)` : 'no uncommitted changes'}`,
    `  Unpushed:   ${pending} commit(s)`,
  ];
  if (snapshot.excluded.length > 0) lines.push(`  Left out:   ${snapshot.excluded.join(', ')}`);
  if (fullResume) {
    lines.push(
      `  Permission: ${options.mode}. To change it later, send "skyhop mode acceptEdits", "skyhop mode auto" or "skyhop mode plan" in the chat`,
      ...(syncEnabled(info, options)
        ? [
          `  Upload:     your code and the session transcript (${(transcript.bytes / 1e6).toFixed(1)} MB, encrypted) are pushed to a skyhop-run branch on ${info.remote}`,
          '              The key to the transcript goes only in the first message of the cloud session.',
          `  Sync:       after each reply, the cloud session pushes your code and the encrypted conversation to skyhop-sync branches on ${info.remote}, so the session can come home`,
          `  Cloud chat: ${reuse ? `back to this session's earlier chat, ${reuse.url}` : 'a new chat'}`,
        ]
        : [
          `  Upload:     the snapshot, possibly your other local branches, and the full session transcript (${(transcript.bytes / 1e6).toFixed(1)} MB, about ${(transcript.compressed / 1e6).toFixed(1)} MB compressed), sent directly to the session`,
          '              The transcript holds everything Claude read and ran, including private paths.',
          '  Sync:       off, so /skyhop-back will have nothing to bring home',
        ]),
    );
    const shown = history?.exchanges.length ?? 0;
    const minutes = Math.ceil((120_000 + shown * (historySpacingMs() + 2000)) / 60_000);
    const quoted = shown > 0
      ? `shows ${reuse ? `the ${shown} exchange(s) since it was last in the cloud` : `your last ${shown} exchange(s)`} as real messages (about ${minutes} more minute(s): keep this computer awake until Skyhop says it is done)`
      : recent.count > 0 ? `quotes your last ${recent.count} message(s) word for word` : 'starts with a recap';
    lines.push(remote
      ? `  History:    the cloud chat ${quoted}, and links to your whole conversation in this session's Remote Control entry: ${remote.url}`
      : `  History:    the cloud chat ${quoted}. Remote Control is off, so there's no link to your whole conversation. To add one, type /remote-control before going ahead`);
    if (remote?.missing) lines.push(`              Remote Control was off for your last ${remote.missing} messages, so that entry may not show them.`);
    lines.push(memoryLine(memory));
    if (transcript.bytes >= LARGE_TRANSCRIPT_BYTES) lines.push('  Warning:    long sessions use more of your plan on every message.');
  } else {
    lines.push(
      `  Upload:     the branch is pushed to ${info.remote}, and the brief is the first prompt`,
      "              If the Claude GitHub App isn't on this repo, Claude Code uploads the repo directly instead, possibly with your other local branches.",
    );
  }
  console.log(lines.join('\n'));

  const stat = snapshotStat(info.root, info.head, snapshot.sha);
  if (stat) console.log(`\n${stat}`);
}

// The preview and the real run are separate commands, so the preview saves its
// branch name for the real run. Using it once means a retry gets a fresh name.
function chooseBranch(options, info) {
  const fresh = skyhopBranch(options.name ?? info.branch ?? 'detached');
  const file = `${options.brief}.branch`;
  if (options['dry-run']) {
    fs.writeFileSync(file, fresh);
    return fresh;
  }
  let saved = null;
  try {
    saved = fs.readFileSync(file, 'utf8').trim();
    fs.rmSync(file);
  } catch {
    return fresh;
  }
  const withoutStamp = branch => branch.slice(0, -STAMP_LENGTH);
  return withoutStamp(saved) === withoutStamp(fresh) ? saved : fresh;
}

function findSecrets({ info, snapshot, prompt, transcript, notes }) {
  return [
    ...scanDiff(pendingDiff(info.root, snapshot.sha, info.remote)),
    ...scanText(prompt, { source: 'brief' }),
    ...(transcript ? scanText(fs.readFileSync(transcript.path, 'utf8'), { source: 'session transcript', strict: true }) : []),
    ...Object.entries(notes ?? {}).flatMap(([name, text]) => scanText(text, { source: `memory note ${name}` })),
  ];
}

async function confirm() {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await reader.question('\nHand off now? [y/N] ');
  reader.close();
  return /^y(es)?$/i.test(answer.trim());
}

function savePrompt(briefFile, prompt) {
  const file = `${briefFile}.prompt.md`;
  fs.writeFileSync(file, prompt, { mode: 0o600 });
  privateFile(file);
  return file;
}

const COMING_HOME = 'Quit this window now (type /exit). When you are back, open claude in this folder and pick this session in /resume: it will have the cloud conversation, and it comes home for good when you send a message.';

function reportLaunch({ outcome, command, record, synced }) {
  log('handoff', 'launch', {
    result: outcome.status, reason: outcome.reason, chat: outcome.sessionId,
    program: outcome.program, seconds: outcome.seconds, 'program-quit-after': outcome.quitAfter, detail: outcome.status === 'started' ? null : outcome.detail,
  });
  if (outcome.status === 'started') {
    recordHandoff({ ...record, status: 'started', sessionId: outcome.sessionId, url: outcome.url });
    console.log(`\nCloud session started on ${record.branch}.\nSession ID: ${outcome.sessionId}\nLink: ${outcome.url}`);
    if (synced) console.log(`\n${COMING_HOME}`);
    return 0;
  }
  if (outcome.status === 'needs-terminal') {
    recordHandoff({ ...record, status: 'waiting for terminal' });
    const why = outcome.reason === 'trust'
      ? "Claude Code needs you to trust this repository, because you haven't trusted it yet."
      : 'Claude Code needs a real terminal to start this session.';
    console.log(`\n${why}\nRun this in your own terminal${outcome.reason === 'trust' ? ', and choose "Yes, I trust this folder"' : ''}:\n\n${command}`);
    return EXIT_NEEDS_TERMINAL;
  }
  if (outcome.notStarted) {
    recordHandoff({ ...record, status: 'not started' });
    console.log(`\nClaude Code could not be started on this computer to open the cloud chat, so nothing was handed off. The branch Skyhop pushed was removed, and this session carries on here.\n\n${outcome.detail ?? ''}`.trimEnd());
    return 1;
  }
  recordHandoff({ ...record, status: 'unconfirmed' });
  console.log(command
    ? `\nThe launch finished without showing a session link. Check https://claude.ai/code for a new session on ${record.branch}.\nIf there is none, run this in your own terminal:\n\n${command}`
    : `\nSkyhop could not confirm that the cloud chat started. Check https://claude.ai/code for a new session on ${record.branch}.\nIf there is none, and Claude Code has never opened this repository, open claude in it once and answer the trust question, then run /skyhop again.`);
  if (outcome.detail) console.log(`\nLast output:\n${outcome.detail}`);
  return 0;
}

// The chat's last start branch is normally gone, because coming home deletes it.
// One left behind belongs to this session's closed chat, so it can go.
function clearOldStart(info, name) {
  if (tryGit(info.root, ['ls-remote', '--heads', info.remote, `refs/heads/${name}`])) {
    git(info.root, ['push', '-q', info.remote, '--delete', name]);
  }
}

// The relay marks itself busy as soon as it takes the message, which shows the
// chat picked up the handoff.
async function reportReconnect({ info, reuse, record, ackBranch }) {
  const picked = await waitForBranch(info, ackBranch, reopenWaitMs());
  log('handoff', picked ? 'the earlier chat picked it up' : 'the earlier chat has not answered yet');
  recordHandoff({ ...record, status: picked ? 'reconnected' : 'sent to earlier chat', sessionId: reuse.sessionId, url: reuse.url });
  console.log(picked
    ? `\nBack in this session's earlier cloud chat: ${reuse.url}\nIt picked up the handoff and is replying there now.`
    : `\nSent to this session's earlier cloud chat: ${reuse.url}\nIt hasn't picked the handoff up yet, probably because its cloud machine is starting again, which can take a few minutes. If the chat says Skyhop couldn't reconnect, run /skyhop --new-chat.`);
  console.log(`\n${COMING_HOME}`);
  return 0;
}

function historyIntro(count, again) {
  return again
    ? `Skyhop: this session is back in the cloud. What you and Claude said on your computer since it was last here follows, word for word (${count} exchange${count === 1 ? '' : 's'}, without tool steps).`
    : `Skyhop: this chat now continues your session from your computer. Your last ${count} exchange${count === 1 ? '' : 's'} there follow${count === 1 ? 's' : ''}, word for word, without tool steps.`;
}

// The chat's first message when Skyhop sends the real one later. On Windows it is
// also a command-line argument, so it stays one line of plain characters.
function setupMessage(project, { history = true } = {}) {
  const name = project.replace(/[^A-Za-z0-9 ._-]+/g, '-');
  return `Project ${name}. Skyhop is moving this session to the cloud and setting up this chat.${history ? ' Your earlier conversation will appear here shortly.' : ''}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Puts the session's earlier conversation into the cloud chat as real messages: each
// old message of the user's is posted, and the chat's Skyhop plugin answers it with
// Claude's old reply. Then the chat gets the message that starts the work. If the
// chat never gets ready, it gets the recap it would have had without this.
// With no history, it only waits for the chat to be ready and sends the first message.
async function showHistory({ info, sessionId, history, pulse, finalMessage, fallbackMessage }) {
  const total = history?.exchanges.length ?? 0;
  console.log(total > 0
    ? `\nSetting up the cloud chat to show ${total} exchange(s) of your conversation. Keep this computer awake until Skyhop says it is done.`
    : '\nSetting up the cloud chat. Keep this computer awake until Skyhop says it is done.');
  // A chat that already has the plugin is ready at once. A new one restarts first.
  const isReady = found => found.note === PULSE_READY;
  let ready = await waitForPulse(info, pulse, historyPingMs(), isReady);
  if (!ready) {
    sendToChat(sessionId, `Skyhop: show my earlier conversation here. ${READY_PING}`);
    ready = await waitForPulse(info, pulse, historyWaitMs(), isReady);
  }
  if (!ready) {
    log('handoff', 'history: the chat did not get ready');
    const sent = sendToChat(sessionId, fallbackMessage);
    console.log(sent.ok
      ? 'The chat did not get ready to show your conversation, so it starts with a recap instead.'
      : `The chat did not get ready, and the recap could not be sent either (${sent.error}). Open the chat and send it a message to carry on.`);
    return;
  }
  if (total === 0) {
    const sent = sendToChat(sessionId, fallbackMessage);
    log('handoff', 'first message sent', { result: sent.ok ? 'sent' : sent.error });
    console.log(sent.ok ? 'The cloud chat is set up.' : `The message that starts the work could not be sent (${sent.error}). Open the chat and send it a message to carry on.`);
    return;
  }
  const each = historySpacingMs() + SEND_ESTIMATE_MS;
  const fits = Math.max(0, Math.floor((timeLeft() - FINAL_MESSAGE_MS) / each));
  const exchanges = history.exchanges.slice(-Math.max(1, Math.min(total, fits)));
  if (exchanges.length < total) {
    console.log(`There is time for the last ${exchanges.length} of ${total} exchange(s) before Claude's 10-minute limit on this command, so the older ones are left out.`);
    log('handoff', 'history trimmed for time', { kept: exchanges.length, of: total });
  }
  let shown = 0;
  for (const exchange of exchanges) {
    if (timeLeft() < FINAL_MESSAGE_MS) {
      log('handoff', 'history stopped for time', { shown, of: exchanges.length });
      break;
    }
    let sent = sendToChat(sessionId, exchange.you);
    if (!sent.ok) {
      await sleep(historySpacingMs());
      sent = sendToChat(sessionId, exchange.you);
    }
    if (!sent.ok) {
      log('handoff', 'history: a message could not be sent', { shown, of: total, error: sent.error });
      break;
    }
    shown += 1;
    if (shown % HISTORY_PROGRESS_EVERY === 0 && shown < exchanges.length) console.log(`  ${shown} of ${exchanges.length} shown`);
    await sleep(historySpacingMs());
  }
  const sent = sendToChat(sessionId, finalMessage);
  log('handoff', 'history shown', { shown, of: total, last: sent.ok ? 'sent' : sent.error });
  console.log(shown === exchanges.length
    ? `The cloud chat now shows ${shown} exchange(s) of your conversation.`
    : `The cloud chat shows ${shown} of ${exchanges.length} exchange(s). The rest could not be sent in time.`);
  if (!sent.ok) console.log(`The message that starts the work could not be sent (${sent.error}). Open the chat and send it a message to carry on.`);
}

function claudeVersion() {
  const run = runClaude(['--version'], { encoding: 'utf8', timeout: 5000 });
  return String(run.stdout ?? '').trim().split(' ')[0] || null;
}

const LOGGED_FLAGS = ['dry-run', 'yes', 'no-sync', 'new-chat', 'allow-secrets'];

async function handoff(options) {
  const fullResume = options['full-resume'];
  log('handoff', 'start', {
    version: skyhopVersion(),
    claude: claudeVersion(),
    node: process.version,
    os: `${process.platform} ${os.release()}`,
    mode: fullResume ? `full resume, ${options.mode}` : 'summary',
    flags: LOGGED_FLAGS.filter(flag => options[flag]).join(','),
  });
  const info = repoInfo(process.cwd());
  const brief = loadBrief(options.brief);
  requireSignIn();
  if (!info.remote && !fullResume) {
    throw new SkyhopError('This repository has no remote, so there is nowhere to push the branch.', 'Add a GitHub remote, or drop --summary to use full resume, which uploads directly. A session with no remote cannot push its work back.');
  }

  const transcript = fullResume ? findTranscript(options.session) : null;
  const project = path.basename(info.root);
  const useSync = fullResume && syncEnabled(info, options);
  let earlier = useSync ? readRecord(options.session) : null;
  // A handoff whose chat never confirmed it started has nothing in the cloud to wait
  // for. Its start branch goes, which also closes a chat that did start unseen.
  if (earlier?.sync && !earlier.broughtBackAt && !earlier.cloud) {
    if (info.remote) tryGit(info.root, ['push', '-q', info.remote, '--delete', earlier.sync.runBranch]);
    log('handoff', 'an earlier handoff that never started was cleared', { branch: earlier.sync.runBranch });
    earlier = null;
  }
  if (earlier?.sync && !earlier.broughtBackAt) {
    throw new SkyhopError(
      'This session is still in the cloud from its last handoff, so nothing was changed.',
      'Send any message in this session first, which brings it home, then run /skyhop again.',
    );
  }
  // A session that came home goes back to the chat it used last time, if that
  // chat's relay can switch to a new handoff.
  const reuse = !options['new-chat'] && earlier?.cloud?.reopen ? earlier.cloud : null;
  if (hiddenLaunch() && !useSync) {
    throw new SkyhopError(
      'On Windows, Skyhop can start the cloud session only for a full resume synced through GitHub, so nothing was changed.',
      fullResume ? 'Use a repository with a GitHub remote, and leave out --no-sync.' : 'Run /skyhop without --summary.',
    );
  }
  const remote = fullResume ? remoteControlEntry(transcript.path) : null;
  const memory = fullResume ? handoffMemory(transcript.path, info.root) : null;
  const notes = memory && !memory.tooBig ? memory.files : null;
  const recent = fullResume ? recentConversation(transcript.path) : { section: '', count: 0 };
  const prompt = fullResume ? resumePrompt(project, brief, remote, recent.section) : briefPrompt(brief, project);
  // What the cloud chat replays as real messages. A session going back to its
  // earlier chat only needs what was said on this computer since it came home.
  const exchanges = useSync && options.historyCount > 0
    ? replayHistory(transcript.path, { limit: options.historyCount, since: reuse ? earlier.broughtBackAt : null })
    : [];
  const history = exchanges.length > 0 ? { intro: historyIntro(exchanges.length, Boolean(reuse)), exchanges } : null;
  const branch = chooseBranch(options, info);
  const snapshot = createSnapshot(info, {
    isExcluded: isSensitivePath,
    message: `Skyhop snapshot of ${info.branch ?? info.head.slice(0, 8)}`,
  });
  const pending = pendingCommitCount(info.root, snapshot.sha, info.remote) - (snapshot.created ? 1 : 0);
  const repoSize = fullResume && !useSync ? repoBytes(info.root, snapshot.sha) : 0;
  if (fullResume && !useSync) transcript.compressed = measureUpload(transcript, repoSize);

  printPlan({ info, branch, snapshot, pending, options, transcript, reuse, remote, memory, recent, history });
  log('handoff', 'plan', {
    repo: project,
    remote: info.remote ? 'yes' : 'none',
    sync: fullResume ? (useSync ? 'on' : 'off') : null,
    chat: fullResume ? (reuse ? 'earlier chat' : 'new chat') : null,
    changed: snapshot.files.length,
    unpushed: pending,
    'left-out': snapshot.excluded.length || null,
    transcript: transcript ? `${(transcript.bytes / 1e6).toFixed(1)}MB` : null,
    history: fullResume ? (remote ? 'remote control link' : 'recap only') : null,
    quoted: fullResume ? recent.count : null,
    replayed: fullResume ? exchanges.length : null,
    memory: fullResume ? (memory ? (memory.tooBig ? 'too big' : `${memory.count} note(s)`) : 'off') : null,
  });

  const findings = findSecrets({ info, snapshot, prompt: history ? `${prompt}\n${JSON.stringify(history)}` : prompt, transcript, notes });
  log('handoff', 'secret scan', {
    found: findings.length,
    rules: [...new Set(findings.map(finding => finding.rule))].join(','),
    continued: findings.length > 0 && options['allow-secrets'] ? 'allow-secrets' : null,
  });
  if (findings.length > 0) {
    console.log(`\nLikely secrets found:\n${findings.map(finding => `  ${formatFinding(finding)}`).join('\n')}`);
    if (!options['allow-secrets']) {
      throw new SkyhopError('Stopped because of the likely secrets above. Nothing left this machine.', 'Remove them and run /skyhop again. If they are false alarms, add --allow-secrets.');
    }
    console.log('Continuing because --allow-secrets was set.');
  } else {
    console.log('\nSecret scan: nothing found.');
  }

  if (options['dry-run']) {
    log('handoff', 'dry run, nothing sent');
    const first = reuse ? reconnectPrompt(project, brief, remote, history ? '' : recent.section) : history ? resumePrompt(project, brief, remote, '') : prompt;
    console.log(`\nDry run: nothing was pushed or started.\n\n${history ? `The chat would first show ${history.exchanges.length} exchange(s) as real messages, then get this prompt.\n\n` : ''}--- First prompt ---\n${first}`);
    return 0;
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      log('handoff', 'waiting for confirmation');
      console.log('\nConfirmation needed. Run again with --yes once the user has agreed.');
      return EXIT_NEEDS_CONFIRMATION;
    }
    if (!await confirm()) {
      log('handoff', 'cancelled');
      console.log('Stopped. Nothing was pushed or started.');
      return 0;
    }
  }

  if (!fullResume) {
    pushBranch(info, snapshot.sha, branch);
    log('handoff', 'pushed', { branch });
  }
  const tail = branch.slice('skyhop/'.length);
  // A reused chat keeps its start branch and key, so a cloud machine that has to
  // start again finds the new handoff where it found the first one.
  const startBranch = useSync ? reuse?.runBranch ?? `skyhop-run/${tail}` : branch;
  if (reuse) clearOldStart(info, startBranch);
  const dir = prepareLaunchFolder(info, snapshot.sha, startBranch);
  const env = fullResume && !useSync ? { CCR_FORCE_BUNDLE: '1' } : {};
  const key = useSync ? reuse?.key ?? newKey() : null;
  const firstMessage = key ? `${prompt}\n\n[skyhop-key:${key}]` : prompt;
  const promptFile = savePrompt(options.brief, firstMessage);
  let handoffRecord = null;
  if (fullResume) {
    const sync = useSync
      ? {
        chatRef: `skyhop-sync/${tail}-chat`, codeRef: `skyhop-sync/${tail}-code`, runBranch: startBranch,
        remoteUrl: publicRemoteUrl(info.remoteUrl), snapshotTree: snapshot.tree, finalBranch: branch,
      }
      : null;
    const baseBytes = addRelayCommit(dir, { transcript, sessionId: options.session, mode: options.mode, brief, sync, key, memory: notes, history });
    handoffRecord = {
      sessionId: options.session, repoRoot: info.root, at: new Date().toISOString(), branch, baseBytes,
      head: info.head, snapshotTree: snapshot.tree, sync: sync && { ...sync, key },
      memory: notes && { dir: memory.dir, base: memoryHashes(notes) },
      codeSealed: Boolean(sync),
    };
    saveHandoffRecord(handoffRecord);
    if (useSync) {
      pushBranch(info, git(dir, ['rev-parse', 'HEAD']), startBranch);
      log('handoff', 'pushed', { branch: startBranch });
    }
  }

  const command = pasteCommand(dir, promptFile, env);
  const record = {
    at: new Date().toISOString(),
    repo: redactPaths(info.root),
    branch,
    mode: fullResume ? 'full resume' : 'summary handoff',
    pushed: !fullResume || useSync,
  };
  if (reuse) {
    // The relay only switches to exactly the commit pushed here.
    const pushed = git(dir, ['rev-parse', 'HEAD']);
    const markers = `[skyhop-key:${key}]\n[skyhop-reopen:${startBranch}]\n[skyhop-reopen-commit:${pushed}]`;
    const reconnect = history
      ? `${setupMessage(project)}\n\n${markers}\n${HISTORY_MARK}`
      : `${reconnectPrompt(project, brief, remote, recent.section)}\n\n${markers}`;
    const sent = sendToChat(reuse.sessionId, reconnect);
    log('handoff', sent.ok ? 'sent to the earlier chat' : 'the earlier chat refused it', { chat: reuse.sessionId, error: sent.error });
    if (sent.ok) {
      removeLaunchFolder(info);
      saveHandoffRecord({ ...handoffRecord, cloud: reuse });
      if (history) {
        await showHistory({
          info, sessionId: reuse.sessionId, history, pulse: pulseRef(handoffRecord.sync.chatRef),
          finalMessage: reconnectPrompt(project, brief, remote, ''), fallbackMessage: reconnectPrompt(project, brief, remote, recent.section),
        });
      }
      return reportReconnect({ info, reuse, record, ackBranch: pulseRef(handoffRecord.sync.chatRef) });
    }
    console.log(`\nThis session's earlier cloud chat couldn't take the handoff (${sent.error}), so Skyhop is starting a new chat.`);
  }
  try {
    // The chat that replays the conversation starts with a short setup message, and
    // gets the real first message once the old ones are in.
    // On Windows the chat always starts that way, from a hidden console that can't
    // show the session link, and the first message goes after it.
    const hidden = hiddenLaunch();
    const opening = hidden
      ? `${setupMessage(project, { history: Boolean(history) })} [skyhop-key:${key}] ${HISTORY_MARK}`
      : history ? `${setupMessage(project)}\n\n[skyhop-key:${key}]\n${HISTORY_MARK}` : firstMessage;
    const outcome = hidden
      ? await launchHidden({ dir, prompt: opening, info, pulse: pulseRef(handoffRecord.sync.chatRef) })
      : await launchSession({ dir, prompt: opening, env, ...launchTimes(fullResume && !useSync ? transcript.compressed + repoSize : 0) });
    if (outcome.status !== 'needs-terminal') removeLaunchFolder(info);
    // Nothing started, so nothing is left behind: not the branch, nor a handoff to wait for.
    if (outcome.notStarted && useSync) {
      tryGit(info.root, ['push', '-q', info.remote, '--delete', startBranch]);
      forgetHandoff(options.session);
      log('handoff', 'nothing started, so the pushed branch and the handoff were removed', { branch: startBranch });
    }
    if (useSync && outcome.status === 'started') {
      saveHandoffRecord({ ...handoffRecord, cloud: { sessionId: outcome.sessionId, url: outcome.url, runBranch: startBranch, key, reopen: true } });
      if (history || hidden) {
        console.log(`\nCloud chat: ${outcome.url}`);
        await showHistory({
          info, sessionId: outcome.sessionId, history, pulse: pulseRef(handoffRecord.sync.chatRef),
          finalMessage: resumePrompt(project, brief, remote, ''), fallbackMessage: prompt,
        });
      }
    } else if ((history || hidden) && outcome.status === 'unconfirmed' && !outcome.notStarted) {
      console.log('\nSkyhop could not tell whether the chat started, so it could not show your earlier conversation there. If the chat exists, open it and send any message to carry on.');
    }
    return reportLaunch({ outcome, command, record, synced: useSync });
  } catch (error) {
    if (error instanceof SkyhopError) {
      recordHandoff({ ...record, status: `failed: ${error.message}` });
      const retry = command ? `To retry, run this in your own terminal:\n\n${command}` : 'To retry, run /skyhop again.';
      error.hint = `${error.hint ?? ''}\nThe brief is kept at ${options.brief}. ${retry}`.trim();
    }
    throw error;
  }
}

function currentRepo() {
  try {
    return repoInfo(process.cwd());
  } catch {
    return null;
  }
}

function showStatus({ clean }) {
  const info = currentRepo();
  if (clean) {
    if (!info) throw new SkyhopError('This folder is not inside a git repository.', 'Run /skyhop-status --clean from the repository to tidy.');
    const leftovers = findLeftovers(info, os.homedir());
    if (!leftovers) throw new SkyhopError(`Could not reach ${info.remote}, so nothing was removed.`, 'Check your connection, then try again.');
    if (leftovers.removable.length === 0) {
      console.log('Nothing to remove.');
      return 0;
    }
    const { removed, failed } = removeLeftovers(info, leftovers);
    log('status', 'clean', { removed: removed.length, failed: failed.length || null });
    if (removed.length > 0) console.log(`Removed:\n${removed.map(name => `  ${name}`).join('\n')}`);
    if (failed.length > 0) console.log(`Could not remove:\n${failed.map(name => `  ${name}`).join('\n')}`);
    return failed.length > 0 ? 1 : 0;
  }

  const waiting = waitingRecords(undefined, os.homedir()).filter(record => record.sync);
  if (waiting.length > 0) {
    console.log('In the cloud now. Each comes home when you send it a message on this Mac:');
    for (const record of waiting) console.log(`  ${record.at}  ${path.basename(record.repoRoot)}  session ${record.sessionId}`);
    console.log('');
  }
  const history = readHistory().slice(-STATUS_LIMIT).reverse();
  if (history.length === 0) {
    console.log('No handoffs yet.');
  } else {
    console.log(`Last ${history.length} handoff(s), newest first. Open a link to see live progress.\n`);
    for (const entry of history) {
      console.log(`${entry.at}  ${entry.mode}  ${entry.status}\n  ${entry.repo}  ${entry.branch}\n  ${entry.url ?? 'no link recorded'}\n`);
    }
  }
  if (info?.remote) console.log(formatLeftovers(info, findLeftovers(info, os.homedir())));
  if (fs.existsSync(logDir())) console.log(`\nIf something went wrong, Skyhop's logs are in ~/.skyhop/logs/. They hold steps and errors, not your conversation, so you can attach them to a bug report.`);
  return 0;
}

async function main() {
  privateHome();
  const options = readOptions(process.argv.slice(2));
  if (options.back) return bringBack({ session: options.session, dryRun: options['dry-run'] });
  return options.status || options.clean ? showStatus(options) : handoff(options);
}

const COMMAND = ['--back', '--clean', '--status'].find(flag => process.argv.includes(flag))?.slice(2) ?? 'handoff';

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof SkyhopError)) {
    log(COMMAND, 'crash', { error: String(error.stack ?? error).split('\n').slice(0, 4).join(' | ') });
    throw error;
  }
  log(COMMAND, 'stopped', { error: error.message });
  console.error(`\nSkyhop: ${error.message}${error.hint ? `\n${error.hint}` : ''}`);
  process.exitCode = 1;
}
