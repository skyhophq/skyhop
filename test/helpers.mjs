import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skyhop-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function run(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function write(root, file, content) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// A repo with one commit, plus a bare repo as its remote.
export function makeRepo(t, { remote = true } = {}) {
  const base = tempDir(t);
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.name', 'Test');
  run(root, 'config', 'user.email', 'test@example.invalid');
  write(root, '.gitignore', 'ignored.txt\n');
  write(root, 'tracked.txt', 'original\n');
  write(root, 'staged.txt', 'original\n');
  run(root, 'add', '-A');
  run(root, 'commit', '-q', '-m', 'first');
  let bare = null;
  if (remote) {
    bare = path.join(base, 'remote.git');
    run(base, 'init', '-q', '--bare', '-b', 'main', bare);
    run(root, 'remote', 'add', 'origin', bare);
    run(root, 'push', '-q', '-u', 'origin', 'main');
  }
  return { base, root, bare };
}

// Adds the kinds of change a real session leaves behind.
export function dirty(root) {
  write(root, 'tracked.txt', 'changed\n');
  write(root, 'staged.txt', 'staged change\n');
  run(root, 'add', 'staged.txt');
  write(root, 'new-file.txt', 'untracked\n');
  write(root, 'ignored.txt', 'ignored\n');
  write(root, '.env', 'NAME=value\n');
}

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Everything the handoff promises to leave exactly as it found it.
export function fingerprint(root) {
  const files = run(root, 'ls-files', '-co').split('\n').filter(Boolean).sort();
  return {
    head: run(root, 'rev-parse', 'HEAD'),
    branch: run(root, 'symbolic-ref', '--short', 'HEAD'),
    refs: run(root, 'for-each-ref', '--format=%(refname) %(objectname)'),
    index: hash(path.join(root, '.git/index')),
    status: execFileSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
    files: Object.fromEntries(files.map(file => [file, hash(path.join(root, file))])),
  };
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A stand-in for the relay's background runner that keeps going until it is stopped.
// Like the real one, it leads its own process group and has no parent waiting on it.
export function sleeper(t) {
  const launch = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)";
  const pid = Number(spawnSync(process.execPath, ['-e', launch], { encoding: 'utf8' }).stdout.trim());
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  });
  return pid;
}

// The same boot ID the relay records, so a planted job counts as this boot's.
export function bootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return null;
  }
}
