// Skyhop's animation above the prompt: a plane carries the session from the
// laptop into the cloud when a handoff starts, and back down when this window
// opens a session that came home. It only decorates: Skyhop's own hooks in
// hooks.json do the work, and run the same with or without this module.
import type { Register } from 'claude-code'

type Mode = 'away' | 'home'

// ---------------------------------------------------------------------------
// Frames. The same drawing as the preview page: a 60 x 18 pixel picture, two
// pixels to a terminal cell, drawn with half-block characters.
// ---------------------------------------------------------------------------

const COLS = 60
const ROWS = 9
const W = COLS
const H = ROWS * 2
const NONE = -1 // the terminal's own background

const PAL: Record<string, number> = {
  k: 0x4a5468, s: 0x18202e, l: 0x34506e, p: 0x7ee2a8, c: 0x7ee2a8,
  b: 0xa9b2c1, d: 0x6f798b,
  B: 0x4c7dff, D: 0x2b4fc4, e: 0xd3ecff,
  o: 0x8794aa, w: 0xf3f6fb, g: 0xd3dbe8,
  t: 0x8e9ab0, y: 0xffd45c,
}
const color = (ch: string): number => PAL[ch] ?? NONE

const LAPTOP = [
  '.kkkkkkkkkkkkkkkk.',
  '.kssssssssssssssk.',
  '.kslllllllssssssk.',
  '.kssssssssssssssk.',
  '.kslllllsllllsssk.',
  '.kssssssssssssssk.',
  '.kspssssssssssssk.',
  '.ksspsssssssssssk.',
  '.kspscssssssssssk.',
  '.kkkkkkkkkkkkkkkk.',
  'bbbbbbbbbbbbbbbbbb',
  '.dddddddddddddddd.',
]
const LID = 10

const PLANE = [
  'D..............',
  'DD.............',
  'DDDBBBBBBBBBB..',
  '.BBeBeBeBeBBBeB',
  '..BBBBDDDBBBBB.',
  '......DDD......',
]

// The session, towed behind the plane: a little copy of the screen.
const BANNER = [
  'kkkkkkkkk',
  'ksllllssk',
  'kslllllsk',
  'kspcssssk',
  'kkkkkkkkk',
]

const CLOUD = [
  '..........oooo..........',
  '.......ooowwwwo.........',
  '......owwwwwwwwo.ooo....',
  '...ooowwwwwwwwwwowwwoo..',
  '..owwwwwwwwwwwwwwwwwwwo.',
  '.owwwwwwwwwwwwwwwwwwwwwo',
  'owwwwwwwwwwwwwwwwwwwwwwo',
  'owggwwwwwwwwwwwwwwwwgggo',
  '.oggggggggggggggggggggo.',
  '..oooooooooooooooooooo..',
]

const LAP_X = 1
const LAP_Y = 6
const CLOUD_X = 35
const CLOUD_Y = 1
// The hop: from behind the laptop's lid, up and over, into the cloud.
const P0x = 12, P0y = 12, PCx = 27, PCy = -5, P1x = 48, P1y = 7

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const glide = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
const span = (ms: number, a: number, b: number) => clamp((ms - a) / (b - a), 0, 1)
const bezX = (t: number) => (1 - t) * (1 - t) * P0x + 2 * (1 - t) * t * PCx + t * t * P1x
const bezY = (t: number) => (1 - t) * (1 - t) * P0y + 2 * (1 - t) * t * PCy + t * t * P1y
const slopeAt = (t: number) => {
  const dx = 2 * (1 - t) * (PCx - P0x) + 2 * t * (P1x - PCx)
  const dy = 2 * (1 - t) * (PCy - P0y) + 2 * t * (P1y - PCy)
  return clamp(dy / dx, -0.15, 0.15)
}

type Px = Int32Array

function put(px: Px, x: number, y: number, c: number) {
  const rx = Math.round(x)
  const ry = Math.round(y)
  if (rx >= 0 && rx < W && ry >= 0 && ry < H) px[ry * W + rx] = c
}

