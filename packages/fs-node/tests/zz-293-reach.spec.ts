import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

// What `ignored` is asked, and what it answers, when a file becomes a link to
// a directory.
//
// `#293` changes the answer for a call without stats. That call is the one
// `_addToNodeFs` makes before it stats, and a "true" there ends the path for
// the rest of the watch. Whether the change matters therefore comes down to a
// question with a countable answer: how many times is `ignored` called without
// stats, and on which paths?
//
// Three counts are recorded per round:
//   `noStats`  — a call without stats, which `#293` answers differently
//   `onLinked` — a call on the linked path itself, the one that can end it
//   `verdict`  — what the predicate said on the linked path without stats
//
// If `onLinked` is zero, the call `#293` changes never happens on this path and
// the defect, however real, cannot be reached from here.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__ign293__')
const ROUNDS = Number(process.env.IGN_ROUNDS || 20)

interface Tally {
  noStats: number
  onLinked: number
  verdicts: string[]
}

const tally: Tally = { noStats: 0, onLinked: 0, verdicts: [] }
;(globalThis as any).__IGN = tally

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  return {
    ...actual,
    watch: (path: string, options: any) => {
      const inner = options?.ignored
      return actual.watch(path, {
        ...options,
        ignored: (candidate: string, stats?: any) => {
          const t = (globalThis as any).__IGN as Tally
          const full = resolve(candidate)
          const isLinked = full.endsWith('/linked')
          const verdict = inner ? inner(candidate, stats) : false
          if (!stats) {
            t.noStats++
            if (isLinked) {
              t.onLinked++
              t.verdicts.push(String(verdict))
            }
          }
          return verdict
        },
      })
    },
  }
})

const Fs = (await import('../src/index.ts')).default

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

describe('#293: is the changed call reachable', () => {
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

      // from here on, only calls made after the replacement are of interest
      tally.noStats = 0
      tally.onLinked = 0
      tally.verdicts = []

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let outcome = 'pass'
      try {
        await touch(target, () => seen.length)
      } catch {
        outcome = 'timeout'
      }
      await new Promise(r => setTimeout(r, 300))

      const verdicts = [...new Set(tally.verdicts)].join('/') || '-'
      console.log(`@@IGN ${index} ${outcome} noStats=${tally.noStats} onLinked=${tally.onLinked} verdict=${verdicts}@@`)

      await fiber.dispose()
      expect(outcome).to.equal('pass')
    }, 20000)
  }
})
