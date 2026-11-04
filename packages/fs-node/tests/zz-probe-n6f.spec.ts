// N6f probe: what IS the extra event that survives `ignoreInitial`?
//
// The issue states, as current behaviour: "The returned handle resolves once the
// initial scan is done." n6e measured 58/60 and 59/60 seeds receiving an event
// for a write made BEFORE `watch()` was called, which reads as if that sentence
// is optimistic on macOS. But n6e counted anonymously — `n++` — so it cannot say
// what the event was, or which path it carried. Three candidates survive:
//
//   S1  the pre-registration write's own `add`, slipping past ignoreInitial
//   S2  the PARENT DIRECTORY's `change`: the driver's `ignored` lets `path ===
//       root` through, and writing a file bumps the directory's mtime
//   S3  a leftover watcher, delivering some other file's event
//
// They are separated by two things at once:
//
//   - the path each callback receives: the file means S1, the directory means
//     S2, anything else means S3
//   - a cold arm that waits 1500 ms after the setup write before registering,
//     so S1's event has already happened and cannot still be queued
//
// Reading the result:
//
//   hot leaks, cold does not                -> S1
//   both leak, path = the parent directory  -> S2
//   path is neither the file nor the dir    -> S3
import { describe, it } from 'vitest'
import { Context } from '../../core/src/index.ts'
import Fs from '../src/index.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const SEEDS = 40
const SETTLE_MS = 300
const COLD_MS = 1500
const MEASURE_TIMEOUT_MS = 3000

type Kind = 'file' | 'dir' | 'other'

interface Row {
  i: number
  preKinds: Kind[]
  prePaths: string[]
  measured: number
  measuredPath: string | null
}

describe('N6f: identify the event that survives ignoreInitial', () => {
  it('compares a hot registration against a cold one, recording event paths', async () => {
    const ctx = new Context()
    await ctx.plugin(Fs)
    const fs: any = ctx.get('fs')
    const base = mkdtempSync(join(tmpdir(), 'probe262-n6f-'))

    const runArm = async (label: string, cold: boolean) => {
      const rows: Row[] = []

      for (let i = 0; i < SEEDS; i++) {
        // One directory per seed, so S3 cannot be confused with a sibling.
        const dir = join(base, `${label}-${i}`)
        mkdirSync(dir, { recursive: true })
        const f = join(dir, 'a.txt')
        const expectedFile = resolve(f)
        const expectedDir = resolve(dir)

        writeFileSync(f, 'v0')
        if (cold) await sleep(COLD_MS)

        let phase: 'pre' | 'measured' = 'pre'
        const prePaths: string[] = []
        let measured = 0
        let measuredPath: string | null = null

        const stop = await fs.watch(f, (p: string) => {
          const abs = resolve(p)
          if (phase === 'pre') {
            prePaths.push(abs)
          } else {
            measured++
            if (!measuredPath) measuredPath = abs
          }
        })

        await sleep(SETTLE_MS)
        const captured = [...prePaths]
        phase = 'measured'

        const t0 = Date.now()
        writeFileSync(f, 'v1')
        while (measured === 0 && Date.now() - t0 < MEASURE_TIMEOUT_MS) await sleep(5)
        await sleep(150)
        stop()

        rows.push({
          i,
          prePaths: captured,
          preKinds: captured.map((p) =>
            p === expectedFile ? 'file' : p === expectedDir ? 'dir' : 'other'
          ) as Kind[],
          measured,
          measuredPath,
        })
      }

      const leaked = rows.filter((r) => r.preKinds.length > 0)
      const kinds: Record<Kind, number> = { file: 0, dir: 0, other: 0 }
      for (const r of leaked) for (const k of r.preKinds) kinds[k]++

      console.log(`ADJ_N6F_${label.toUpperCase()} =`, JSON.stringify({
        arm: label,
        cold,
        seeds: SEEDS,
        settle_ms: SETTLE_MS,
        cold_ms: cold ? COLD_MS : 0,
        seeds_with_pre_reset_event: leaked.length,
        pre_reset_kind_tally: kinds,
        measured_delivered: rows.filter((r) => r.measured > 0).length,
        measured_doubled: rows.filter((r) => r.measured > 1).length,
        sample: leaked.slice(0, 3).map((r) => ({
          i: r.i,
          kinds: r.preKinds,
          tail: r.prePaths.map((p) => p.slice(-24)),
        })),
      }))

      return { leaked: leaked.length, kinds, delivered: rows.filter((r) => r.measured > 0).length }
    }

    try {
      const hot = await runArm('hot', false)
      const cold = await runArm('cold', true)

      const reading =
        cold.leaked === 0 && hot.leaked > 0
          ? 'S1: the pre-registration write; a cold start removes it'
          : cold.leaked > 0 && hot.kinds.dir > 0
            ? 'S2: the parent directory change; it survives a cold start'
            : cold.leaked > 0 && hot.kinds.other > 0
              ? 'S3: another path entirely'
              : 'inconclusive: both arms agree, nothing to separate'

      console.log('ADJ_N6F_VERDICT =', JSON.stringify({
        hot_leaked: hot.leaked,
        hot_kinds: hot.kinds,
        cold_leaked: cold.leaked,
        cold_kinds: cold.kinds,
        reading,
      }))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 600_000)
})
