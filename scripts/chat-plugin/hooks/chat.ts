// Runs in the cloud chat of a Skyhop session, never on the user's computer. The
// relay (relay.mjs, replay.mjs) decides what the chat says, through the answer file:
//
//   { text }   show this as the chat's reply, word for word. That is how the
//              session's earlier conversation appears as real messages, and how the
//              resumed session's replies are shown without being written twice.
//   { wait }   the resumed session is working: run the relay's wait command as this
//              chat's tool call, again and again, until the relay leaves the reply.
//
// The chat's model is not called for either. Without an answer waiting, every turn
// goes to the model as usual.
import type { Register } from 'claude-code'

const FOLDER = '.skyhop-chat'
const BOOT_ID = '/proc/sys/kernel/random/boot_id'
const WAIT_COMMAND = 'node .skyhop/relay.mjs wait'
// A wait that returns at once, over and over, is not waiting for anything.
const QUICK_MS = 2000
const MAX_QUICK_WAITS = 3
const CANNOT_WAIT = 'Skyhop could not wait for the session in this chat. Send any message to see its reply.'
// The cloud asks a chat to commit and push files left in the folder. Skyhop saves
// the session's work itself, after its secret scan.
const NO_PUSH = 'Skyhop saves this work to GitHub itself, so nothing was committed or pushed from this chat.'

let lastWaitAt = 0
let quickWaits = 0
let answeredTurn = ''
let nudgedTurn = ''

export const register: Register = on => {
  // Tells the relay this start of the chat has the module loaded. The resumed
  // session the relay runs inside this VM loads the module too, and is left alone.
  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')
    if (home && !(await $.env.get('SKYHOP_INNER'))) {
      const boot = (await $.fs.exists(BOOT_ID)) ? (await $.fs.read(BOOT_ID)).trim() : 'unknown'
      await $.fs.write(`${home}/${FOLDER}/loaded`, boot)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || (await $.env.get('SKYHOP_INNER'))) return yield* next(e)
    let text = ''
    let isWaiting = false
    try {
      const home = await $.env.get('HOME')
      const file = `${home}/${FOLDER}/answer.json`
      if (home && (await $.fs.exists(file))) {
        const saved = JSON.parse((await $.fs.read(file)) || '{}') as { text?: unknown; wait?: unknown }
        if (typeof saved.text === 'string') text = saved.text
        isWaiting = saved.wait === true
        if (isWaiting) {
          const now = await $.clock.now()
          quickWaits = now - lastWaitAt < QUICK_MS ? quickWaits + 1 : 0
          lastWaitAt = now
          if (quickWaits >= MAX_QUICK_WAITS) {
            isWaiting = false
            text = CANNOT_WAIT
          }
        }
        // One answer serves one turn.
        if (text) await $.fs.write(file, '{}')
      }
    } catch {
      text = ''
      isWaiting = false
    }

    if (isWaiting) {
      const input = { command: WAIT_COMMAND, description: 'Wait for the session' }
      yield { kind: 'tool', index: 0, id: `toolu_skyhop_${String(lastWaitAt)}`, name: 'Bash' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input }], stopReason: 'tool_use', usage: null }
    }
    if (!text && e.turnId === answeredTurn && nudgedTurn !== e.turnId) {
      // The turn already has Skyhop's reply, so this step is the cloud's nudge.
      nudgedTurn = e.turnId
      text = NO_PUSH
    } else if (text) {
      answeredTurn = e.turnId
    }
    if (!text) return yield* next(e)
    yield { kind: 'text', index: 0, text }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
  })
}
