import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

// Every event chokidar produces during a relink round, recorded from inside
// `watch()` rather than through `Watcher.on()`.
//
// `Watcher` registers only `change`, `ready` and `error` in `_hooks`, so asking
// it for `add` throws — the first version of this probe did exactly that and
// read 40/40 failures on every cell, which is the shape of a broken probe, not
// a broken product. Tapping chokidar directly avoids the question.
//
// `add` is the one that matters: a remove-and-recreate outside chokidar's
// 100 ms `atomic` window is reported as `unlink` + `add`, and `watcher.ts`
// subscribes to `change` only.

interface Log {
  events: string[]
}

const log: Log = { events: [] }
;(globalThis as any).__LOG = log

vi.mock('chokidar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('chokidar')>()
  return {
    ...actual,
    watch: (path: string, options: any) => {
      const watcher = actual.watch(path, options)
      watcher.on('all', (event: string, p: string) => {
        const l = (globalThis as any).__LOG as Log
        l.events.push(`${event}:${String(p).replace(/.*__arm291b__[^/]*\//, '')}`)
      })
      return watcher
    },
  }
})

const Fs = (await import('../src/index.ts')).default

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__arm291b__')
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

describe('relink, every event chokidar produced', () => {
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

      log.events = []
      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let outcome = 'pass'
      try {
        await touch(target, () => seen.length)
      } catch {
        outcome = 'timeout'
      }
      await new Promise(r => setTimeout(r, 400))

      const summary = [...new Set(log.events)].join(' ')
      console.log(`@@ROUND ${index} ${outcome} ${summary || '(no events)'}@@`)

      await fiber.dispose()
      expect(outcome).to.equal('pass')
    }, 20000)
  }
})