function sprite(px: Px, rows: readonly string[], x0: number, y0: number, flip = false, slope = 0) {
  const w = (rows[0] ?? '').length
  const cx = (w - 1) / 2
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < w; rx++) {
      const ch = row.charAt(flip ? w - 1 - rx : rx)
      if (ch === '.') continue
      put(px, x0 + rx, y0 + ry + Math.round((rx - cx) * slope), color(ch))
    }
  })
}

// The lid folds down onto the base: open = 1, shut = 0. The cursor blinks while open.
function laptop(px: Px, open: number, ms: number, empty: boolean) {
  const h = Math.max(1, Math.round(LID * open))
  const blink = Math.floor(ms / 400) % 2 === 1
  for (let i = 0; i < h; i++) {
    let src = LAPTOP[h === LID ? i : Math.min(LID - 1, Math.floor((i * LID) / h))] ?? ''
    if (empty) src = src.replace(/[lpc]/g, 's')
    let row = h < 3 ? src.replace(/[slpc]/g, 'k') : src
    if (blink) row = row.replace(/c/g, 's')
    sprite(px, [row], LAP_X, LAP_Y + LID - h + i)
  }
  sprite(px, LAPTOP.slice(LID), LAP_X, LAP_Y + LID)
}

// The plane and its banner at flight position u: 0 is behind the laptop's lid,
// 1 + LAG is inside the cloud. Going home, u runs backwards and the plane leads.
const LAG = 0.26
const level = (t: number) => (t > 0.8 ? (slopeAt(t) * (1 - t)) / 0.2 : slopeAt(t))
function flight(px: Px, u: number, back: boolean) {
  const tp = clamp(back ? u - LAG : u, 0, 1)
  const tb = clamp(back ? u : u - LAG, 0, 1)
  const bx = bezX(tb), by = bezY(tb), x = bezX(tp), y = bezY(tp)
  const dir = back ? -1 : 1
  const tailX = x - dir * 7
  const ropeTo = bx + dir * 4
  for (let i = 2; i < 6; i += 2) {
    const f = i / 6
    put(px, ropeTo + (tailX - ropeTo) * f, by + (y - 1 - by) * f, color('o'))
  }
  // Once a part reaches the far end it is inside the cloud, or behind the lid.
  const done = (t: number) => (back ? t <= 0 : t >= 1)
  if (!done(tb)) sprite(px, BANNER, bx - 4, by - 2)
  if (!done(tp)) sprite(px, PLANE, x - 7, y - 3, back, level(tp))
}

function trail(px: Px, upTo: number) {
  let lastX = NaN, lastY = NaN, n = 0
  for (let t = 0; t <= upTo; t += 0.004) {
    const x = Math.round(bezX(t)), y = Math.round(bezY(t))
    if (x === lastX && y === lastY) continue
    lastX = x
    lastY = y
    if (n++ % 3 === 0 && x > LAP_X + 19) put(px, x, y, color('t'))
  }
}

function sparkle(px: Px, x: number, y: number, phase: number) {
  if (phase <= 0 || phase >= 1) return
  const c = color('y')
  put(px, x, y, c)
  if (phase > 0.25 && phase < 0.75) {
    put(px, x - 1, y, c)
    put(px, x + 1, y, c)
    put(px, x, y - 1, c)
    put(px, x, y + 1, c)
  }
}

const LENGTH = 3600

