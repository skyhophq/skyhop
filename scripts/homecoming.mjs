// Plugin hooks that bring a session home from the cloud. "start" runs when Claude
// Code starts or opens a session, and "prompt" runs on each message. Both return at
// once unless a handoff is waiting, and neither ever stops Claude Code by failing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const event = process.argv[2];
const home = os.homedir();
const pid = process.env.CLAUDE_PID ?? String(process.ppid);

function print(output) {
  if (output) process.stdout.write(JSON.stringify(output));
}

async function main() {
  // Inside a cloud VM, or the relay's own resumed session, there is nothing to bring home.
  if (process.env.CLAUDE_CODE_REMOTE === 'true' || process.env.SKYHOP_INNER) return;
  if (!fs.existsSync(path.join(home, '.skyhop', 'sessions'))) return;
  const { privateHome } = await import('./log.mjs');
  privateHome(home);

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { source, session_id: sessionId, cwd } = JSON.parse(input);

  if (event === 'prompt') {
    if (!fs.existsSync(path.join(home, '.skyhop', 'sessions', `${sessionId}.json`))) return;
    const { claim } = await import('./back.mjs');
    print(claim({ sessionId, pid, home }));
    return;
  }

  if (event === 'start' && source === 'resume') {
    if (!fs.existsSync(path.join(home, '.skyhop', 'sessions', `${sessionId}.json`))) return;
    const { onResume } = await import('./back.mjs');
    const line = onResume({ sessionId, pid, home });
    if (line) print({ systemMessage: line });
    return;
  }

  // Scripted runs (claude -p) start without a person to pick a session, so they skip this.
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (event === 'start' && source === 'startup' && (!entrypoint || entrypoint === 'cli')) {
    const { pullAll } = await import('./back.mjs');
    const lines = pullAll({ cwd, home });
    if (lines.length > 0) print({ systemMessage: lines.join('\n') });
  }
}

try {
  await main();
} catch (error) {
  try {
    const { log } = await import('./log.mjs');
    log('hook', 'error', { event, error: error.message });
  } catch {
    // the message below still reaches the user
  }
  print({ systemMessage: `Skyhop hook error: ${error.message}` });
}
