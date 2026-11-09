// The instrument the previous twelve arms did not use: hook chokidar's own `_emit` and record which
// call site produced each event.
//
// No file is modified. The entry point is a loader script that patches
// `FsWatcher.prototype._emit` before the probe imports chokidar, and reads the caller out of a stack
// trace. `Error.captureStackTrace` numbering is fragile, so the hook records the whole stack and the
// analysis matches it against the three known `_emit(EV.CHANGE)` sites by file and line.
//
// That answers the one question twelve black-box arms could not: when a `change` arrives twice for the
// same path, do the two come from the *same* site or from *different* sites?
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__hook__')
const HOOK = join(WORK, 'hook.mjs')
const CHILD = join(WORK, 'child.mjs')
const CHOKIDAR = JSON.parse(readFileSync(new URL('../../../node_modules/chokidar/package.json', import.meta.url), 'utf8')).version
const ROUNDS = Number(process.env.HK_ROUNDS || 6)
const ROOT = join(HERE, '..', '..', '..').replace(/\\/g, '/')

// The hook: patch the prototype, count calls, and stamp each with the emitting line.
const HOOK_SRC = `
import { pathToFileURL } from 'node:url'
const mod = await import(process.env.CHOKIDAR_PATH)
const proto = Object.getPrototypeOf(mod.watch('.', { ignoreInitial: true, persistent: false, depth: 0 }))
globalThis.__emitLog = []
const orig = proto._emit
proto._emit = function (event, p, stats) {
  const e = new Error()
  const frames = String(e.stack || '').split('\\n').slice(1, 6)
  globalThis.__emitLog.push({ event: String(event), p: String(p), frames })
  return orig.call(this, event, p, stats)
}
`

const CHILD_SRC = `
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
const mod = await import(process.env.CHOKIDAR_PATH)
const [dir, out] = process.argv.slice(2)
const W = 16, F = 8
const results = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (let round = 0; round < Number(process.env.HK_ROUNDS); round++) {
  const root = join(dir, 'h' + round + '-' + Math.random().toString(36).slice(2))
  mkdirSync(root, { recursive: true })
  const w = mod.watch(root, { ignoreInitial: true })
  const got = []
  w.on('change', (p) => got.push(relative(root, p)))
  await new Promise((r) => w.on('ready', () => r()))
  await sleep(250)
  for (let d = 0; d < W; d++) {
    const sub = join(root, 'd' + d)
    mkdirSync(sub)
    for (let f = 0; f < F; f++) writeFileSync(join(sub, 'f' + f + '.ts'), 'v0')
  }
  await sleep(400)
  globalThis.__emitLog.length = 0
  got.length = 0
  for (let d = 0; d < W; d++) writeFileSync(join(root, 'd' + d, 'f0.ts'), 'w' + d)
  await sleep(500)
  w.close()

  // Which emitting line produced each change, and does any path appear twice from two sites?
  const byPath = new Map()
  for (const rec of globalThis.__emitLog) {
    if (!rec.event.includes('change')) continue
    const line = rec.frames
      .map((f) => (f.match(/handler\\.js:(\\d+)/) || [])[1])
      .filter(Boolean)[0] || '?'
    const rel = relative(root, rec.p)
    if (!byPath.has(rel)) byPath.set(rel, [])
    byPath.get(rel).push({ line, frames: rec.frames })
  }
  // A duplicate is a path with more than one *delivered* change -- not a path with more than one
  // _emit record. The two differ: chokidar calls _emit for events it then de-duplicates internally, so
  // counting _emit records per path read same13 on Windows where nothing is duplicated at all.
  const deliveredPerPath = new Map()
  for (const rel of got) deliveredPerPath.set(rel, (deliveredPerPath.get(rel) || 0) + 1)
  let sameSite = 0, diffSite = 0, paths = 0, dupPaths = 0
  for (const [rel, recs] of byPath) {
    paths++
    if ((deliveredPerPath.get(rel) || 0) < 2) continue
    dupPaths++
    const lines = recs.map((r) => r.line)
    if (new Set(lines).size === 1) sameSite++
    else diffSite++
  }
  const sites = [...new Set([...byPath.values()].flatMap((v) => v.map((r) => r.line)))].sort()
  // For duplicated paths: are the two emit records identical in *stack shape* (same call sequence) or
  // different (two different callers)? That separates "one listener invoked twice" from "two listeners".
  let sameStack = 0, diffStack = 0
  for (const [rel, recs] of byPath.entries()) {
    if ((deliveredPerPath.get(rel) || 0) < 2 || recs.length < 2) continue
    const shape = (r) => r.frames.map((f) => (f.match(/at (?:async )?([\w.$]+)/) || [])[1] || '?').join('>')
    const a = shape(recs[0]), b = shape(recs[recs.length - 1])
    if (a === b) sameStack++
    else diffStack++
  }
  results.push({ delivered: got.length, paths, dupPaths, sameSite, diffSite, sameStack, diffStack, sites: sites.join('+') })
  rmSync(root, { recursive: true, force: true })
}
writeFileSync(out, JSON.stringify(results))
`

describe('which _emit site produces the duplicate', () => {
  it('hooks the prototype and reads the caller line', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(HOOK, HOOK_SRC)
    writeFileSync(CHILD, CHILD_SRC)
    const dir = mkdtempSync(join(tmpdir(), 'hk-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(HOOK).href, CHILD, dir, out], {
      timeout: 420000, killSignal: 'SIGKILL', encoding: 'utf8', cwd: WORK,
      env: { ...process.env, CHOKIDAR_PATH: new URL('../../../node_modules/chokidar/esm/index.js', import.meta.url).href, HK_ROUNDS: String(ROUNDS) },
    })
    let text = `killed(${r.signal || r.status}) ${String(r.stderr || '').slice(0, 300).replace(/\s+/g, ' ')}`
    if (existsSync(out)) {
      const j = JSON.parse(readFileSync(out, 'utf8'))
      text = j.map((x: any) => x.delivered + 'e/dup' + x.dupPaths + '/site' + x.sameSite + ',' + x.diffSite + '/stack' + x.sameStack + ',' + x.diffStack + '[' + x.sites + ']').join(' ')
    }
    console.log(`@@HK platform=${process.platform} node=${process.version.slice(1)} chokidar=${CHOKIDAR} ${text}`)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect('chokidar=' + CHOKIDAR + ' ' + text).toBe('__always_fails__')
  }, 480000)
})
