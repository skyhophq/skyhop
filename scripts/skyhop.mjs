#!/usr/bin/env node
// Main entry point for /skyhop and /skyhop-status.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import {
  bringBack, readRecord, remoteControlEntry, saveHandoffRecord, waitingRecords,
} from './back.mjs';
import { briefPrompt, loadBrief, reconnectPrompt, redactPaths, resumePrompt } from './brief.mjs';
import {
  launchSession, launchTimes, pasteCommand, readHistory, recordHandoff, reopenWaitMs, requireSignIn, sendToChat, waitForBranch,
} from './cloud.mjs';
import { addRelayCommit, findTranscript, LARGE_TRANSCRIPT_BYTES, measureUpload } from './fullresume.mjs';
import { MAX_MEMORY_BYTES, memoryDir, memoryEnabled, memoryHashes, readMemory } from './memory.mjs';
import { recentConversation } from './conversation.mjs';
import {
  createSnapshot, git, maskUrl, pendingCommitCount, pendingDiff, prepareLaunchFolder, publicRemoteUrl,
  pushBranch, removeLaunchFolder, repoBytes, repoInfo, skyhopBranch, SkyhopError, snapshotStat, tryGit,
} from './git.mjs';
import { findLeftovers, formatLeftovers, removeLeftovers } from './leftovers.mjs';
import { log, logDir, privateFile, privateHome, skyhopVersion } from './log.mjs';
import { formatFinding, isSensitivePath, scanDiff, scanText } from './secrets.mjs';
import { newKey, pulseRef } from './sync.mjs';

const MODES = ['auto', 'acceptEdits', 'plan'];
const EXIT_NEEDS_CONFIRMATION = 2;
const EXIT_NEEDS_TERMINAL = 3;
const STATUS_LIMIT = 10;
const STAMP_LENGTH = '20261102-154402'.length;

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
      },
    }).values;
  } catch (error) {
    throw new SkyhopError(error.message, 'Flags are --summary, --name, --dry-run, --yes, --mode, --no-sync, --new-chat and --allow-secrets.');
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

function printPlan({ info, branch, snapshot, pending, options, transcript, reuse, remote, memory, recent }) {
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
    const quoted = recent.count > 0 ? `quotes your last ${recent.count} message(s) word for word` : 'starts with a recap';
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
  log('handoff', 'launch', { result: outcome.status, reason: outcome.reason, chat: outcome.sessionId });
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
  recordHandoff({ ...record, status: 'unconfirmed' });
  console.log(`\nThe launch finished without showing a session link. Check https://claude.ai/code for a new session on ${record.branch}.\nIf there is none, run this in your own terminal:\n\n${command}`);
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

function claudeVersion() {
  const run = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
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
  const earlier = useSync ? readRecord(options.session) : null;
  if (earlier?.sync && !earlier.broughtBackAt) {
    throw new SkyhopError(
      'This session is still in the cloud from its last handoff, so nothing was changed.',
      'Send any message in this session first, which brings it home, then run /skyhop again.',
    );
  }
  // A session that came home goes back to the chat it used last time, if that
  // chat's relay can switch to a new handoff.
  const reuse = !options['new-chat'] && earlier?.cloud?.reopen ? earlier.cloud : null;
  const remote = fullResume ? remoteControlEntry(transcript.path) : null;
  const memory = fullResume ? handoffMemory(transcript.path, info.root) : null;
  const notes = memory && !memory.tooBig ? memory.files : null;
  const recent = fullResume ? recentConversation(transcript.path) : { section: '', count: 0 };
  const prompt = fullResume ? resumePrompt(project, brief, remote, recent.section) : briefPrompt(brief, project);
  const branch = chooseBranch(options, info);
  const snapshot = createSnapshot(info, {
    isExcluded: isSensitivePath,
    message: `Skyhop snapshot of ${info.branch ?? info.head.slice(0, 8)}`,
  });
  const pending = pendingCommitCount(info.root, snapshot.sha, info.remote) - (snapshot.created ? 1 : 0);
  const repoSize = fullResume && !useSync ? repoBytes(info.root, snapshot.sha) : 0;
  if (fullResume && !useSync) transcript.compressed = measureUpload(transcript, repoSize);

  printPlan({ info, branch, snapshot, pending, options, transcript, reuse, remote, memory, recent });
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
    memory: fullResume ? (memory ? (memory.tooBig ? 'too big' : `${memory.count} note(s)`) : 'off') : null,
  });

  const findings = findSecrets({ info, snapshot, prompt, transcript, notes });
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
    console.log(`\nDry run: nothing was pushed or started.\n\n--- First prompt ---\n${reuse ? reconnectPrompt(project, brief, remote, recent.section) : prompt}`);
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
    const baseBytes = addRelayCommit(dir, { transcript, sessionId: options.session, mode: options.mode, brief, sync, key, memory: notes });
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
    const reconnect = `${reconnectPrompt(project, brief, remote, recent.section)}\n\n[skyhop-key:${key}]\n[skyhop-reopen:${startBranch}]\n[skyhop-reopen-commit:${pushed}]`;
    const sent = sendToChat(reuse.sessionId, reconnect);
    log('handoff', sent.ok ? 'sent to the earlier chat' : 'the earlier chat refused it', { chat: reuse.sessionId, error: sent.error });
    if (sent.ok) {
      removeLaunchFolder(info);
      saveHandoffRecord({ ...handoffRecord, cloud: reuse });
      return reportReconnect({ info, reuse, record, ackBranch: pulseRef(handoffRecord.sync.chatRef) });
    }
    console.log(`\nThis session's earlier cloud chat couldn't take the handoff (${sent.error}), so Skyhop is starting a new chat.`);
  }
  try {
    const outcome = await launchSession({ dir, prompt: firstMessage, env, ...launchTimes(fullResume && !useSync ? transcript.compressed + repoSize : 0) });
    if (outcome.status !== 'needs-terminal') removeLaunchFolder(info);
    if (useSync && outcome.status === 'started') {
      saveHandoffRecord({ ...handoffRecord, cloud: { sessionId: outcome.sessionId, url: outcome.url, runBranch: startBranch, key, reopen: true } });
    }
    return reportLaunch({ outcome, command, record, synced: useSync });
  } catch (error) {
    if (error instanceof SkyhopError) {
      recordHandoff({ ...record, status: `failed: ${error.message}` });
      error.hint = `${error.hint ?? ''}\nThe brief is kept at ${options.brief}. To retry, run this in your own terminal:\n\n${command}`.trim();
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
