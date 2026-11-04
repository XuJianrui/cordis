import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs from '../src/index.ts'

// Does the round fail because the platform went silent, or because the next
// round reused the previous round's fs.watch handle?
//
// chokidar keeps a module-level `FsWatchInstances` keyed by the watched path:
//
//   let cont = FsWatchInstances.get(fullPath)
//   if (cont) { addAndConvert(cont, KEY_LISTENERS, listener) }   // reuse
//   else { watcher = createFsWatchInstance(...) }                // create
//
// A watcher that has been closed but not yet removed from that map leaves an
// entry behind, and the next watcher on the same path attaches to a handle that
// is already dead — which reports nothing at all, the shape of the failures.
//
// Three modes, chosen by branch name:
//
//   same   the watched directory is the same every round       (reuse possible)
//   delay  same, but wait before the next round                (cleanup settles)
//   unique a different watched directory every round           (no reuse)
//
// If `same` fails and `unique` does not, the round is measuring a stale handle
// rather than a platform that stopped delivering.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__arm291p__')

const branch = process.env.GITHUB_REF_NAME || ''
const MODE = (branch.match(/path-(same|delay|unique)/) || [, 'same'])[1] as 'same' | 'delay' | 'unique'
const ROUNDS = Number(process.env.SAME_ROUNDS || 40)

async function touch(path: string, cond: () => unknown) {
  for (let i = 0; !cond(); i++) {
    if (i >= 80) throw new Error('touch timed out')
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

describe(`relink, path mode ${MODE}`, () => {
  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(fixture, { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      // the watched directory: constant, or one per round
      const base = MODE === 'unique' ? resolve(fixture, `n${index}`) : fixture
      const target = resolve(base, 'relinked/target/file.ts')
      const link = resolve(base, 'relinked/root/linked')

      // restore the entry to the file it is when the case starts; the parent
      // directory `relinked/root` is never removed in `same` and `delay`
      mkdirSync(dirname(target), { recursive: true })
      mkdirSync(dirname(link), { recursive: true })
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

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let outcome = 'pass'
      try {
        await touch(target, () => seen.length)
      } catch {
        outcome = 'timeout'
      }

      await fiber.dispose()
      if (MODE === 'delay') await new Promise(r => setTimeout(r, 800))

      console.log(`@@P ${index} ${outcome} watched=${dirname(link).replace(fixture, '') || '/'}@@`)
      expect(outcome).to.equal('pass')
    }, 20000)
  }
})
