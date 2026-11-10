// Runs in the cloud VM, beside the relay. It makes the session's earlier conversation
// appear in the cloud chat as real messages: the Mac posts each of the user's old
// messages, and the chat's own plugin (chat-plugin) answers with Claude's old reply,
// which this file hands it. No model writes those replies.
//
// The plugin only loads when the chat's Claude Code process starts, so the first
// message installs it for this VM's user and ends that process once. The cloud
// starts the chat again within about a minute, with the plugin loaded.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudLog } from './log.mjs';
import { HISTORY_NAME, openHistory, readKey } from './sync.mjs';

export const HISTORY_MARK = '[skyhop-history]';
// The Mac asks this if the chat hasn't said it is ready after a while.
export const READY_PING = '[skyhop-ready?]';
// What the cloud posts into a chat whose process ended and started again.
const RESTART_NOTICE = /^This session's worker process was restarted/;
// The process has to end while the chat's reply to the setup message is still being
// written. The cloud then starts it again by itself within about a minute. Ended
// while idle, the chat stayed down for many minutes in tests.
const RESTART_DELAY_SECONDS = 1;

const SETTING_UP = 'Skyhop is setting up this chat. It restarts once, which takes about a minute, and then shows your earlier conversation.';
const STILL_SETTING_UP = 'Skyhop is still setting up this chat.';
const READY = 'Skyhop: this chat is ready.';
const GAVE_UP = 'Skyhop could not show your earlier conversation in this chat, so a recap follows instead.';
const NO_WORDS = '(Claude worked on this without writing a reply.)';

const chatFolder = () => path.join(os.homedir(), '.skyhop-chat');
const answerFile = () => path.join(chatFolder(), 'answer.json');
const stateFile = root => path.join(root, '.skyhop', 'replay.json');
const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function say(additionalContext) {
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Skyhop relay: output exactly this line and nothing else, and do not use tools: ${additionalContext}` } };
}

// { intro, exchanges: [{ you, claude }] }, or null when this handoff carries none.
export function readHistory(root) {
  try {
    const history = openHistory(fs.readFileSync(path.join(root, '.skyhop', HISTORY_NAME)), readKey(root));
    const exchanges = (history?.exchanges ?? []).filter(item => typeof item?.you === 'string' && typeof item?.claude === 'string');
    return exchanges.length > 0 ? { intro: String(history.intro ?? ''), exchanges } : null;
  } catch {
    return null;
  }
}

// Claude Code loads the plugin for this user from the next time it starts.
export function installPlugin(root) {
  const plugin = path.join(chatFolder(), 'plugin');
  fs.rmSync(plugin, { recursive: true, force: true });
  fs.cpSync(path.join(root, '.skyhop', 'chat-plugin'), plugin, { recursive: true });
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  const settings = readJson(file) ?? {};
  const named = String(settings.env?.CLAUDE_CODE_PLUGIN_DIRS ?? '').split(path.delimiter).filter(Boolean);
  if (named.includes(plugin)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...settings, env: { ...(settings.env ?? {}), CLAUDE_CODE_PLUGIN_DIRS: [...named, plugin].join(path.delimiter) } }, null, 2)}\n`);
}

function bootId() {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    return 'unknown';
  }
}

// The plugin notes each start it is loaded in.
export function pluginLoaded() {
  try {
    return fs.readFileSync(path.join(chatFolder(), 'loaded'), 'utf8').trim() === bootId();
  } catch {
    return false;
  }
}

function setAnswer(text) {
  fs.mkdirSync(chatFolder(), { recursive: true });
  fs.writeFileSync(answerFile(), JSON.stringify({ text }));
}

// With the plugin loaded, the chat's own model is not needed for Skyhop's replies:
// the plugin shows `text` as the chat's reply, word for word.
export function showInChat(text) {
  setAnswer(text);
}

// Has the plugin wait for the resumed session: it runs the relay's wait command as
// the chat's tool call, again and again, until the relay hands it the reply.
export function waitInChat() {
  fs.mkdirSync(chatFolder(), { recursive: true });
  fs.writeFileSync(answerFile(), JSON.stringify({ wait: true }));
}

// Hands the turn back to the chat's model.
export function leaveToModel() {
  clearAnswer();
}

// An answer nobody showed must not turn up as the reply to a later message.
function clearAnswer() {
  if (fs.existsSync(answerFile())) fs.writeFileSync(answerFile(), '{}');
}

// Ends the chat's Claude Code process just after this hook returns, mid-reply.
function restartChat() {
  const pid = Number(process.env.CLAUDE_PID);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  spawn('sh', ['-c', `sleep ${RESTART_DELAY_SECONDS}; kill ${pid}`], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

// Takes a message that belongs to the replay. Returns { output } with the hook's
// output (null lets the chat's turn run, which the plugin then answers), or
// undefined when the message is not the replay's and the relay should handle it.
// `ready` tells the Mac the chat can take the old messages now.
export function replayStep({ root, prompt, ready, restart = restartChat, loaded = pluginLoaded }) {
  clearAnswer();
  const save = state => fs.writeFileSync(stateFile(root), JSON.stringify(state));
  const begin = history => {
    setAnswer(history.intro || 'Skyhop: your earlier conversation follows.');
    save({ state: 'replaying', cursor: 0 });
    const told = ready();
    cloudLog(root, 'history ready', { exchanges: history.exchanges.length, 'mac-told': told ? 'yes' : 'no' });
    return { output: null };
  };

  if (prompt.includes(HISTORY_MARK)) {
    const history = readHistory(root);
    if (!history) {
      cloudLog(root, 'history could not be read');
      save({ state: 'done' });
      return { output: say(GAVE_UP) };
    }
    try {
      installPlugin(root);
    } catch (error) {
      cloudLog(root, 'history plugin could not be installed', { error: error.message });
      save({ state: 'done' });
      return { output: say(GAVE_UP) };
    }
    if (loaded()) return begin(history);
    const restarted = path.join(root, '.skyhop', 'replay-restarted');
    if (fs.existsSync(restarted) || !restart()) {
      cloudLog(root, 'history plugin did not load');
      save({ state: 'done' });
      return { output: say(GAVE_UP) };
    }
    fs.writeFileSync(restarted, '');
    save({ state: 'waiting' });
    cloudLog(root, 'history setup, restarting the chat once');
    return { output: say(SETTING_UP) };
  }

  const state = readJson(stateFile(root));
  if (!state || state.state === 'done') return undefined;
  const waitingMessage = RESTART_NOTICE.test(prompt.trim()) || prompt.includes(READY_PING);
  const history = readHistory(root);
  if (!history) {
    save({ state: 'done' });
    return undefined;
  }

  if (state.state === 'waiting') {
    if (waitingMessage) return loaded() ? begin(history) : { output: say(STILL_SETTING_UP) };
    save({ state: 'done' });
    return undefined;
  }

  // Replaying: each old message arrives in order and gets its old reply.
  const next = history.exchanges[state.cursor];
  if (next && sameText(prompt, next.you)) {
    setAnswer(next.claude.trim() || NO_WORDS);
    save({ state: 'replaying', cursor: state.cursor + 1 });
    return { output: null };
  }
  if (waitingMessage) {
    setAnswer(READY);
    return { output: null };
  }
  cloudLog(root, 'history replay over', { shown: state.cursor, of: history.exchanges.length });
  save({ state: 'done' });
  return undefined;
}
