#!/usr/bin/env node
// Main entry point for /skyhop and /skyhop-status.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { bringBack, saveHandoffRecord, waitingRecords } from './back.mjs';
import { briefPrompt, loadBrief, redactPaths, resumePrompt } from './brief.mjs';
import { launchSession, launchTimes, pasteCommand, readHistory, recordHandoff, requireSignIn } from './cloud.mjs';
import { addRelayCommit, findTranscript, LARGE_TRANSCRIPT_BYTES, measureUpload } from './fullresume.mjs';
import {
  createSnapshot, git, maskUrl, pendingCommitCount, pendingDiff, prepareLaunchFolder, publicRemoteUrl,
  pushBranch, removeLaunchFolder, repoBytes, repoInfo, skyhopBranch, SkyhopError, snapshotStat,
} from './git.mjs';
import { findLeftovers, formatLeftovers, removeLeftovers } from './leftovers.mjs';
import { formatFinding, isSensitivePath, scanDiff, scanText } from './secrets.mjs';
import { newKey } from './sync.mjs';

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
      },
    }).values;
  } catch (error) {
    throw new SkyhopError(error.message, 'Flags are --summary, --name, --dry-run, --yes, --mode, --no-sync and --allow-secrets.');
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

function printPlan({ info, branch, snapshot, pending, options, transcript }) {
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
          `  Sync:       after each reply, the cloud session pushes your code and the encrypted conversation to skyhop-sync branches on ${info.remote}, for /skyhop-back`,
        ]
        : [
          `  Upload:     the snapshot, possibly your other local branches, and the full session transcript (${(transcript.bytes / 1e6).toFixed(1)} MB, about ${(transcript.compressed / 1e6).toFixed(1)} MB compressed), sent directly to the session`,
          '              The transcript holds everything Claude read and ran, including private paths.',
          '  Sync:       off, so /skyhop-back will have nothing to bring home',
        ]),
    );
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

function findSecrets({ info, snapshot, prompt, transcript }) {
  return [
    ...scanDiff(pendingDiff(info.root, snapshot.sha, info.remote)),
    ...scanText(prompt, { source: 'brief' }),
    ...(transcript ? scanText(fs.readFileSync(transcript.path, 'utf8'), { source: 'session transcript', strict: true }) : []),
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
  return file;
}

const COMING_HOME = 'Quit this window now (type /exit). When you are back, open claude in this folder and pick this session in /resume: it will have the cloud conversation, and it comes home for good when you send a message.';

function reportLaunch({ outcome, command, record, synced }) {
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

async function handoff(options) {
  const fullResume = options['full-resume'];
  const info = repoInfo(process.cwd());
  const brief = loadBrief(options.brief);
  requireSignIn();
  if (!info.remote && !fullResume) {
    throw new SkyhopError('This repository has no remote, so there is nowhere to push the branch.', 'Add a GitHub remote, or drop --summary to use full resume, which uploads directly. A session with no remote cannot push its work back.');
  }

  const transcript = fullResume ? findTranscript(options.session) : null;
  const project = path.basename(info.root);
  const useSync = fullResume && syncEnabled(info, options);
  const prompt = fullResume ? resumePrompt(project, brief) : briefPrompt(brief, project);
  const branch = chooseBranch(options, info);
  const snapshot = createSnapshot(info, {
    isExcluded: isSensitivePath,
    message: `Skyhop snapshot of ${info.branch ?? info.head.slice(0, 8)}`,
  });
  const pending = pendingCommitCount(info.root, snapshot.sha, info.remote) - (snapshot.created ? 1 : 0);
  const repoSize = fullResume && !useSync ? repoBytes(info.root, snapshot.sha) : 0;
  if (fullResume && !useSync) transcript.compressed = measureUpload(transcript, repoSize);

  printPlan({ info, branch, snapshot, pending, options, transcript });

  const findings = findSecrets({ info, snapshot, prompt, transcript });
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
    console.log(`\nDry run: nothing was pushed or started.\n\n--- First prompt ---\n${prompt}`);
    return 0;
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.log('\nConfirmation needed. Run again with --yes once the user has agreed.');
      return EXIT_NEEDS_CONFIRMATION;
    }
    if (!await confirm()) {
      console.log('Stopped. Nothing was pushed or started.');
      return 0;
    }
  }

  if (!fullResume) pushBranch(info, snapshot.sha, branch);
  const tail = branch.slice('skyhop/'.length);
  const startBranch = useSync ? `skyhop-run/${tail}` : branch;
  const dir = prepareLaunchFolder(info, snapshot.sha, startBranch);
  const env = fullResume && !useSync ? { CCR_FORCE_BUNDLE: '1' } : {};
  const key = useSync ? newKey() : null;
  const firstMessage = key ? `${prompt}\n\n[skyhop-key:${key}]` : prompt;
  const promptFile = savePrompt(options.brief, firstMessage);
  if (fullResume) {
    const sync = useSync
      ? {
        chatRef: `skyhop-sync/${tail}-chat`, codeRef: `skyhop-sync/${tail}-code`, runBranch: startBranch,
        remoteUrl: publicRemoteUrl(info.remoteUrl), snapshotTree: snapshot.tree, finalBranch: branch,
      }
      : null;
    const baseBytes = addRelayCommit(dir, { transcript, sessionId: options.session, mode: options.mode, brief, sync, key });
    saveHandoffRecord({
      sessionId: options.session, repoRoot: info.root, at: new Date().toISOString(), branch, baseBytes,
      head: info.head, snapshotTree: snapshot.tree, sync: sync && { ...sync, key },
    });
    if (useSync) pushBranch(info, git(dir, ['rev-parse', 'HEAD']), startBranch);
  }

  const command = pasteCommand(dir, promptFile, env);
  const record = {
    at: new Date().toISOString(),
    repo: redactPaths(info.root),
    branch,
    mode: fullResume ? 'full resume' : 'summary handoff',
    pushed: !fullResume || useSync,
  };
  try {
    const outcome = await launchSession({ dir, prompt: firstMessage, env, ...launchTimes(fullResume && !useSync ? transcript.compressed + repoSize : 0) });
    if (outcome.status !== 'needs-terminal') removeLaunchFolder(info);
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
  return 0;
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (options.back) return bringBack({ session: options.session, dryRun: options['dry-run'] });
  return options.status || options.clean ? showStatus(options) : handoff(options);
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof SkyhopError)) throw error;
  console.error(`\nSkyhop: ${error.message}${error.hint ? `\n${error.hint}` : ''}`);
  process.exitCode = 1;
}