const DRAW: Record<Mode, (px: Px, ms: number) => void> = {
  // Hand off: the plane climbs out from behind the laptop towing the session,
  // hops into the cloud with it, and the lid shuts on an empty screen.
  away(px, ms) {
    const u = (1 + LAG) * glide(span(ms, 300, 2500))
    const shut = ease(span(ms, 2700, 3150))
    trail(px, clamp(u - LAG, 0, 1))
    if (u > 0 && u < 1 + LAG) flight(px, u, false)
    laptop(px, 1 - shut, ms, u > LAG)
    sprite(px, CLOUD, CLOUD_X, CLOUD_Y + (ms > 2350 && ms < 2550 ? -1 : 0))
    sparkle(px, 58, 2, span(ms, 2400, 2800))
    sparkle(px, 33, 1, span(ms, 2500, 2900))
    sparkle(px, 56, 12, span(ms, 2600, 3000))
  },
  // Come home: the lid opens on an empty screen, the plane brings the session
  // out of the cloud and down behind the laptop, and the screen fills again.
  home(px, ms) {
    const open = ease(span(ms, 0, 450))
    const u = (1 + LAG) * (1 - glide(span(ms, 550, 2750)))
    trail(px, 1)
    if (u > 0 && u < 1 + LAG) flight(px, u, true)
    laptop(px, open, ms, u > 0.02)
    sprite(px, CLOUD, CLOUD_X, CLOUD_Y + (ms > 550 && ms < 750 ? -1 : 0))
    sparkle(px, 3, 4, span(ms, 2750, 3150))
    sparkle(px, 18, 6, span(ms, 2850, 3250))
  },
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(b: Uint8Array): string {
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < b.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < b.length ? B64.charAt(n & 63) : '='
  }
  return out
}

// The Raster's cells: per cell three little-endian u32s, [codePoint, fg, bg].
const DEFAULT = 0x01000000
function cellsAt(mode: Mode, ms: number): string {
  const px = new Int32Array(W * H).fill(NONE)
  DRAW[mode](px, Math.floor(ms / STEP) * STEP)
  const view = new DataView(new ArrayBuffer(COLS * ROWS * 12))
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const top = px[2 * r * W + c] ?? NONE
      const bot = px[(2 * r + 1) * W + c] ?? NONE
      let cell: [number, number, number]
      if (top < 0 && bot < 0) cell = [0x20, DEFAULT, DEFAULT]
      else if (bot < 0) cell = [0x2580, top, DEFAULT]
      else if (top < 0) cell = [0x2584, bot, DEFAULT]
      else if (top === bot) cell = [0x2588, top, DEFAULT]
      else cell = [0x2580, top, bot]
      const at = (r * COLS + c) * 12
      view.setUint32(at, cell[0], true)
      view.setUint32(at + 4, cell[1], true)
      view.setUint32(at + 8, cell[2], true)
    }
  }
  return base64(new Uint8Array(view.buffer))
}

// ---------------------------------------------------------------------------
// Playing it above the prompt. Kept in this module's own variables: a reload
// just ends a play.
// ---------------------------------------------------------------------------

const STEP = 1000 / 30
const HOLD = 1500

type Show = { mode: Mode; caption: string; phase: 'playing' | 'landed' | 'folded'; run: number }

// skyhop.mjs prints one of these only once a handoff has gone through.
const HANDED_OFF = /Cloud session started on|Quit this window now \(type \/exit\)/
const IN_THE_CLOUD = 'Your session is in the cloud'
const BACK_HOME = 'Your session is back from the cloud'

let current: Show | null = null
let bandId: string | undefined
let runs = 0
let playedMs = 0
let lastHome: number | undefined

// The play itself is kept free of `$`: each hook below drives it with its own
// `$` calls, which every Claude Code version with hooks modules accepts.
function begin(mode: Mode, caption: string): number {
  const run = ++runs
  playedMs = 0
  current = { mode, caption, phase: 'playing', run }
  return run
}

// One frame on: the cells to paint, 'landed' when the animation just ended, or
// 'stale' when a newer play took over.
function advance(run: number): string | 'landed' | 'stale' {
  if (!current || current.run !== run || current.phase !== 'playing') return 'stale'
  playedMs += STEP
  if (playedMs < LENGTH) return cellsAt(current.mode, playedMs)
  current = { ...current, phase: 'landed' }
  return 'landed'
}

