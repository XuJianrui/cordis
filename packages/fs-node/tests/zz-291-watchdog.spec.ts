import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

// If `fs.watch` stops delivering, does replacing it help?
//
// The rounds that fail report `raw=0`: the `fs.watch` callback never fires once.
// Before a watchdog that closes and recreates the watch can be proposed as a
// fix, one thing has to be true — a fresh `fs.watch` on the same path has to
// work again. If the platform has stopped delivering for the whole path, a
// watcher that recreates itself recreates a dead watch.
//
// The probe never fails the round. It records, for every round:
//
//   raw     — whether the first watch delivered anything at all
//   rebuilt — whether `close()` + a fresh `watch()` on the same path delivered
//             afterwards, when the first one did not
//
// So a run where `raw` is sometimes 0 and `rebuilt` is always 1 says a watchdog
// is a fix. `rebuilt` 0 where `raw` 0 says the path stays dead and the fix has
// to be above the platform — a test that retries, or polling.

interface Probe {
  first: number
  rebuilt: number
}

const probe: Probe = { first: 0, rebuilt: 0 }

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  return {
    ...actual,
    watch: (path: string, options: any) => {
      const watcher = actual.watch(path, options)
      watcher.on('raw', () => { probe.first++ })
      return watcher
    },
  }
})

const Fs = (await import('../src/index.ts')).default
const chokidar = await import('chokidar')

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__wd291__')
const ROUNDS = Number(process.env.SAME_ROUNDS || 40)

const target = resolve(fixture, 'relinked/target/file.ts')
const link = resolve(fixture, 'relinked/root/linked')

function reset() {
  writeFileSync(target, '')
  rmSync(link, { recursive: true, force: true })
  writeFileSync(link, '')
}

async function touch(path: string, cond: () => unknown, tries = 10) {
  for (let i = 0; i < tries; i++) {
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
    if (cond()) return true
  }
  return cond() as boolean
}

describe('does a recreated watch deliver again', () => {
  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    mkdirSync(dirname(link), { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      reset()

      probe.first = 0
      probe.rebuilt = 0

      const root = new Context()
      root.baseUrl = import.meta.url
      const fiber: Fiber<Context> = await root.plugin(Fs)
      let ctx!: Context
      await root.inject(['fs'], (inner) => { ctx = inner })

      const seen: string[] = []
      const watcher = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
      watcher.on('change', (filename: string) => seen.push(filename))
      await new Promise<void>(done => watcher.on('ready', done))

      // the replacement, then a short write budget: a live watch reports well
      // inside it, so a round that has seen nothing here is the failing shape
      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')
      const alive = await touch(target, () => seen.length, 6)

      let rebuilt = '-'
      if (!alive) {
        // the watchdog's move: drop this watch and put a fresh one on the path
        await fiber.dispose()
        const again = chokidar.watch(dirname(link), { ignoreInitial: true, depth: 2 })
        const hits: string[] = []
        again.on('all', (event: string, p: string) => {
          if (String(p).endsWith('file.ts')) hits.push(event)
        })
        await new Promise<void>(done => again.once('ready', () => done()))
        rebuilt = String(await touch(target, () => hits.length, 10))
        await again.close()
      } else {
        await fiber.dispose()
      }

      console.log(`@@W ${index} first=${alive} raw=${probe.first} rebuilt=${rebuilt}@@`)
      // the round is data, not a pass/fail: a failing first watch is the point
    }, 20000)
  }
})
