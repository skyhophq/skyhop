// What earlier handoffs left in a repository, for /skyhop-status. Only Skyhop's own
// branches are looked at, and a branch holding work that exists nowhere else is
// never removed.
import { waitingRecords } from './back.mjs';
import { tryGit } from './git.mjs';

const SKYHOP_REMOTE = /^skyhop(-run|-sync)?\//;
const PLUMBING = /^skyhop-(run|sync)\//;

// True when some branch that isn't Skyhop's already has this commit.
function savedElsewhere(root, sha) {
  if (tryGit(root, ['cat-file', '-e', `${sha}^{commit}`]) === null) return false;
  const refs = tryGit(root, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']) ?? '';
  return refs.split('\n').some(ref => ref && !/\/skyhop(-run|-sync)?\//.test(ref) && !ref.endsWith('/HEAD'));
}

export function findLeftovers(info, home) {
  const active = waitingRecords(info.root, home).filter(record => record.sync).flatMap(record => [
    record.sync.runBranch, record.sync.chatRef.replace(/-chat$/, '-'),
  ]);
  const isActive = name => active.some(item => name === item || (item.endsWith('-') && name.startsWith(item)));

  const listed = info.remote ? tryGit(info.root, ['ls-remote', '--heads', info.remote]) : '';
  if (listed === null) return null;
  const remote = listed.split('\n').filter(Boolean)
    .map(line => {
      const [sha, ref] = line.split('\t');
      return { name: ref.replace(/^refs\/heads\//, ''), sha, where: 'remote' };
    })
    .filter(item => SKYHOP_REMOTE.test(item.name) && !isActive(item.name));
  const local = (tryGit(info.root, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/skyhop/back-*']) ?? '')
    .split('\n').filter(Boolean)
    .map(line => {
      const [name, sha] = line.split(' ');
      return { name, sha, where: 'local' };
    })
    .filter(item => item.name !== info.branch);

  const removable = [];
  const kept = [];
  for (const item of [...remote, ...local]) {
    // The run and sync branches are Skyhop's encrypted copies, from handoffs that are over.
    if (item.where === 'remote' && PLUMBING.test(item.name)) removable.push({ ...item, why: "Skyhop's copy from a finished handoff" });
    else if (savedElsewhere(info.root, item.sha)) removable.push({ ...item, why: 'its work is already on another branch' });
    else kept.push({ ...item, why: 'it has work that is not on any other branch here' });
  }
  return { removable, kept };
}

export function formatLeftovers(info, leftovers) {
  if (!leftovers) return `\nCould not reach ${info.remote} to check for leftover branches.`;
  const { removable, kept } = leftovers;
  if (removable.length === 0 && kept.length === 0) return '\nNo leftover Skyhop branches in this repository.';
  const show = item => `    ${item.where === 'remote' ? `${info.remote}/` : ''}${item.name}  (${item.why})`;
  const lines = ['\nLeftover Skyhop branches in this repository:'];
  if (removable.length > 0) lines.push('  Safe to remove, nothing is lost:', ...removable.map(show));
  if (kept.length > 0) lines.push('  Kept:', ...kept.map(show));
  if (removable.length > 0) lines.push('\nTo remove the safe ones, run /skyhop-status --clean.');
  return lines.join('\n');
}

// One request for the remote branches and one command for the local ones.
export function removeLeftovers(info, leftovers) {
  const remote = leftovers.removable.filter(item => item.where === 'remote').map(item => item.name);
  const local = leftovers.removable.filter(item => item.where === 'local').map(item => item.name);
  const failed = [];
  if (remote.length > 0 && tryGit(info.root, ['push', '-q', info.remote, '--delete', ...remote]) === null) failed.push(...remote);
  if (local.length > 0 && tryGit(info.root, ['branch', '-q', '-D', ...local]) === null) failed.push(...local);
  return { removed: [...remote, ...local].filter(name => !failed.includes(name)), failed };
}
