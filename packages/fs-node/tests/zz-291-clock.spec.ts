import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

// The case, timed. Every raw event is stamped with how long after the
// replacement it arrived; a round that fails records what arrived at all.
//
// Two shapes were seen so far and they were told apart only by the write
// budget, which is a property of the probe and not of the case:
//
//   long budget  (8 s)  -> failures report raw=0
//   short budget (0.6 s) -> failures report raw>0
//
// A clock separates them without a budget doing the separating. For every
// round this records:
//
//   changedAt  when the write that was delivered first landed
//   raw        the raw events with their arrival time and name
//   out        pass | late | none   -- late means it arrived, after the budget
//
// `late` is the shape that a retry — or a longer budget in the spec — fixes.
// `none` is the shape that only polling or a watchdog can address.

const ANSI = /\u001B\[[0-9;]*m/g

function stamp(start: bigint) {
  return Number((process.hrtime.bigint() - start) / 1000000n)
}

interface Ev { t: number; name: string }

const events: Ev[] = []
;(globalThis as any).__EV = events

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  return {
    ...actual,
    watch: (path: string, options: any) => {
      const watcher = actual.watch(path, options)
      watcher.on('raw', (name: string, p: string) => {
        const list = (globalThis as any).__EV as Ev[]
        list.push({ t: Number((globalThis as any).__T0 ? stamp((globalThis as any).__T0) : -1), name: `${name}:${String(p).split('/').pop()}` })
      })
      return watcher
    },
  }
})

const Fs = (await import('../src/index.ts')).default

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__clock291__')
const ROUNDS = Number(process.env.SAME_ROUNDS || 40)

const target = resolve(fixture, 'relinked/target/file.ts')
const link = resolve(fixture, 'relinked/root/linked')

describe('relink, with a clock', () => {
  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    mkdirSync(dirname(link), { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      writeFileSync(target, '')
      rmSync(link, { recursive: true, force: true })
      writeFileSync(link, '')

      const root = new Context()
      root.baseUrl = import.meta.url
      const fiber: Fiber<Context> = await root.plugin(Fs)
      let ctx!: Context
      await root.inject(['fs'], (inner) => { ctx = inner })

      const seen: number[] = []
      const watcher = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
      watcher.on('change', () => seen.push(Number((globalThis as any).__T0 ? stamp((globalThis as any).__T0) : -1)))
      await new Promise<void>(done => watcher.on('ready', done))

      events.length = 0
      const t0 = process.hrtime.bigint()
      ;(globalThis as any).__T0 = t0

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      // write until seen, up to the case's own 8 s budget
      let i = 0
      while (!seen.length && i < 80) {
        writeFileSync(target, `v${i}`)
        await new Promise(r => setTimeout(r, 100))
        i++
      }
      // give a late event a further 1.5 s to show up, so `late` is measurable
      if (!seen.length) await new Promise(r => setTimeout(r, 1500))

      const elapsed = stamp(t0)
      const firstChange = seen.length ? seen[0] : -1
      const rawSummary = events.map(e => `${e.t}ms:${e.name}`).join(' ') || '-'
      const outcome = firstChange >= 0 && firstChange <= 8000 ? 'pass' : firstChange >= 0 ? 'late' : 'none'

      console.log(`@@C ${index} ${outcome} change=${firstChange}ms rawN=${events.length} writes=${i} raw=${rawSummary}@@`)

      await fiber.dispose()
    }, 30000)
  }
})
