// The 50 ms loss, at the entry point a cordis user actually calls.
//
// Everything up to here drove `chokidar.watch` directly. `fs-node` wraps it: it watches `dirname(file)`
// for a file target, passes `depth: 0`, and forwards `change` through its own emitter. Any of those
// could change whether the second write surfaces, and this report has already been caught once assuming
// a library-level reading reached users (`adapted295` had to be built for the duplicate).
//
// So the same load through both entry points, gap fixed at 10 ms:
//
//   bare      chokidar.watch(dir)
//   adapted   ctx.plugin(Fs) + ctx.fs.watch(dir)
//
// Reading: was the second write's content ever visible to the handler.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(HERE, '__d50adapt__')
const CHILD = join(WORK, 'child.ts')
const CHOKIDAR = JSON.parse(readFileSync(new URL('../../../node_modules/chokidar/package.json', import.meta.url), 'utf8')).version
const ROUNDS = Number(process.env.DA_ROUNDS || 8)

const SRC = String.raw`
import { Context } from 'cordis'
import Fs from '@cordisjs/plugin-fs-node'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const [dir, out, roundsArg] = process.argv.slice(2)
const res: Record<string, unknown> = { outcome: '-', err: '-' }
const done = () => { writeFileSync(out, JSON.stringify(res)); process.exit(0) }
process.on('uncaughtException', (e: any) => { res.err = 'throw=' + (e.code || e.message); done() })
process.on('unhandledRejection', (e: any) => { res.err = 'reject=' + (e?.code || e?.message); done() })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function run(mode: string, round: number) {
  const root = join(dir, mode + '-' + round + '-' + Math.random().toString(36).slice(2))
  const sub = join(root, 'd0')
  mkdirSync(sub, { recursive: true })
  const files: string[] = []
  for (let i = 0; i < 8; i++) { const p = join(sub, 'f' + i + '.ts'); writeFileSync(p, 'v0'); files.push(p) }

  const seen = new Map<string, Set<string>>()
  const note = (p: string) => {
    let c = '?'
    try { c = String(readFileSync(p, 'utf8')) } catch {}
    const k = basename(p)
    if (!seen.has(k)) seen.set(k, new Set())
    seen.get(k)!.add(c)
  }

  let dispose = async () => {}
  if (mode === 'bare') {
    const mod: any = await import(process.env.CHOKIDAR_PATH as string)
    const w = mod.watch(root, { ignoreInitial: true })
    w.on('change', note)
    await new Promise<void>((r) => w.on('ready', () => r()))
    dispose = async () => { w.close() }
  } else {
    const ctx = new Context()
    ctx.baseUrl = 'file://' + root + '/'
    const fiber = await ctx.plugin(Fs)
    let inner: any
    await ctx.inject(['fs'], (c: any) => { inner = c })
    const w = inner.fs.watch(root)
    w.on('change', note)
    await new Promise<void>((r) => w.on('ready', () => r()))
    dispose = async () => { await fiber.dispose() }
  }
  await sleep(300)

  seen.clear()
  for (const p of files) {
    writeFileSync(p, 'first')
    await sleep(10)
    writeFileSync(p, 'second')
    await sleep(200)
  }
  await sleep(600)
  await dispose()

  let sawSecond = 0, lost = 0
  for (const p of files) {
    const s = seen.get(basename(p)) || new Set()
    if (s.has('second')) sawSecond++
    else lost++
  }
  rmSync(root, { recursive: true, force: true })
  return { sawSecond, lost }
}

;(async () => {
  const rounds = Number(roundsArg) || 8
  const out2: string[] = []
  for (const mode of ['bare', 'adapted']) {
    let s = 0, l = 0
    for (let i = 0; i < rounds; i++) { const r = await run(mode, i); s += r.sawSecond; l += r.lost }
    out2.push(mode + ':saw2nd=' + s + '/lost=' + l + ' of ' + (s + l))
  }
  res.outcome = 'gap=10ms ' + out2.join(' ')
  done()
})()
`

describe('does the 50 ms loss reach ctx.fs.watch', () => {
  it('compares bare chokidar against the adapter', () => {
    rmSync(WORK, { recursive: true, force: true })
    mkdirSync(WORK, { recursive: true })
    writeFileSync(CHILD, SRC)
    const dir = mkdtempSync(join(tmpdir(), 'da-'))
    const out = join(dir, 'out.json')
    const r = spawnSync(process.execPath, ['--import', 'tsx', CHILD, dir, out, String(ROUNDS)], {
      timeout: 480000, killSignal: 'SIGKILL', stdio: 'ignore', cwd: WORK,
      env: { ...process.env, CHOKIDAR_PATH: new URL('../../../node_modules/chokidar/esm/index.js', import.meta.url).href },
    })
    let text: string
    if (!existsSync(out)) text = `killed(${r.signal || r.status})`
    else {
      const j = JSON.parse(readFileSync(out, 'utf8'))
      text = `${j.outcome}${j.err && j.err !== '-' ? ' err=' + j.err : ''}`
    }
    console.log(`@@DA platform=${process.platform} node=${process.version.slice(1)} chokidar=${CHOKIDAR} ${text}`)
    rmSync(dir, { recursive: true, force: true })
    rmSync(WORK, { recursive: true, force: true })
    expect('chokidar=' + CHOKIDAR + ' ' + text).toBe('__always_fails__')
  }, 540000)
})
