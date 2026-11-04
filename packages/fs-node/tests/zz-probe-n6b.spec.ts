// N6b probe: was the 7-of-720 macOS shortfall a lost event, or a late one?
//
// The N6 probe gives each seed a fixed 500 ms window:
//   write 'v1' -> sleep(500) -> stop() -> push(n)
// An event that arrives at 520 ms is therefore recorded as n = 0, which reads
// as "lost" but is really "late". Those are different defects and only one of
// them is the driver's.
//
// This probe replaces the fixed sleep with a wait that stops on the first event
// and gives up after a much larger ceiling, and it records the arrival latency
// per seed. Then:
//
//   latencies all < 500 ms  -> the fixed window was never the cause; loss is real
//   some latencies > 500 ms -> the earlier zero was the probe's window, not the driver
//   some seeds never deliver-> loss is real, and now measured with a 5 s ceiling
//
// It is log-only: the reading is the point, not a pass/fail on a platform.
import { describe, it } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const SEEDS = 60
// The old probe's window, kept as a constant so the comparison is explicit.
const OLD_WINDOW_MS = 500
// The ceiling this probe allows. A seed that never delivers inside this is
// treated as a loss, not as a lateness.
const CEILING_MS = 5000
const POLL_MS = 10

describe('N6b: per-seed arrival latency, adaptive window', () => {
  it('records when the event arrives instead of assuming 500 ms is enough', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe262-n6b-'))
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')

    const rows: Array<{ i: number; n: number; ms: number | null }> = []

    try {
      for (let i = 0; i < SEEDS; i++) {
        const f = join(dir, `s${i}.txt`)
        writeFileSync(f, 'v0')
        let n = 0
        let firstAt = 0
        const stopSeed = await fs.watch(f, () => {
          n++
          if (n === 1) firstAt = Date.now()
        })

        const writtenAt = Date.now()
        writeFileSync(f, 'v1')

        // Wait for the event, or give up at the ceiling. Polling keeps the
        // common case cheap: a delivered seed costs about one poll interval.
        while (n === 0 && Date.now() - writtenAt < CEILING_MS) {
          await sleep(POLL_MS)
        }
        // A short grace so a second event for the same write is also counted;
        // without it, `n` would almost always read 1 and hide the doubling.
        await sleep(120)
        stopSeed()

        rows.push({ i, n, ms: firstAt ? firstAt - writtenAt : null })
      }

      const lost = rows.filter((r) => r.n === 0)
      const doubled = rows.filter((r) => r.n > 1)
      // What the old probe would have recorded, derived from the same latencies.
      const lateUnderOldWindow = rows.filter((r) => r.ms !== null && r.ms > OLD_WINDOW_MS)
      const wouldBeZeroUnderOld = rows.filter((r) => r.n === 0 || (r.ms !== null && r.ms > OLD_WINDOW_MS))

      const latencies = rows.filter((r) => r.ms !== null).map((r) => r.ms as number)
      latencies.sort((a, b) => a - b)
      const pct = (q: number) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : null

      console.log('ADJ_N6B_SUMMARY =', JSON.stringify({
        seeds: SEEDS,
        ceiling_ms: CEILING_MS,
        old_window_ms: OLD_WINDOW_MS,
        delivered: rows.filter((r) => r.n > 0).length,
        lost: lost.length,
        doubled: doubled.length,
        late_beyond_old_window: lateUnderOldWindow.length,
        would_be_zero_under_old_window: wouldBeZeroUnderOld.length,
        latency_ms: {
          n: latencies.length,
          min: latencies.length ? latencies[0] : null,
          p50: pct(0.5),
          p90: pct(0.9),
          p99: pct(0.99),
          max: latencies.length ? latencies[latencies.length - 1] : null,
        },
      }))

      // Per-seed rows, so the distribution and the two anomalies stay auditable.
      console.log('ADJ_N6B_ROWS =', JSON.stringify(rows))
      // The ones that decide the question, spelled out.
      console.log('ADJ_N6B_LOST =', JSON.stringify(lost))
      console.log('ADJ_N6B_LATE =', JSON.stringify(lateUnderOldWindow))

      // Log-only: this probe never decides pass/fail for the build.
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  // The N6 probe puts all 60 seeds in ONE directory, so seed 59 is watched in a
  // directory holding 59 other files. A growing directory is a probe artefact,
  // not a property of the driver: if the shortfall only appears there, the
  // driver was never at fault.
  it('compares a shared directory against a fresh directory per seed', async () => {
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')
    const base = mkdtempSync(join(tmpdir(), 'probe262-n6c-'))

    const arm = async (freshDirPerSeed: boolean) => {
      const counts: number[] = []
      const lats: Array<number | null> = []
      try {
        for (let i = 0; i < SEEDS; i++) {
          const dir = freshDirPerSeed
            ? mkdtempSync(join(base, 'd'))
            : base
          const f = join(dir, `s${i}.txt`)
          writeFileSync(f, 'v0')
          let n = 0
          let firstAt = 0
          const stop = await fs.watch(f, () => {
            n++
            if (n === 1) firstAt = Date.now()
          })
          const writtenAt = Date.now()
          writeFileSync(f, 'v1')
          while (n === 0 && Date.now() - writtenAt < CEILING_MS) {
            await sleep(POLL_MS)
          }
          await sleep(120)
          stop()
          counts.push(n)
          lats.push(firstAt ? firstAt - writtenAt : null)
        }
      } finally {
        // nothing: base is removed below
      }
      return { counts, lats }
    }

    try {
      const shared = await arm(false)
      const fresh = await arm(true)
      const summarise = (r: { counts: number[]; lats: Array<number | null> }) => ({
        lost: r.counts.filter((c) => c === 0).length,
        doubled: r.counts.filter((c) => c > 1).length,
        p50_latency: (() => {
          const v = r.lats.filter((x): x is number => x !== null).sort((a, b) => a - b)
          return v.length ? v[Math.floor(v.length / 2)] : null
        })(),
        max_latency: (() => {
          const v = r.lats.filter((x): x is number => x !== null)
          return v.length ? Math.max(...v) : null
        })(),
      })
      console.log('ADJ_N6C_SHARED_DIR =', JSON.stringify(summarise(shared)))
      console.log('ADJ_N6C_FRESH_DIR =', JSON.stringify(summarise(fresh)))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 300_000)
})
