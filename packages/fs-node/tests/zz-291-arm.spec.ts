import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs from '../src/index.ts'

// The relink case at its own paths, forty times, with the whole event stream
// recorded.
//
// Three of chokidar's events are compared: `change`, `add` and `unlink`.
// `watcher.ts` subscribes to `change` only, so if the platform ever reports the
// replacement as `unlink` + `add`, nothing is delivered and the round times out.
// Rounds are recorded as pass or timeout with the events they saw, so the
// failing rounds can be read rather than guessed at.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__arm291__')
const ROUNDS = Number(process.env.SAME_ROUNDS || 40)

interface Seen {
  change: string[]
  add: string[]
  unlink: string[]
  addDir: string[]
  unlinkDir: string[]
}

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

describe('relink, forty times, with the event stream', () => {
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

      const seen: Seen = { change: [], add: [], unlink: [], addDir: [], unlinkDir: [] }
      const watcher = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
      for (const name of ['change', 'add', 'unlink', 'addDir', 'unlinkDir'] as const) {
        watcher.on(name as any, (filename: string) => {
          seen[name].push(resolve(filename).replace(fixture, ''))
        })
      }
      await new Promise<void>(done => watcher.on('ready', done))

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let outcome = 'pass'
      try {
        await touch(target, () => seen.change.length)
      } catch {
        outcome = 'timeout'
      }
      await new Promise(r => setTimeout(r, 200))

      const summary = Object.entries(seen)
        .filter(([, paths]) => paths.length)
        .map(([name, paths]) => `${name}=${[...new Set(paths)].join(',')}`)
        .join(' ')
      console.log(`@@ROUND ${index} ${outcome} ${summary}@@`)

      await fiber.dispose()
      expect(outcome).to.equal('pass')
    }, 20000)
  }
})
