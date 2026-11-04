import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

// Where the relink round stops, measured at three separate layers.
//
// The previous probe recorded chokidar's normalized events (`add`, `change`,
// `unlink`, ...). Those are what chokidar decided to report, not what the
// platform reported — and the two differ exactly where this case is in
// question. `raw` is emitted from inside the `fs.watch` callback, before any
// filtering, so it is the layer that can settle whether the platform went
// silent.
//
// Three things are recorded per round, at the three layers of the chain:
//
//   production    `raw`    — what fs.watch handed to chokidar
//   distribution  `read`   — whether a rescan ran or was dropped by the
//                            `readdir` throttle, and which paths were re-watched
//   consumption   `all`    — what chokidar reported to this package
//
// A round that fails with `raw=0` stopped in production. A round that fails
// with `raw` present but no rescan stopped in distribution. A round that fails
// with a rescan and a watch on the file stopped in consumption.

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

      watcher.on('raw', (event: string, p: string) => {
        rec.raw.push(`${event}`)
      })
      watcher.on('all', (event: string, p: string) => {
        rec.all.push(`${event}`)
      })

      // `_handleRead` and `_watchWithNodeFs` live on `NodeFsHandler`, not on
      // `FSWatcher`; a tap on the latter records nothing and reads as silence.
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
          rec.watch.push(resolve(target).replace(/.*__arm291f__[^/]*\//, ''))
          return watchFs.call(this, target, ...rest)
        }
      }
      return watcher
    },
  }
})

const Fs = (await import('../src/index.ts')).default

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__arm291f__')
const ROUNDS = Number(process.env.SAME_ROUNDS || 40)

function write(name: string, content = '') {
  const path = resolve(fixture, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

async function touch(path: string, cond: () => unknown) {
  for (let i = 0; !cond(); i++) {
    if (i >= 80) throw new Error('touch timed out')
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

const count = (list: string[]) => [...new Set(list)].reduce((acc, k) => {
  acc[k] = (acc[k] || 0) + 1
  return acc
}, {} as Record<string, number>)

const show = (obj: Record<string, number>) =>
  Object.entries(obj).map(([k, v]) => `${k}x${v}`).join(',') || '-'

describe('relink, three layers', () => {
  beforeEach(() => { rmSync(fixture, { recursive: true, force: true }) })
  afterEach(() => { rmSync(fixture, { recursive: true, force: true }) })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      const target = write('relinked/target/file.ts')
      const link = write('relinked/root/linked')

      const root = new Context()
      root.baseUrl = import.meta.url
      const fiber: Fiber<Context> = await root.plugin(Fs)
      let ctx!: Context
      await root.inject(['fs'], (inner) => { ctx = inner })

      const seen: string[] = []
      const watcher = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
      watcher.on('change', (filename: string) => seen.push(filename))
      await new Promise<void>(done => watcher.on('ready', done))

      rec.raw = []
      rec.read = []
      rec.watch = []
      rec.all = []

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let outcome = 'pass'
      try {
        await touch(target, () => seen.length)
      } catch {
        outcome = 'timeout'
      }
      await new Promise(r => setTimeout(r, 300))

      const reads = count(rec.read)
      console.log([
        `@@R ${index} ${outcome}`,
        `raw=${rec.raw.length}:${show(count(rec.raw))}`,
        `read=${show(reads)}`,
        `watch=${rec.watch.length}:${[...new Set(rec.watch)].join('/') || '-'}`,
        `all=${show(count(rec.all))}@@`,
      ].join(' '))

      await fiber.dispose()
      expect(outcome).to.equal('pass')
    }, 20000)
  }
})
