import { Context, Fiber } from 'cordis'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs from '../src/index.ts'

// The relink case as the spec has it, forty times, with the fixture treated
// the way the spec treats it.
//
// Every earlier repeat of this case moved something the spec does not move:
//
//   insitu-main     one directory deeper every round
//   same-290        deleted the whole fixture between rounds, which rebuilds
//                   `relinked/root` and changes its inode
//   zz-291-three    the same deletion, plus an instrumented watcher
//
// The spec creates `relinked/target` and `relinked/root` once and never
// touches them again; only `linked` is removed and recreated. This runs that,
// so the rate it reports is the case's own and not an artefact of the harness.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__spec291__')
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

describe('relink, the spec shape', () => {
  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    // the two directories are created once, as the spec's `write` does
    mkdirSync(dirname(target), { recursive: true })
    mkdirSync(dirname(link), { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      // `write('relinked/target/file.ts')` and `write('relinked/root/linked')`:
      // both are files, and neither parent directory is touched again
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
      console.log(`@@S ${index} ${outcome}@@`)
      expect(outcome).to.equal('pass')
    }, 15000)
  }
})
