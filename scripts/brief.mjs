// Turns the brief Claude wrote into the first prompt of the cloud session.
import fs from 'node:fs';
import os from 'node:os';
import { SkyhopError } from './git.mjs';

// Linux limits a single argument to 128 KB.
export const MAX_PROMPT_BYTES = 100 * 1024;

const RECENT_HEADING = /^#{1,6}\s*\**Recent conversation\b.*$/im;
const TRIM_NOTE = '(Older turns were left out to fit the prompt limit.)';

const BRIEF_INTRO = 'This session continues work started in a local Claude Code session and handed off with Skyhop. The code on this branch includes the uncommitted local work. Use the brief below as your context. Act only on Remaining work. Anything under Recent conversation is background, so do not redo those requests. Confirm the plan before large changes.';

const RESUME_MESSAGE = 'Skyhop has moved you to a cloud VM, and this conversation continues from here. The repository is in the current directory and includes the uncommitted local work. Paths from earlier in this conversation may no longer exist, and local services, gitignored files and local MCP servers are not available here. Continue with the remaining work from where we left off. Confirm the plan before large changes.';

export function redactPaths(text, home = os.homedir()) {
  return text
    .replaceAll(home, '~')
    .replace(/(?:\/Users|\/home)\/[^/\s"'`)]+/g, '~');
}

export function loadBrief(file) {
  if (!file) throw new SkyhopError('No brief was given.', 'Run this through /skyhop, which writes the brief first.');
  if (!fs.existsSync(file)) throw new SkyhopError(`The brief file was not found: ${file}`, 'Run /skyhop again so Claude can write it.');
  const brief = redactPaths(fs.readFileSync(file, 'utf8')).trim();
  if (!brief) throw new SkyhopError('The brief is empty.', 'Run /skyhop again so Claude can write it.');
  return brief;
}

// Keeps the newest turns, because the end of the conversation matters most.
export function fitPrompt(prompt, limit = MAX_PROMPT_BYTES) {
  const excess = Buffer.byteLength(prompt) - limit;
  if (excess <= 0) return prompt;

  const heading = prompt.match(RECENT_HEADING);
  if (heading) {
    const bodyStart = heading.index + heading[0].length;
    const body = prompt.slice(bodyStart);
    const kept = Buffer.from(body).subarray(excess + Buffer.byteLength(TRIM_NOTE) + 4).toString('utf8').replace(/^�+/, '');
    const fitted = `${prompt.slice(0, bodyStart)}\n\n${TRIM_NOTE}\n\n${kept}`;
    if (kept.length > 0 && Buffer.byteLength(fitted) <= limit) return fitted;
  }
  throw new SkyhopError(`The brief is too long, at ${Buffer.byteLength(prompt)} bytes.`, `Shorten it to under ${limit} bytes, then run /skyhop again.`);
}

// Starting with the project name steers the title Claude generates for the session.
export function briefPrompt(brief, project) {
  const intro = project ? `Project ${project}. ${BRIEF_INTRO}` : BRIEF_INTRO;
  return fitPrompt(`${intro}\n\n${brief}`);
}

export function resumeMessage(project) {
  return project ? `Project ${project}. ${RESUME_MESSAGE}` : RESUME_MESSAGE;
}

export const RECAP_START = '--- Where we left off (a recap for you to read. The session already has its full history) ---';
export const RECAP_END = '--- End of recap ---';

// The first message of the cloud chat: the instruction for the resumed session,
// then a recap the user can read, since the chat can't show the old messages.
export function resumePrompt(project, brief) {
  return fitPrompt(`${resumeMessage(project)}\n\n${RECAP_START}\n\n${brief}\n\n${RECAP_END}`);
}
