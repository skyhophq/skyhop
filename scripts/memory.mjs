// Claude Code's own notes about a project (auto memory) travel with a full-resume
// session: up with the handoff, encrypted like the transcript, and back with the
// cloud's saves. Cloud sessions run with auto memory off, so the relay hands the
// notes to the resumed session itself and tells it how to keep them.
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAX_MEMORY_BYTES = 1024 * 1024;
// Claude Code loads this much of MEMORY.md into each session.
const INDEX_LINES = 200;
const INDEX_BYTES = 25 * 1024;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function expandHome(dir, home) {
  if (typeof dir !== 'string') return null;
  if (dir.startsWith('~/')) return path.join(home, dir.slice(2));
  return path.isAbsolute(dir) ? dir : null;
}

// Whether the user has auto memory on, so the cloud session never gets it otherwise.
// Turning it off anywhere counts, so a repository's settings can't turn it back on.
export function memoryEnabled({ root, home = os.homedir(), env = process.env }) {
  if (/^(1|true|yes)$/i.test(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '')) return false;
  return ![
    path.join(root, '.claude/settings.local.json'),
    path.join(root, '.claude/settings.json'),
    path.join(home, '.claude/settings.json'),
  ].some(file => readJson(file)?.autoMemoryEnabled === false);
}

// The folder Claude Code uses for this project's notes on this Mac: the
// autoMemoryDirectory setting if one is set, otherwise memory/ next to the session's
// transcript. A session started in a subfolder or a linked worktree keeps its notes
// under the main checkout's folder, so that's tried before giving up on an existing one.
// Only the user's own settings can move the folder: a repository's settings could
// otherwise point Skyhop at any folder, such as ~/.ssh, and have notes written there.
export function memoryDir({ transcriptPath, root, home = os.homedir() }) {
  const custom = expandHome(readJson(path.join(home, '.claude/settings.json'))?.autoMemoryDirectory, home);
  if (custom) return custom;
  const beside = path.join(path.dirname(transcriptPath), 'memory');
  if (fs.existsSync(beside)) return beside;
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' });
  const main = common.status === 0 ? path.dirname(common.stdout.trim()) : root;
  const shared = path.join(home, '.claude/projects', main.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  return fs.existsSync(shared) ? shared : beside;
}

// Notes are markdown files directly in the folder, as Claude Code keeps them. A name
// from the cloud or from disk that could reach anywhere else is refused.
function safeName(name) {
  return typeof name === 'string' && /^[^/\\\0]+\.md$/i.test(name) && name !== '..' && !name.startsWith('.') ? name : null;
}

// Every note in the folder, as { 'MEMORY.md': text, ... }. Links, folders and other
// files are skipped. `bytes` is their total size.
export function readMemory(dir) {
  const files = {};
  let bytes = 0;
  let entries = [];
  try {
    entries = dir ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  } catch {
    // no notes yet
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !safeName(entry.name)) continue;
    const text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    files[entry.name] = text;
    bytes += Buffer.byteLength(text);
  }
  return { files, bytes };
}

export function packMemory(files) {
  return Buffer.from(JSON.stringify({ version: 1, files }));
}

export function unpackMemory(bytes) {
  const data = JSON.parse(bytes.toString('utf8'));
  if (!data || typeof data.files !== 'object' || Array.isArray(data.files)) throw new Error('memory notes are damaged');
  const files = {};
  for (const [name, text] of Object.entries(data.files)) {
    const safe = safeName(name);
    if (!safe || typeof text !== 'string') throw new Error('memory notes are damaged');
    files[safe] = text;
  }
  return files;
}

const hash = text => crypto.createHash('sha256').update(text).digest('hex');

export function memoryHashes(files) {
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, hash(text)]));
}

// Never through a link, which could point anywhere. Returns whether it wrote.
function writeNote(dir, name, text) {
  const file = path.join(dir, name);
  try {
    if (!fs.lstatSync(file).isFile()) return false;
  } catch {
    // a new note
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

// Puts the notes in a fresh folder on the cloud machine.
export function placeMemory(dir, files) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeNote(dir, name, text);
}

// What the resumed session is told on the cloud machine, where Claude Code doesn't
// load the notes itself. It mirrors what Claude Code does: the start of the index,
// and how to keep notes.
export function memoryPrompt(dir) {
  const index = readMemory(dir).files['MEMORY.md'] ?? '';
  let shown = index.split('\n').slice(0, INDEX_LINES).join('\n');
  if (Buffer.byteLength(shown) > INDEX_BYTES) shown = Buffer.from(shown).subarray(0, INDEX_BYTES).toString('utf8');
  return [
    "Skyhop: this session moved from the user's computer to a cloud machine, where Claude Code's auto memory is off, so Skyhop stands in for it.",
    `The project's memory notes from the user's computer are in ${dir}. Read a note there when it's relevant.`,
    `To save a memory, write it as its own markdown file in ${dir}, with frontmatter giving name, description and metadata.type, and add a one-line pointer to it in MEMORY.md, as you would on the user's computer. Update or remove notes that turn out to be wrong. Skyhop brings these notes back to the user's computer.`,
    '',
    shown.trim() ? `MEMORY.md:\n${shown.trim()}` : 'MEMORY.md is empty so far.',
  ].join('\n');
}

// Brings the cloud's changes into the notes on this Mac. A note that changed here
// too keeps this Mac's version, and the cloud's goes to `aside`. `base` holds the
// hashes both sides last agreed on. Returns what happened and the new base.
export function applyCloudMemory({ dir, base = {}, cloud, aside }) {
  const here = memoryHashes(readMemory(dir).files);
  const done = { added: [], updated: [], removed: [], kept: [] };
  for (const [name, text] of Object.entries(cloud)) {
    const theirs = hash(text);
    if (theirs === base[name] || theirs === here[name]) continue;
    if (here[name] === base[name] && writeNote(dir, name, text)) {
      (base[name] ? done.updated : done.added).push(name);
    } else {
      writeNote(aside, name, text);
      done.kept.push(name);
    }
  }
  // A note the cloud removed goes here too, unless this Mac changed it since.
  for (const name of Object.keys(base)) {
    if (name in cloud || here[name] !== base[name]) continue;
    fs.rmSync(path.join(dir, name), { force: true });
    done.removed.push(name);
  }
  return { ...done, base: memoryHashes(cloud) };
}

// One line about the notes for the user, or null when nothing changed.
export function describeMemory(done, asideShown) {
  const changed = [...done.added, ...done.updated, ...done.removed];
  const parts = [];
  if (changed.length > 0) parts.push(`Memory notes changed in the cloud are here now: ${changed.join(', ')}.`);
  if (done.kept.length > 0) parts.push(`Some notes changed both here and in the cloud, so this Mac's version was kept: ${done.kept.join(', ')}. The cloud's copies are in ${asideShown}.`);
  return parts.length > 0 ? parts.join(' ') : null;
}
