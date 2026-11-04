// N6d probe: does a settle delay after `await watch()` remove the macOS loss?
//
// What the previous probes ruled out (all measured, not assumed):
//   - a late event:  n6b latencies are p50 9 ms, p99 15 ms, max 15 ms, so a
//                    500 ms window closes 33x after the slowest arrival
//   - a growing dir: n6c shared-dir arm lost 0, fresh-dir-per-seed arm lost 1
//   - cold start:    n6 losses sit at seed 10..51, none at seed <= 5
//   - a registration race in the driver: `watch()` awaits chokidar's `ready`
//
// That leaves one candidate: on macOS chokidar uses FSEvents, and `ready`
// reports that the initial scan is done — not that the kernel subscription has
// stabilised. A write landing in that gap is never delivered at all.
//
// The test is to widen that gap deliberately and see whether the loss goes:
//
//   settle 0 ms   -> reproduces the n6 shape
//   settle 25 ms  -> loss shrinks
//   settle 100 ms -> loss gone
//
// If the loss is unchanged at 100 ms, the settle-window hypothesis is wrong and
// must be withdrawn rather than reworded.
import { describe, it } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const SEEDS = 60
const CEILING_MS = 3000
const POLL_MS = 5
const SETTLES = [0, 25, 100]

describe('N6d: does a settle delay after watch() remove the loss', () => {
  it('runs the same grid at three settle delays', async () => {
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')
    const base = mkdtempSync(join(tmpdir(), 'probe262-n6d-'))

    try {
      for (const settle of SETTLES) {
        const counts: number[] = []
        const lats: Array<number | null> = []

        for (let i = 0; i < SEEDS; i++) {
          const f = join(base, `t${settle}-${i}.txt`)
          writeFileSync(f, 'v0')
          let n = 0
          let firstAt = 0
          const stop = await fs.watch(f, () => {
            n++
            if (n === 1) firstAt = Date.now()
          })

          // The only thing that changes between arms.
          if (settle > 0) await sleep(settle)

          const writtenAt = Date.now()
          writeFileSync(f, 'v1')
          while (n === 0 && Date.now() - writtenAt < CEILING_MS) {
            await sleep(POLL_MS)
          }
          await sleep(100)
          stop()
          counts.push(n)
          lats.push(firstAt ? firstAt - writtenAt : null)
        }

        const delivered = counts.filter((c) => c > 0).length
        const sorted = lats.filter((x): x is number => x !== null).sort((a, b) => a - b)
        console.log('ADJ_N6D_ARM =', JSON.stringify({
          settle_ms: settle,
          seeds: SEEDS,
          delivered,
          lost: SEEDS - delivered,
          doubled: counts.filter((c) => c > 1).length,
          lost_indices: counts.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0),
          latency_ms: {
            n: sorted.length,
            p50: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
            p99: sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : null,
            max: sorted.length ? sorted[sorted.length - 1] : null,
          },
          counts,
        }))
      }
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 600_000)
})
