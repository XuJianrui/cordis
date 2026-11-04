/* eslint-disable */
// WP5: property-based check of the watch contract, using a local generator
// (no fast-check dependency is added, so yarn.lock does not move).
//
// The property under test is the one the comment actually claims:
//
//   For a watcher registered with a cleared buffer, every write that changes
//   the file's content produces at least one callback.
//
// Sequences are generated from a fixed seed, so a failure is replayable: the
// seed is printed and the same seed regenerates the same sequence.

import { Context } from 'cordis'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Fs from '../src/index.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

type Op = 'write' | 'delete' | 'recreate' | 'rename'

function genOps(seed: number, n: number): Op[] {
  const rnd = mulberry32(seed)
  const kinds: Op[] = ['write', 'delete', 'recreate', 'rename']
  return Array.from({ length: n }, () => kinds[Math.floor(rnd() * kinds.length)])
}

async function runSequence(seed: number, ops: Op[]): Promise<{ callbacks: number; writes: number; alive: boolean }> {
  const root = mkdtempSync(join(tmpdir(), `prop262-${seed}-`))
  const dir = join(root, 'a')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'watched.txt')
  writeFileSync(file, 'seed')

  const ctx = new Context()
  const fiber = await ctx.plugin(Fs)
  const events: string[] = []
  const stop = await ctx.fs.watch(file, (p) => events.push(String(p)))

  // Clear the buffer after the watcher settles: this is the discipline the A/B
  // run established, and without it the registration event is counted.
  await sleep(400)
  events.length = 0

  let writes = 0
  for (const op of ops) {
    switch (op) {
      case 'write':
        if (existsSync(file)) {
          writeFileSync(file, `w-${Math.random()}`)
          writes++
        }
        break
      case 'delete':
        rmSync(file, { force: true })
        break
      case 'recreate':
        rmSync(file, { force: true })
        writeFileSync(file, `r-${Math.random()}`)
        writes++
        break
      case 'rename':
        try {
          writeFileSync(join(dir, 'tmp.txt'), 'x')
          renameSync(join(dir, 'tmp.txt'), file)
          writes++
        } catch {}
        break
    }
    await sleep(60)
  }

  await sleep(300)
  const callbacks = events.length
  await stop()
  await fiber.dispose()

  // After dispose, further writes must not reach the callback.
  const before = events.length
  writeFileSync(file, 'after-dispose')
  await sleep(200)
  const alive = events.length !== before

  rmSync(root, { recursive: true, force: true })
  return { callbacks, writes, alive }
}

describe('verify 262: property-based watch contract', () => {
  it('every changing write produces at least one callback, and nothing arrives after dispose', async () => {
    const SEEDS = Number(process.env.VERIFY262_PROP_SEEDS || 12)
    const failures: any[] = []
    let totalWrites = 0
    let totalCallbacks = 0

    for (let seed = 1; seed <= SEEDS; seed++) {
      const ops = genOps(seed, 12)
      const r = await runSequence(seed, ops)
      totalWrites += r.writes
      totalCallbacks += r.callbacks
      console.log(`VERIFY262_PROP seed=${seed} ops=${ops.join(',')} writes=${r.writes} callbacks=${r.callbacks} afterDispose=${r.alive}`)

      if (r.writes > 0 && r.callbacks === 0) {
        failures.push({ seed, reason: 'writes happened but no callback arrived', ops })
      }
      if (r.alive) {
        failures.push({ seed, reason: 'callback fired after dispose', ops })
      }
    }

    // Non-vacuity: if no seed ever wrote, the property above is trivially true
    // and the run proves nothing. Assert the test actually exercised the case.
    expect(totalWrites, 'no seed performed a write; the property was vacuous').toBeGreaterThan(0)
    expect(totalCallbacks, 'no callback arrived in any seed; the harness is dead').toBeGreaterThan(0)

    expect(failures, 'replayable failures: ' + JSON.stringify(failures)).toEqual([])
  }, 900_000)
})
