/* eslint-disable */
// Measure the measurement. Three probes disagreed on the same case body:
//
//   in-file loop, reusing one warm context     20/20
//   isolated, extra directory level            319/320
//   isolated, one level up                      ~50% timeout on macOS
//
// A 50-point spread across three runs of the same case is bigger than the effect
// being studied, so before another conclusion: run the variants side by side, in
// one process, alternating round by round. Same machine, same jitter, same load.
//
// Four variants, each isolating one thing:
//
//   deep    base/r{n}/relinked/root/linked      the layout probe B used
//   flat    base/relinked/root/linked           the layout probe C used
//   warm    reuses one context across rounds    what the in-file loop did
//   cold    a fresh context each round          what watch.spec.ts does
//
// If a 50-point gap survives alternating them here, it is real and one of these
// four is the cause. If the gap collapses, the earlier numbers were run-to-run
// drift and none of them can be quoted.
import { describe, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context, Fiber } from 'cordis'
import Fs from '../src/index.ts'

const ROUNDS = 15
const BLOCKS = 3

type Variant = 'deep' | 'flat' | 'warm' | 'cold'

async function attempt(ctx: Context, base: string, extra: string) {
  const target = join(base, extra, 'relinked/target/file.ts')
  const link = join(base, extra, 'relinked/root/linked')
  mkdirSync(dirname(target), { recursive: true })
  mkdirSync(dirname(link), { recursive: true })
  writeFileSync(target, 'v0')
  writeFileSync(link, 'v0')

  const seen: string[] = []
  const w = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
  w.on('change', (p: string) => seen.push(p))
  await new Promise<void>((r) => w.on('ready', r))
  rmSync(link)
  symlinkSync(dirname(target), link, 'junction')

  let exhausted = true
  for (let i = 0; i < 80; i++) {
    if (seen.length > 0) { exhausted = false; break }
    writeFileSync(target, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
  const got = [...new Set(seen)]
  const want = resolve(link, 'file.ts')
  const outcome = exhausted ? 'timeout'
    : got.length === 1 && resolve(got[0]) === want ? 'pass' : 'wrongPath'
  await w.dispose()
  rmSync(join(base, extra), { recursive: true, force: true })
  return outcome
}

describe('290 measure the measurement', () => {
  it('four variants, alternating, three blocks', async () => {
    let warmCtx: Context | null = null
    let warmFiber: Fiber<Context> | null = null
    const out: Record<string, string[]> = { deep: [], flat: [], warm: [], cold: [] }

    for (let b = 0; b < BLOCKS; b++) {
      for (const v of ['deep', 'flat', 'warm', 'cold'] as Variant[]) {
        let pass = 0
        let timeout = 0
        for (let i = 0; i < ROUNDS; i++) {
          const base = mkdtempSync(join(tmpdir(), `mm290-${v}-${b}-${i}-`))
          let ctx: Context
          let owned: Fiber<Context> | null = null
          if (v === 'warm') {
            if (!warmCtx) {
              warmCtx = new Context()
              warmFiber = await warmCtx.plugin(Fs)
            }
            ctx = warmCtx
          } else {
            ctx = new Context()
            owned = await ctx.plugin(Fs)
          }
          const extra = v === 'deep' ? `r${i}` : '.'
          const r = await attempt(ctx, base, extra)
          if (r === 'pass') pass++
          else timeout++
          if (owned) await owned.dispose()
          rmSync(base, { recursive: true, force: true })
        }
        out[v].push(`${pass}/${ROUNDS}`)
        void timeout
      }
    }
    if (warmFiber) await (warmFiber as Fiber<Context>).dispose()
    console.log('PROBE_290_META =', JSON.stringify({ platform: process.platform, out }))
  }, 900_000)
})
