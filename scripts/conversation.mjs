// The last exchanges of a session, word for word, for the top of the cloud chat. The
// chat can't show the session's earlier messages, so its first message quotes them.
// The transcript format is internal, so anything unexpected means fewer exchanges,
// never a failed handoff.
import fs from 'node:fs';
import os from 'node:os';
import { redactPaths } from './log.mjs';
import { redactSecrets } from './secrets.mjs';

export const RECENT_HEADING = '## Recent conversation, word for word';
const TAIL_BYTES = 8 * 1024 * 1024;
const MAX_EXCHANGES = 15;
const MAX_BYTES = 40 * 1024;
const YOUR_LIMIT = 2000;
const CLAUDE_LIMIT = 4000;
const HANDOFF_COMMAND = /<command-name>\/(?:skyhop:)?skyhop<\/command-name>/;

function readTail(file, bytes) {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - bytes);
  const buffer = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // A cut-off first line is dropped.
  return start > 0 ? buffer.subarray(buffer.indexOf(10) + 1) : buffer;
}

// The messages Claude Code would carry on from: back from the last conversation line
// through each line's parent, as far as this part of the file goes.
function currentBranch(bytes) {
  const byId = new Map();
  let last = null;
  for (const line of bytes.toString('utf8').split('\n')) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record?.uuid !== 'string' || record.isSidechain) continue;
    byId.set(record.uuid, record);
    last = record;
  }
  const branch = [];
  const seen = new Set();
  for (let record = last; record && !seen.has(record.uuid); record = byId.get(record.parentUuid)) {
    seen.add(record.uuid);
    branch.push(record);
  }
  return branch.reverse();
}

function texts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap(block => {
    if (block?.type === 'text') return [block.text ?? ''];
    if (block?.type === 'image') return ['[image]'];
    return [];
  });
}

// What the user typed, or null for tool results, notes Claude Code adds, and the
// output of local commands. A slash command shows as the command itself.
function typed(record) {
  if (record.type !== 'user' || record.isMeta || record.toolUseResult) return null;
  const content = record.message?.content;
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) return null;
  const text = texts(content).join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || /<local-command-(stdout|stderr|caveat)>/.test(text)) return null;
  const command = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (command) {
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return { text: `${command[1]}${args ? ` ${args}` : ''}`, handoff: HANDOFF_COMMAND.test(text) };
  }
  return { text, handoff: false };
}

function cut(text, limit) {
  return text.length > limit ? `${text.slice(0, limit).trimEnd()} […]` : text;
}

// Exchanges before the handoff, oldest first: what the user typed, and Claude's
// words in reply. Tool calls and thinking are left out.
export function recentExchanges(file, { limit = MAX_EXCHANGES } = {}) {
  let branch;
  try {
    branch = currentBranch(readTail(file, TAIL_BYTES));
  } catch {
    return [];
  }
  const exchanges = [];
  for (const record of branch) {
    const said = typed(record);
    if (said) {
      exchanges.push({ you: said.text, handoff: said.handoff, claude: [] });
    } else if (record.type === 'assistant' && exchanges.length > 0) {
      const words = texts(record.message?.content).join('\n').trim();
      if (words) exchanges.at(-1).claude.push(words);
    }
  }
  const handoff = exchanges.findLastIndex(exchange => exchange.handoff);
  const before = handoff >= 0 ? exchanges.slice(0, handoff) : exchanges;
  return before.slice(-limit).map(({ you, claude }) => ({ you, claude: claude.join('\n\n') }));
}

// The section for the recap, and how many messages it quotes. The oldest exchanges
// go first when it's too long, and home folders and likely secrets are hidden.
export function recentConversation(file, { home = os.homedir(), maxBytes = MAX_BYTES } = {}) {
  const blocks = recentExchanges(file).map(({ you, claude }) => [
    `You: ${cut(you, YOUR_LIMIT)}`,
    ...(claude ? [`Claude: ${cut(claude, CLAUDE_LIMIT)}`] : []),
  ].join('\n\n'));
  const clean = text => redactSecrets(redactPaths(text, home));
  while (blocks.length > 0) {
    const body = clean(blocks.join('\n\n'));
    const section = `${RECENT_HEADING} (your last ${blocks.length} message${blocks.length === 1 ? '' : 's'} before the handoff)\n\n${body}`;
    if (Buffer.byteLength(section) <= maxBytes) return { section, count: blocks.length };
    blocks.shift();
  }
  return { section: '', count: 0 };
}
