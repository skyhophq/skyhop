// SessionEnd hook: reminds the user to run /skyhop when work is uncommitted. It
// only reminds. `--cloud` needs a terminal, so it cannot start a handoff from here.
import { spawnSync } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;

let cwd;
try {
  ({ cwd } = JSON.parse(input));
} catch {
  process.exit(0);
}

const status = spawnSync('git', ['--no-optional-locks', 'status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 1000 });
if (status.status === 0 && status.stdout.trim()) {
  console.error('Skyhop: this repo has uncommitted work. Run claude --continue, then /skyhop, to hand it off to the cloud.');
  process.exit(2);
}
