// N6e probe: isolate the measured write from the registration-time write.
//
// n6d was confounded and is retracted. It added `settle` between `watch()` and
// the measured write, and counted every event:
//
//   writeFileSync(f, 'v0')          <- setup
//   await fs.watch(f, () => n++)    <- registration
//   await sleep(settle)             <- n6d added this
//   writeFileSync(f, 'v1')          <- the write under test
//
// At settle = 25 or 100 ms the counts doubled and the recorded latency went
// NEGATIVE (p50 -17 ms, -23 ms, -94 ms). A negative latency means the callback
// ran before the measured write, so those events came from the setup write.
// With settle = 0 they had no time to arrive, so they were absent.
//
// That is a defect in the probe, and it is also a real observation: chokidar's
// `ignoreInitial: true` does not reliably suppress an event for a write that
// happened just before registration. It is the same condition the TLA model
// calls ClearMode = "uncleared", where AtMostOnePerWrite is violated.
//
// So this probe separates the two by construction:
//
//   1. setup write, register, settle long enough for any setup event to land
//   2. RESET the counter  <- discards the setup event instead of counting it
//   3. measured write, then wait for one event
//
// With the counter reset, `n` can only come from the measured write. If a seed
// still reads 0, the event was genuinely not delivered, and the settle delay
// is no longer a confounder.
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
// Long enough for a setup-write event to have arrived (n6b measured p99 = 15 ms,
// max 203 ms), so the reset below throws away a settled stream, not a pending one.
const SETTLE_MS = 300

describe('N6e: delivery of the measured write only', () => {
  it('resets the counter after settling, so setup events cannot be counted', async () => {
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')
    const base = mkdtempSync(join(tmpdir(), 'probe262-n6e-'))

    try {
      const counts: number[] = []
      const setupEvents: number[] = []
      const lats: Array<number | null> = []

      for (let i = 0; i < SEEDS; i++) {
        const f = join(base, `s${i}.txt`)
        writeFileSync(f, 'v0')
        let n = 0
        let firstAfterReset = 0
        const stop = await fs.watch(f, () => { n++ })

        // Let any setup-write event arrive, then throw it away.
        await sleep(SETTLE_MS)
        setupEvents.push(n)
        n = 0

        const writtenAt = Date.now()
        writeFileSync(f, 'v1')
        while (n === 0 && Date.now() - writtenAt < CEILING_MS) {
          await sleep(POLL_MS)
        }
        if (n > 0) firstAfterReset = Date.now()
        // Grace, so a second delivery for the measured write is still counted.
        await sleep(150)
        stop()

        counts.push(n)
        lats.push(firstAfterReset ? firstAfterReset - writtenAt : null)
      }

      const lost = counts.map((c, i) => (c === 0 ? i : -1)).filter((i) => i >= 0)
      const sorted = lats.filter((x): x is number => x !== null).sort((a, b) => a - b)
      console.log('ADJ_N6E_SUMMARY =', JSON.stringify({
        seeds: SEEDS,
        settle_ms: SETTLE_MS,
        ceiling_ms: CEILING_MS,
        delivered: counts.filter((c) => c > 0).length,
        lost: lost.length,
        lost_indices: lost,
        doubled: counts.filter((c) => c > 1).length,
        // How often the setup write leaked an event before the reset. This is the
        // ignoreInitial window, measured directly rather than inferred.
        setup_event_leaked: setupEvents.filter((c) => c > 0).length,
        setup_event_counts: setupEvents,
        latency_ms: {
          n: sorted.length,
          min: sorted.length ? sorted[0] : null,
          p50: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
          p99: sorted.length ? sorted[Math.floor(sorted.length * 0.99)] : null,
          max: sorted.length ? sorted[sorted.length - 1] : null,
        },
        counts,
      }))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 300_000)
})
