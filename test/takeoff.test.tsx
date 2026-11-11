// hooks/takeoff.tsx under `claude plugin test .` (npm test runs the .mjs suites).
import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'skyhop',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 75,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const HANDOFF = 'node "/plugins/skyhop/scripts/skyhop.mjs" --brief b.md --session s --yes'
const STARTED = '\nCloud session started on skyhop-run/main-1412.\nSession ID: session_01\nLink: https://claude.ai/code/session_01'

test('a handoff that went through plays the plane up: pixels in a wide terminal, one line elsewhere', async ($, on) => {
  on('tool.call', () => ({ result: {}, text: STARTED }))
  await $.tool.call({ tool: 'Bash', command: HANDOFF })

  const wide = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await wide.find({ key: 'sky' })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 50 } })
  expect(await narrow.find({ key: 'sky' })).toBeUndefined()
  expect((await narrow.find({ type: 'Text', text: /in the cloud/ }))?.text).toContain('Your session is in the cloud')
  await narrow.unmount()

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /in the cloud/ }))?.text).toContain('Your session is in the cloud')
  await desktop.unmount()
})

test('a dry run, a stopped handoff or another command plays nothing', async ($, on) => {
  let output = 'Dry run: nothing was pushed or started.'
  on('tool.call', () => ({ result: {}, text: output }))
  await $.tool.call({ tool: 'Bash', command: HANDOFF.replace('--yes', '--dry-run') })
  output = 'Skyhop found a likely secret, so nothing left this machine.'
  await $.tool.call({ tool: 'Bash', command: HANDOFF })
  output = STARTED
  await $.tool.call({ tool: 'Bash', command: 'cat notes.txt' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /in the cloud/ })).toBeUndefined()
  await ui.unmount()
})

test('a resumed session plays the plane home only when Skyhop left the note', async ($, on) => {
  let note: string | null = null
  on('classic.SessionStart', () => ({}))
  on('env.get', () => ({ value: '/Users/me' }))
  on('fs.exists', () => ({ value: note !== null }))
  on('fs.read', () => ({ value: note ?? '' }))

  await $.classic.SessionStart({ source: 'resume', session_id: 'abc-123' })
  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /back from the cloud/ })).toBeUndefined()
  await ui.unmount()

  note = '{"at":1762700000000}\n'
  await $.classic.SessionStart({ source: 'startup', session_id: 'abc-123' })
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /back from the cloud/ })).toBeUndefined()
  await ui.unmount()

  await $.classic.SessionStart({ source: 'resume', session_id: 'abc-123' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'sky' })).toBeDefined()
  await ui.unmount()
})

test('a handoff run through the PowerShell tool on Windows plays the plane too', async ($, on) => {
  on('tool.call', () => ({ result: {}, text: STARTED }))
  await $.tool.call({ tool: 'PowerShell', command: 'node "C:/Users/me/.claude/plugins/cache/skyhop/skyhop/0.11.2/scripts/skyhop.mjs" --brief b.md --session s --yes' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'sky' })).toBeDefined()
  await ui.unmount()
})
