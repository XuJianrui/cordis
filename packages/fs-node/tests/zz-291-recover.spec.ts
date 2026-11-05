import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs from '../src/index.ts'

// Whether a watch that has gone silent can be brought back by ending it and
// starting a new one.
//
// The case is the spec's own: the two directories are created once, and only
// `linked` is replaced, so the rate this reports is the case's rate and not an
// artefact of the harness. A round that sees no event within 4 s of writes
// counts as silent — every delivery measured on this shape so far arrived
// within 490 ms, so 4 s is not a tight budget.
//
// A silent round then gets a fresh watcher on the same root. If the replacement
// watch sees events, a consumer can repair the state by recreating the watch;
// if it does not, the state survives a new watch and no consumer-side retry can
// clear it.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__recover291__')
const ROUNDS = 40
const BUDGET = 40

const target = resolve(fixture, 'relinked/target/file.ts')
const link = resolve(fixture, 'relinked/root/linked')

async function frame() {
  const root = new Context()
  root.baseUrl = import.meta.url
  const fiber: Fiber<Context> = await root.plugin(Fs)
  let ctx!: Context
  await root.inject(['fs'], (inner) => { ctx = inner })
  const seen: string[] = []
  const watcher = ctx.fs.watch(dirname(link), { filter: ['linked/**/*.ts'] })
  watcher.on('change', (filename: string) => seen.push(filename))
  await new Promise<void>((done) => watcher.on('ready', done))
  return { fiber, seen }
}

async function writes(path: string, count: number) {
  for (let i = 0; i < count; i++) {
    writeFileSync(path, `v${i}`)
    if (i + 1 < count) await new Promise(r => setTimeout(r, 100))
  }
}

describe('relink, whether a new watch recovers', () => {
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

      const first = await frame()
      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')
      await writes(target, BUDGET)
      const before = first.seen.length
      await first.fiber.dispose()

      if (before > 0) {
        console.log(`@@RC ${index} p1=${before} p2=- rec=-@@`)
        return
      }

      // the first watch saw nothing: try a new one on the same root
      const second = await frame()
      await writes(target, BUDGET)
      const after = second.seen.length
      await second.fiber.dispose()
      console.log(`@@RC ${index} p1=0 p2=${after} rec=${after > 0}@@`)
    }, 30000)
  }
})
