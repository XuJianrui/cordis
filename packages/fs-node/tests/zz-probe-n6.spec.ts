// N6 probe: does one write produce more than one event, and what key dedupes it?
//
// The proposal says "a sequence number now: it dedupes the macOS double change".
// A per-event counter cannot dedupe by itself: two events for one write get two
// different numbers. This probe records, for each event, the path, wall time,
// mtime and size, and compares three keys:
//   - index (what a per-event sequence number would give)  -> never dedupes
//   - (path, mtimeMs, size)                                -> dedupes if stable
//   - (path, floor(time / window))                          -> the debounce fallback
//
// It is log-only: the point is the reading, not a pass/fail on a platform.
import { describe, it, expect } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('N6: one write, event count and dedupe keys (local or CI)', () => {
  it('records event metadata and a 60-seed delivery grid', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe262-n6-'))
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')

    try {
      // --- one write, full metadata ---
      const file = join(dir, 'one.txt')
      writeFileSync(file, 'v0')
      const events: any[] = []
      const stop = await fs.watch(file, (p: string) => {
        const st = statSync(file, { throwIfNoEntry: false })
        events.push({ p, t: Date.now(), mtimeMs: st?.mtimeMs ?? null, size: st?.size ?? null })
      })
      writeFileSync(file, 'v1')
      await sleep(1200)
      stop()

      const byMeta = new Set(events.map((e) => `${e.p}|${e.mtimeMs}|${e.size}`))
      const byIndex = new Set(events.map((e, i) => `${e.p}|${i}`))
      const byWindow = new Set(events.map((e) => `${e.p}|${Math.floor(e.t / 100)}`))
      console.log('ADJ_N6_EVENTS =', events.length)
      console.log('ADJ_N6_KEYS_META =', byMeta.size)
      console.log('ADJ_N6_KEYS_INDEX =', byIndex.size)
      console.log('ADJ_N6_KEYS_WINDOW100 =', byWindow.size)
      console.log('ADJ_N6_META =', JSON.stringify(events))

      // --- 60 seeds, fresh watcher per seed, one write each ---
      let delivered = 0
      const counts: number[] = []
      for (let i = 0; i < 60; i++) {
        const f = join(dir, `s${i}.txt`)
        writeFileSync(f, 'v0')
        let n = 0
        const stopSeed = await fs.watch(f, () => { n++ })
        writeFileSync(f, 'v1')
        await sleep(500)
        stopSeed()
        counts.push(n)
        if (n > 0) delivered++
      }
      console.log('ADJ_N6_SEEDS =', JSON.stringify({ delivered, n: 60, counts }))

      // Log-only: the reading is the point, not a platform pass/fail.
      expect(events.length).toBeGreaterThanOrEqual(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})