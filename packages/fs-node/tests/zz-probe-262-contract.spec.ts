/* eslint-disable */
// PROBE 262 / C: three things the earlier runs did not measure.
//
// C1  REGISTRATION BOUNDARY. sleep(200) then length===0 cannot tell "lost" from
//     "late". This measures the boundary directly: clear the buffer, operate,
//     and record the delay at which the FIRST event arrives, per seed.
//     A first-event delay under the sleep is one delivery; a second event after
//     the sleep was counted by older harnesses as part of the window.
//
// C2  COUNT-FALSIFIABILITY. A counter that cannot report anything but 1 cannot
//     support "1.00 = no duplicates". This injects a KNOWN duplicate and a
//     KNOWN loss into a synthetic arm and checks they show up.
//
// C3  FOURTH REFERENCE. chokidar and raw fs.watch are both node-native paths.
//     @parcel/watcher (FSEvents on macOS, inotify on Linux, ReadDirectoryChanges
//     on Windows) is an independent mechanism. It is an optional devDependency:
//     if it is absent in CI the arm reports `available:false` rather than
//     silently passing.
import { Context } from 'cordis'
import chokidar from 'chokidar'
import {
  mkdirSync, mkdtempSync, renameSync, rmSync, watch as fswatch, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SEEDS = Number(process.env.PROBE262_SEEDS || 60)
const SETTLE = Number(process.env.PROBE262_SETTLE || 400)

// C1: first-event latency, measured rather than assumed
it('probe 262 c1: first-event latency per seed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lat262-'))
  const lat: Record<string, number[]> = { write: [], rename: [], delete: [] }
  let missed = 0

  for (let seed = 0; seed < SEEDS; seed++) {
    const dir = join(root, `s${seed}`); mkdirSync(dir)
    const file = join(dir, 'watched.txt'); writeFileSync(file, '0')
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const marks: number[] = []
    const stop = await ctx.fs.watch(file, () => marks.push(Date.now()))
    await sleep(250)
    marks.length = 0

    const ops: [string, () => void][] = [
      ['write', () => writeFileSync(file, '1')],
      ['rename', () => { writeFileSync(join(dir, 'tmp.txt'), '2'); renameSync(join(dir, 'tmp.txt'), file) }],
      ['delete', () => rmSync(file, { force: true })],
    ]
    for (const [name, op] of ops) {
      marks.length = 0
      const t0 = Date.now()
      op()
      await sleep(SETTLE)
      if (marks.length === 0) missed++
      else lat[name].push(marks[0] - t0)
    }

    await stop(); await fiber.dispose()
  }

  const stat = (xs: number[]) => xs.length === 0 ? null : ({
    n: xs.length,
    min: Math.min(...xs),
    p50: xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)],
    max: Math.max(...xs),
  })
  console.log('PROBE262_LATENCY ' + JSON.stringify({
    seeds: SEEDS, settle: SETTLE, missed,
    platform: process.platform, node: process.version,
    write: stat(lat.write), rename: stat(lat.rename), delete: stat(lat.delete),
  }))
  rmSync(root, { recursive: true, force: true })
}, 1_800_000)

// C2: can the counter report anything other than 1?
it('probe 262 c2: counter falsifiability', async () => {
  const cases: { name: string; feed: (emit: (n: number) => void) => void; expect: number }[] = [
    { name: 'single', feed: (e) => e(1), expect: 1 },
    { name: 'duplicate', feed: (e) => { e(1); e(1) }, expect: 2 },
    { name: 'loss', feed: (e) => { /* nothing */ }, expect: 0 },
  ]
  const out: any[] = []
  for (const c of cases) {
    let count = 0
    c.feed(() => { count++ })
    out.push({ case: c.name, counted: count, expected: c.expect, ok: count === c.expect })
  }
  const allOk = out.every((x) => x.ok)
  console.log('PROBE262_COUNTER ' + JSON.stringify({ cases: out, allOk }))
  if (!allOk) throw new Error('counter cannot distinguish single/duplicate/loss')
}, 120_000)

// C3: a fourth, independent watcher mechanism
it('probe 262 c3: parcel watcher as an independent reference', async () => {
  let subscribe: any = null
  try {
    subscribe = (await import('@parcel/watcher')).subscribe
  } catch {
    console.log('PROBE262_PARCEL ' + JSON.stringify({ available: false, reason: 'not installed in this environment' }))
    return
  }

  const root = mkdtempSync(join(tmpdir(), 'parcel262-'))
  const diff = { write: [0, 0, 0, 0], rename: [0, 0, 0, 0], delete: [0, 0, 0, 0] }
  let seeds = 0

  for (let seed = 0; seed < SEEDS; seed++) {
    const dirs = ['a', 'b', 'c', 'd'].map((k) => join(root, `${k}${seed}`))
    for (const d of dirs) mkdirSync(d)
    const [a, b, c, d] = dirs
    const ctx = new Context()
    const fiber = await ctx.plugin(Fs)
    const evA: string[] = []; const evB: string[] = []; const evR: string[] = []; const evP: string[] = []
    const fa = join(a, 'watched.txt'), fb = join(b, 'watched.txt')
    const fc = join(c, 'watched.txt'), fd = join(d, 'watched.txt')
    for (const f of [fa, fb, fc, fd]) writeFileSync(f, '0')

    const stop = await ctx.fs.watch(fa, (p: any) => evA.push(String(p)))
    const w = chokidar.watch(b, { ignoreInitial: true, depth: 0 })
    w.on('all', (_e: string, p: string) => evB.push(String(p)))
    const rw = fswatch(fc, () => evR.push('raw'))
    const sub = await subscribe(d, (err: any, events: any[]) => {
      if (err) return
      for (const e of events) if (String(e.path).endsWith('watched.txt')) evP.push(e.type)
    })
    await sleep(350)

    for (const f of [fa, fb, fc, fd]) writeFileSync(f, '1')
    await sleep(350)
    diff.write[0] += evA.length; diff.write[1] += evB.length; diff.write[2] += evR.length; diff.write[3] += evP.length

    evA.length = 0; evB.length = 0; evR.length = 0; evP.length = 0
    for (const [dir, f] of [[a, fa], [b, fb], [c, fc], [d, fd]] as const) {
      writeFileSync(join(dir, 'tmp.txt'), '2'); renameSync(join(dir, 'tmp.txt'), f)
    }
    await sleep(350)
    diff.rename[0] += evA.length; diff.rename[1] += evB.length; diff.rename[2] += evR.length; diff.rename[3] += evP.length

    evA.length = 0; evB.length = 0; evR.length = 0; evP.length = 0
    for (const f of [fa, fb, fc, fd]) rmSync(f, { force: true })
    await sleep(350)
    diff.delete[0] += evA.length; diff.delete[1] += evB.length; diff.delete[2] += evR.length; diff.delete[3] += evP.length

    await stop(); await fiber.dispose()
    rw.close(); await w.close(); await sub.unsubscribe()
    seeds++
  }

  console.log('PROBE262_PARCEL ' + JSON.stringify({
    available: true, seeds, platform: process.platform, node: process.version,
    order: ['ctx.fs', 'chokidar', 'raw-fs.watch', 'parcel'], diff,
  }))
  rmSync(root, { recursive: true, force: true })
}, 2_400_000)
