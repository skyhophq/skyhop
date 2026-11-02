// Git helpers. Nothing here touches the user's working tree, index or branches.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT = 512 * 1024 * 1024;
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

export class SkyhopError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

// --no-optional-locks stops read commands from refreshing the user's index.
function runGit(cwd, args, { env, input } = {}) {
  const run = spawnSync('git', ['--no-optional-locks', ...args], {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, ...env },
  });
  if (run.error?.code === 'ENOBUFS') {
    throw new SkyhopError('This repository has too much unpushed history to scan.', 'Push your existing work first, then run /skyhop again.');
  }
  if (run.error) throw new SkyhopError(`Could not run git: ${run.error.message}`, 'Check that git is installed.');
  return run;
}

export function git(cwd, args, options) {
  const run = runGit(cwd, args, options);
  if (run.status !== 0) throw new SkyhopError(`git ${args.find(a => !a.startsWith('-'))} failed: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

export function tryGit(cwd, args, options) {
  const run = runGit(cwd, args, options);
  return run.status === 0 ? run.stdout.trim() : null;
}

function detectRemote(root, branch) {
  const tracked = branch && tryGit(root, ['config', '--get', `branch.${branch}.remote`]);
  if (tracked && tracked !== '.') return tracked;
  const remotes = (tryGit(root, ['remote']) ?? '').split('\n').filter(Boolean);
  return remotes.includes('origin') ? 'origin' : remotes[0] ?? null;
}

export function repoInfo(cwd) {
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new SkyhopError('This folder is not inside a git repository.', 'Run /skyhop from a git repository.');
  const head = tryGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head) throw new SkyhopError('This repository has no commits yet.', 'Make a first commit, then run /skyhop again.');
  const branch = tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const remote = detectRemote(root, branch);
  const remoteUrl = remote ? tryGit(root, ['remote', 'get-url', remote]) : null;
  return { root, head, branch, remote, remoteUrl };
}

export function maskUrl(url) {
  return url?.replace(/\/\/[^@/]+@/, '//') ?? null;
}

// A URL for the VM to reach GitHub with, without any credentials from this Mac.
export function publicRemoteUrl(url) {
  const ssh = url?.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : maskUrl(url);
}

export function skyhopBranch(name, date = new Date()) {
  const clean = (name || 'session').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '') || 'session';
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `skyhop/${clean}-${stamp}`;
}

function identityEnv(root) {
  const name = tryGit(root, ['config', 'user.name']) || 'Skyhop';
  const email = tryGit(root, ['config', 'user.email']) || 'skyhop@localhost';
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

function listPaths(root, args, env) {
  return runGit(root, args, { env }).stdout.split('\0').filter(Boolean);
}

// Builds a commit of the working tree in a throwaway index. The commit has no ref
// until it is pushed, so the user's branches are untouched. Files that
// isExcluded matches keep their committed version.
export function createSnapshot(info, { isExcluded = () => false, message }) {
  const { root, head } = info;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skyhop-'));
  const indexFile = path.join(tmp, 'index');
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    const realIndex = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']));
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, indexFile);
    else git(root, ['read-tree', 'HEAD'], { env });

    git(root, ['add', '-A', '--', ':/'], { env });
    const changed = listPaths(root, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD'], env);
    const excluded = changed.filter(isExcluded);
    if (excluded.length > 0) {
      git(root, ['--literal-pathspecs', 'reset', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], { env, input: excluded.join('\0') });
    }

    const tree = git(root, ['write-tree'], { env });
    const unchanged = tree === git(root, ['rev-parse', 'HEAD^{tree}']);
    const sha = unchanged ? head : git(root, ['commit-tree', tree, '-p', head, '-m', message], { env: identityEnv(root) });
    return { sha, tree, created: !unchanged, excluded, files: changed.filter(file => !excluded.includes(file)) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Claude Code's docs say a direct upload includes every branch, so all of them count.
function pendingRange(sha, remote) {
  const refs = [sha, '--branches', '--tags'];
  return remote ? [...refs, '--not', `--remotes=${remote}`] : refs;
}

// Every commit the handoff could carry that the remote does not already have.
export function pendingDiff(root, sha, remote) {
  return runGit(root, [
    'log', '-p', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--diff-merges=first-parent', '--format=commit:%H', ...pendingRange(sha, remote),
  ]).stdout;
}

export function pendingCommitCount(root, sha, remote) {
  return Number(tryGit(root, ['rev-list', '--count', ...pendingRange(sha, remote)]) ?? 0);
}

export function repoBytes(root, sha) {
  return Number(tryGit(root, ['rev-list', '--objects', '--disk-usage', '--branches', sha]) ?? 0);
}

export function snapshotStat(root, head, sha) {
  return head === sha ? '' : git(root, ['diff', '--stat=80', head, sha]);
}

export function pushBranch(info, sha, branch) {
  const run = runGit(info.root, ['push', info.remote, `${sha}:refs/heads/${branch}`]);
  if (run.status === 0) return;
  const output = run.stderr.trim();
  const noAccess = /permission denied|authentication failed|could not read username|repository not found|could not read from remote/i.test(output);
  throw new SkyhopError(
    `Push to ${info.remote} failed:\n${output}`,
    noAccess
      ? 'Check that you can push to this remote (for GitHub, run `gh auth status`), then run /skyhop again. Nothing was started.'
      : 'The remote rejected the branch. Fix what the message above describes, then run /skyhop again. Nothing was started.',
  );
}

export function launchDir(root, home = os.homedir()) {
  const name = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, '-');
  const id = crypto.createHash('sha1').update(root).digest('hex').slice(0, 10);
  return path.join(home, '.skyhop', 'launch', `${name}-${id}`);
}

function launchBranch(root, dir) {
  const real = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
  const entry = runGit(root, ['worktree', 'list', '--porcelain']).stdout
    .split('\n\n')
    .find(block => block.startsWith(`worktree ${real}\n`));
  return entry?.match(/^branch (refs\/heads\/skyhop(?:-run)?\/.+)$/m)?.[1] ?? null;
}

export function removeLaunchFolder(info) {
  const dir = launchDir(info.root);
  const branch = launchBranch(info.root, dir);
  tryGit(info.root, ['worktree', 'remove', '--force', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  git(info.root, ['worktree', 'prune']);
  if (branch) tryGit(info.root, ['update-ref', '-d', branch]);
}

// --cloud uses the current branch, so it runs from a linked worktree on the
// snapshot branch. A worktree shares its main repo's workspace trust, so the trust
// prompt doesn't appear, and the user's own checkout is never switched.
export function prepareLaunchFolder(info, sha, branch) {
  removeLaunchFolder(info);
  const dir = launchDir(info.root);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(info.root, [...NO_HOOKS, 'worktree', 'add', '-q', '-b', branch, dir, sha]);
  return dir;
}
