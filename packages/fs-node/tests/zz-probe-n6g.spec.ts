// N6g probe: why does N6's first section read 1 while n6f's hot arm reads 2?
//
// Two measurements of nearly the same code disagree, and until that is settled
// nothing may be concluded about the issue's "resolves once the initial scan is
// done" sentence.
//
//   N6  §1:  writeFileSync(v0) -> await watch -> writeFileSync(v1) IMMEDIATELY
//            count every event for 1200 ms                    -> 1  (40/40 jobs)
//
//   n6f hot: writeFileSync(v0) -> await watch -> sleep 300 ms -> writeFileSync(v1)
//            count events in the 300 ms settle                -> 1 on macOS,
//            then 1 more for the measured write               -> 2 total
//
// Same platforms, same driver, same ignoreInitial. The only difference is the
// gap between registration and the second write. So the question is what a short
// gap does to two notifications for the same path:
//
//   H1  coalescing by time: with v1 microseconds after v0, chokidar merges the
//       two notifications into one; with 300 ms between them it cannot
//   H2  coalescing by identity: the two writes produce the same (size, mtime)
//       bucket, so the second looks like a duplicate of the first
//   H3  N6's own counting: §1 reads events.length once at the end, so a merged
//       stream and a single event are indistinguishable there
//
// Four arms, all recording path, size and mtime per event:
//
//   A  gap 0 ms,    v1 same size as v0      (N6 §1 exactly)
//   B  gap 0 ms,    v1 much larger          (separates H2 from H1)
//   C  gap 50 ms,   v1 same size
//   D  gap 300 ms,  v1 same size            (n6f hot exactly)
//
//   A=1, B=1, C=2, D=2   -> H1: time, not identity
//   A=1, B=2, C=1, D=2   -> H2: identity (size) is what merges them
//   A=2                  -> H3: N6 §1 was not measuring what it looked like
import { describe, it } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const SEEDS = 25
const OBSERVE_MS = 1200
const LARGE = 'v1-' + 'x'.repeat(512)

interface Ev {
  p: string
  dt: number          // ms after the gap elapsed (i.e. after v1 was written)
  size: number | null
  mtimeMs: number | null
}

const ARMS: Array<{ label: string; gap: number; body: string }> = [
  { label: 'A_gap0_same', gap: 0, body: 'v1' },
  { label: 'B_gap0_big', gap: 0, body: LARGE },
  { label: 'C_gap50_same', gap: 50, body: 'v1' },
  { label: 'D_gap300_same', gap: 300, body: 'v1' },
]

describe('N6g: reconcile N6 §1 (1 event) with n6f hot (2 events)', () => {
  it('separates coalescing-by-time from coalescing-by-identity', async () => {
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')
    const base = mkdtempSync(join(tmpdir(), 'probe262-n6g-'))

    try {
      for (const arm of ARMS) {
        const counts: number[] = []
        const stacked: number[] = []   // events that share a path with an earlier one
        const allSizes: Array<Array<number | null>> = []
        const samples: Ev[][] = []

        for (let i = 0; i < SEEDS; i++) {
          const dir = join(base, `${arm.label}-${i}`)
          mkdirSync(dir, { recursive: true })
          const f = join(dir, 'a.txt')

          writeFileSync(f, 'v0')
          const events: Ev[] = []
          // Declared before the watcher so a callback arriving before v1 cannot
          // hit the temporal dead zone; the gap is measured from here until v1.
          let t1 = Date.now()
          const stop = await fs.watch(f, (p: string) => {
            const st = statSync(f, { throwIfNoEntry: false })
            events.push({
              p: resolve(p),
              dt: Date.now() - t1,
              size: st?.size ?? null,
              mtimeMs: st?.mtimeMs ?? null,
            })
          })

          if (arm.gap > 0) await sleep(arm.gap)
          t1 = Date.now()
          writeFileSync(f, arm.body)
          await sleep(OBSERVE_MS)
          stop()

          counts.push(events.length)
          stacked.push(events.length - new Set(events.map((e) => e.p)).size)
          allSizes.push(events.map((e) => e.size))
          if (samples.length < 3) samples.push(events.map((e) => ({ ...e, p: e.p.slice(-18) })))
        }

        const hist: Record<string, number> = {}
        for (const c of counts) hist[String(c)] = (hist[String(c)] ?? 0) + 1

        console.log(`ADJ_N6G_${arm.label.toUpperCase()} =`, JSON.stringify({
          arm: arm.label,
          gap_ms: arm.gap,
          v1_size: arm.body.length,
          seeds: SEEDS,
          event_count_histogram: hist,
          mean_events: counts.reduce((a, b) => a + b, 0) / counts.length,
          seeds_with_2plus: counts.filter((c) => c >= 2).length,
          // distinct sizes observed in a run tell H2 apart from H1 directly
          distinct_size_sets: allSizes.map((s) => [...new Set(s)]).filter((s) => s.length > 1).length,
          samples,
        }))
      }

      // Cross-arm comparison, printed last so it is easy to read in the log.
      console.log('ADJ_N6G_VERDICT_HINT =', JSON.stringify({
        note: 'compare A/B/C/D mean_events and seeds_with_2plus above',
      }))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 600_000)
})
