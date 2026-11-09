// The cloud chat's first message quotes the session's last exchanges word for word.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resumePrompt, withoutRecentSection } from '../scripts/brief.mjs';
import { recentConversation, recentExchanges } from '../scripts/conversation.mjs';
import { stripRecap } from '../scripts/relay.mjs';
import { tempDir } from './helpers.mjs';

// A session file built line by line, each conversation line linked to the one before.
function session(t) {
  const file = path.join(tempDir(t), 'session.jsonl');
  let last = null;
  let n = 0;
  const add = (fields, { parent = last } = {}) => {
    const uuid = `u${n += 1}`;
    fs.appendFileSync(file, `${JSON.stringify({ uuid, parentUuid: parent, sessionId: 's', ...fields })}\n`);
    last = uuid;
    return uuid;
  };
  const you = text => add({ type: 'user', message: { role: 'user', content: text } });
  const claude = (...blocks) => add({ type: 'assistant', message: { role: 'assistant', content: blocks } });
  const text = words => ({ type: 'text', text: words });
  const tool = () => ({ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } });
  const result = () => add({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'file.txt' }] }, toolUseResult: { stdout: 'file.txt' } });
  const bookkeeping = () => fs.appendFileSync(file, `${JSON.stringify({ type: 'last-prompt', sessionId: 's' })}\n`);
  return { file, add, you, claude, text, tool, result, bookkeeping, at: () => last, setLast: id => { last = id; } };
}

test('exchanges are quoted in order, with tool steps, notes and the handoff itself left out', t => {
  const s = session(t);
  s.you('Can you add a retry to the upload?');
  s.claude({ type: 'thinking', thinking: 'hmm' }, s.text('Looking at the upload code.'), s.tool());
  s.result();
  s.claude(s.text('Added a retry with three attempts.'));
  s.add({ type: 'user', isMeta: true, message: { content: [s.text('Caveat: notes Claude Code adds')] } });
  s.you('<command-name>/model</command-name>\n<command-args>haiku</command-args>');
  s.you('<local-command-stdout>Set model to haiku</local-command-stdout>');
  s.you([s.text('<system-reminder>internal</system-reminder>Now document it.'), { type: 'image', source: {} }]);
  s.claude(s.text('Documented in the README.'));
  s.bookkeeping();
  s.you('<command-message>skyhop:skyhop</command-message>\n<command-name>/skyhop:skyhop</command-name>');
  s.claude(s.text('Here is the handoff plan.'));

  assert.deepEqual(recentExchanges(s.file), [
    { you: 'Can you add a retry to the upload?', claude: 'Looking at the upload code.\n\nAdded a retry with three attempts.' },
    { you: '/model haiku', claude: '' },
    { you: 'Now document it.\n[image]', claude: 'Documented in the README.' },
  ]);
  const { section, count } = recentConversation(s.file);
  assert.equal(count, 3);
  assert.match(section, /^## Recent conversation, word for word \(your last 3 messages before the handoff\)\n\nYou: Can you add a retry/);
  assert.match(section, /You: \/model haiku\n\nYou: Now document it\.\n\[image\]\n\nClaude: Documented in the README\.$/);
});

test('only the branch the session carries on from is quoted', t => {
  const s = session(t);
  const first = s.you('First question');
  s.claude(s.text('First answer'));
  s.you('A message on a branch that was left behind');
  s.claude(s.text('An answer nobody will see'));
  // The session went back to the first answer and carried on from there.
  s.setLast(first);
  s.claude(s.text('First answer, again'));
  s.you('Second question');
  s.claude(s.text('Second answer'));
  assert.deepEqual(recentExchanges(s.file).map(exchange => exchange.you), ['First question', 'Second question']);
});

test('home folders and likely secrets are hidden, long messages are cut, and the oldest go first', t => {
  const s = session(t);
  s.you('Read /Users/someone/project/notes.txt with token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  s.claude(s.text('x'.repeat(5000)));
  for (let i = 0; i < 20; i += 1) {
    s.you(`message ${i}`);
    s.claude(s.text('y'.repeat(3000)));
  }
  const all = recentConversation(s.file, { home: '/Users/someone', maxBytes: 1024 * 1024 });
  // 21 exchanges, so the oldest six are left out.
  assert.equal(all.count, 15);
  assert.doesNotMatch(all.section, /Read |message [0-4]\n/);

  const first = session(t);
  first.you('Read /Users/someone/project/notes.txt with token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  first.claude(first.text('x'.repeat(5000)));
  const one = recentConversation(first.file, { home: '/Users/someone' }).section;
  assert.match(one, /Read ~\/project\/notes\.txt/);
  assert.doesNotMatch(one, /ghp_abcdef/);
  assert.match(one, /x{100} \[…\]$/);

  const capped = recentConversation(s.file, { maxBytes: 8 * 1024 });
  assert.ok(Buffer.byteLength(capped.section) <= 8 * 1024);
  assert.ok(capped.count > 0 && capped.count < 15);
  assert.match(capped.section, /You: message 19\n\nClaude: y+$/);
});

test('an empty, missing or unreadable session file quotes nothing', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'session.jsonl');
  assert.deepEqual(recentConversation(file), { section: '', count: 0 });
  fs.writeFileSync(file, 'not json\n{"type":"user"\n');
  assert.deepEqual(recentConversation(file), { section: '', count: 0 });
});

test("the quote replaces the brief's own recent conversation, and the relay strips it all", () => {
  const brief = '## Goal\nShip it.\n\n## Recent conversation\nUser asked for a retry.\n\n## Notes\nKeep this.';
  assert.equal(withoutRecentSection(brief), '## Goal\nShip it.\n\n## Notes\nKeep this.');
  assert.equal(withoutRecentSection('## Goal\nShip it.\n\n**Recent conversation:** none'), '## Goal\nShip it.\n\n**Recent conversation:** none');
  const prompt = resumePrompt('demo', brief, null, '## Recent conversation, word for word (your last 1 message before the handoff)\n\nYou: hi');
  assert.match(prompt, /Ship it\.\n\n## Notes\nKeep this\.\n\n## Recent conversation, word for word/);
  assert.doesNotMatch(prompt, /User asked for a retry/);
  assert.doesNotMatch(stripRecap(prompt), /You: hi|Ship it/);
  assert.match(resumePrompt('demo', brief), /User asked for a retry/);
});
