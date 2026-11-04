import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

// The spec's own fixture discipline, measured at three layers.
//
// `zz-291-three` recorded `raw`, the `readdir` rescan and the watches, but it
// cleared the whole fixture between rounds — which rebuilds `relinked/root` and
// is not what the spec does. This keeps the two directories for the whole run,
// so a failure here is the spec's failure and its `raw` count means something.
//
// `raw` is emitted inside the `fs.watch` callback, before chokidar filters or
// throttles anything. `read` is whether a rescan ran or was dropped by the
// 1 s `readdir` throttle. `watch` is which paths chokidar then put an fs.watch
// on. `all` is what reached this package.

interface Rec {
  raw: string[]
  read: string[]
  watch: string[]
  all: string[]
}

const rec: Rec = { raw: [], read: [], watch: [], all: [] }
;(globalThis as any).__REC = rec

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  return {
    ...actual,
    watch: (path: string, options: any) => {
      const watcher = actual.watch(path, options)
      watcher.on('raw', (event: string) => { rec.raw.push(event) })
      watcher.on('all', (event: string) => { rec.all.push(event) })

      const handler = (watcher as any)._nodeFsHandler
      if (handler) {
        const read = handler._handleRead
        handler._handleRead = function (...args: any[]) {
          const result = read.apply(this, args as any)
          rec.read.push(result === undefined ? 'dropped' : 'ran')
          return result
        }
        const watchFs = handler._watchWithNodeFs
        handler._watchWithNodeFs = function (target: string, ...rest: any[]) {
          rec.watch.push(resolve(target).replace(/.*__spec291f__[^/]*\//, ''))
          return watchFs.call(this, target, ...rest)
        }
      }
      return watcher
    },
  }
})

const Fs = (await import('../src/index.ts')).default

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__spec291f__')
const ROUNDS = Number(process.env.SAME_ROUNDS || 40)

const target = resolve(fixture, 'relinked/target/file.ts')
const link = resolve(fixture, 'relinked/root/linked')

async function touch(path: string, cond: () => unknown) {
  for (let i = 0; !cond(); i++) {
    if (i >= 80) throw new Error('touch timed out')
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

const tally = (list: string[]) => {
  const out: Record<string, number> = {}
  for (const k of list) out[k] = (out[k] || 0) + 1
  return Object.entries(out).map(([k, v]) => `${k}x${v}`).join(',') || '-'
}

describe('relink, spec fixture, three layers', () => {
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

      const seen: string[] = []
      const watcher = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
      watcher.on('change', (filename: string) => seen.push(filename))
      await new Promise<void>(done => watcher.on('ready', done))

      rec.raw = []; rec.read = []; rec.watch = []; rec.all = []

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let outcome = 'pass'
      try {
        await touch(target, () => seen.length)
      } catch {
        outcome = 'timeout'
      }
      await new Promise(r => setTimeout(r, 200))

      console.log(`@@F ${index} ${outcome} raw=${rec.raw.length}:${tally(rec.raw)} read=${tally(rec.read)} watch=${rec.watch.length}:${[...new Set(rec.watch)].join('/') || '-'} all=${tally(rec.all)}@@`)

      await fiber.dispose()
      expect(outcome).to.equal('pass')
    }, 15000)
  }
})
