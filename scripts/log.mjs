// A short record of what Skyhop did, for bug reports. It holds steps, outcomes and
// Skyhop's own messages, and never the conversation, prompts, replies or keys. Every
// value is cleaned first: home folders, credentials in URLs and known token formats
// are hidden, and long values are cut. It runs on the Mac and in the cloud VM, so it
// needs only Node and secrets.mjs, and a failed write never stops Skyhop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from './secrets.mjs';

export const MAX_LOG_BYTES = 512 * 1024;
const VALUE_LIMIT = 300;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function redactPaths(text, home = os.homedir()) {
  const withoutHome = home && home !== '/' ? text.replaceAll(home, '~') : text;
  return withoutHome.replace(/(?:\/Users|\/home)\/[^/\s"'`)]+/g, '~');
}

export function cleanValue(value, home = os.homedir()) {
  const plain = String(value)
    .replace(/\[skyhop-key:[^\]\s]*\]?/g, '[skyhop-key:hidden]')
    .replace(/([a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1');
  const text = redactSecrets(redactPaths(plain, home))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text;
}

function formatField(key, value, home) {
  const text = cleanValue(value, home);
  return `${key}=${/^[^\s"=]+$/.test(text) ? text : JSON.stringify(text)}`;
}

// One line: time, area, event, then key=value fields. Empty fields are left out.
export function formatLine(area, event, fields = {}, { home = os.homedir(), now = new Date() } = {}) {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => formatField(key, value, home));
  return `${now.toISOString()} ${area} ${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}\n`;
}

// Past the size limit the log starts again, and the previous one is kept as .1.
export function appendLog(file, line, maxBytes = MAX_LOG_BYTES) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // The log is only for bug reports, so it never gets in the way.
  }
}

// The end of a log, from the start of a whole line.
export function readLogTail(file, maxBytes) {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, maxBytes);
    const bytes = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, bytes, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
    const text = bytes.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  }
}

// From the file the handoff writes next to the relay in the VM, or from the plugin.
export function skyhopVersion(dir = HERE) {
  const readers = [
    () => fs.readFileSync(path.join(dir, 'version'), 'utf8').trim(),
    () => JSON.parse(fs.readFileSync(path.join(dir, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version,
  ];
  for (const read of readers) {
    try {
      const version = read();
      if (version) return version;
    } catch {
      // try the next place
    }
  }
  return 'unknown';
}

export function logDir(home = os.homedir()) {
  return path.join(home, '.skyhop', 'logs');
}

// The Mac's log, in ~/.skyhop/logs/skyhop.log.
export function log(area, event, fields = {}, home = os.homedir()) {
  appendLog(path.join(logDir(home), 'skyhop.log'), formatLine(area, event, fields, { home }));
}

// The cloud VM's log sits inside .git, so git never commits it, and it outlives a
// reopened chat replacing the .skyhop folder.
export function cloudLogFile(root) {
  return path.join(root, '.git', 'skyhop-cloud.log');
}

export function cloudLog(root, event, fields = {}) {
  appendLog(cloudLogFile(root), formatLine('cloud', event, fields));
}

export function shortId(id) {
  return id ? String(id).slice(0, 8) : null;
}