function fold(run: number): boolean {
  if (!current || current.run !== run) return false
  current = { ...current, phase: 'folded' }
  return true
}

function clear(): boolean {
  if (!current || current.phase === 'playing') return false
  current = null
  return true
}

const SESSION_ID = /^[\w-]+$/

export const register: Register = on => {
  // A handoff that went through: the plane takes the session up.
  on('tool.call', async ($, e, next) => {
    // Bash, or the PowerShell tool Claude Code may use on Windows.
    const tool: string = e.tool
    if (tool !== 'Bash' && tool !== 'PowerShell') return next(e)
    const ran = await next(e)
    const command = String((e as { command?: unknown }).command ?? '')
    const isHandoff = /skyhop\.mjs/.test(command) && /--yes/.test(command) && !/--dry-run/.test(command)
    if (!isHandoff || ran.deny !== undefined || ran.isError === true || !HANDED_OFF.test(ran.text ?? '')) return ran

    const run = begin('away', IN_THE_CLOUD)
    $.ui.invalidate('ui.render')
    const timer = $.clock.every(Math.round(STEP), () => {
      const step = advance(run)
      if (step === 'stale') return timer.cancel()
      if (step !== 'landed') {
        if (bandId) void $.ui.blit({ requestId: bandId, key: 'sky', cells: step })
        return
      }
      timer.cancel()
      $.ui.invalidate('ui.render')
      $.clock.after(HOLD, () => {
        if (fold(run)) $.ui.invalidate('ui.render')
      })
    })
    return ran
  }).catch(($, e, next) => next(e))

  // A session picked in /resume that came back from the cloud: the plane brings it
  // down. Skyhop's own SessionStart hook runs beneath this one and leaves a note
  // (scripts/back.mjs, homecomingFile) only when this window shows the cloud part.
  on('classic.SessionStart', async ($, e, next) => {
    const done = await next(e)
    if (e.source !== 'resume' || !SESSION_ID.test(e.session_id)) return done
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
    const note = `${home}/.skyhop/animate/${e.session_id}.json`
    if (!home || !(await $.fs.exists(note))) return done
    const { at } = JSON.parse(await $.fs.read(note)) as { at?: unknown }
    if (typeof at !== 'number' || at === lastHome) return done
    lastHome = at

    const run = begin('home', BACK_HOME)
    $.ui.invalidate('ui.render')
    const timer = $.clock.every(Math.round(STEP), () => {
      const step = advance(run)
      if (step === 'stale') return timer.cancel()
      if (step !== 'landed') {
        if (bandId) void $.ui.blit({ requestId: bandId, key: 'sky', cells: step })
        return
      }
      timer.cancel()
      $.ui.invalidate('ui.render')
      $.clock.after(HOLD, () => {
        if (fold(run)) $.ui.invalidate('ui.render')
      })
    })
    return done
  }).catch(($, e, next) => next(e))

  // The next thing the person sends clears the line.
  on('prompt.submit', ($, e, next) => {
    if (clear()) $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    const show = current
    if (!show || e.props.hasSurvey) return next(e)
    bandId = e.requestId

    if (e.surface === 'terminal' && e.props.bodyColumns >= COLS && show.phase !== 'folded') {
      const { Box, Text, Raster } = $.ui.resolve(e)
      const at = show.phase === 'playing' ? playedMs : LENGTH
      return (
        <Box flexDirection="column">
          <Raster key="sky" columns={COLS} rows={ROWS} cells={cellsAt(show.mode, at)} />
          {show.phase === 'playing' ? (
            <Text> </Text>
          ) : (
            <Text>
              <Text color="success">✓ </Text>
              {show.caption}
            </Text>
          )}
        </Box>
      )
    }

    // The desktop app, a narrow terminal, or after the hold: one line.
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        <Text color="success">✓ </Text>
        {show.caption}
      </Text>
    )
  })
}
