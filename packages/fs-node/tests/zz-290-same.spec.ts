import { Context, Fiber } from 'cordis'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs from '../src/index.ts'

// The relink case exactly as `watch.spec.ts` has it, forty times, at the same
// paths each round.
//
// The only difference from the spec file is that the fixture is cleared
// between rounds, so every round starts from the same three-level layout
// `relinked/root/linked` rather than a deeper one. Nothing else moves: same
// `write`, same `touch` budget, same `filter`, same cleanup.
//
// This exists because a repeat that adds a directory level is not a repeat, and
// because forty rounds inside one process are not forty independent samples —
// which is why the same file is pushed to several branches, one job each.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__same__')

const ROUNDS = Number(process.env.SAME_ROUNDS || 40)

function write(name: string, content = '') {
  const path = resolve(fixture, name)
  return { path, content }
}

// the case's `touch`: writes until the change is seen, 80 tries 100 ms apart
async function touch(path: string, cond: () => unknown) {
  for (let i = 0; !cond(); i++) {
    if (i >= 80) throw new Error('touch timed out')
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

async function watch(ctx: Context, path: string, listener: (filename: string) => void, options: any) {
  const watcher = ctx.fs.watch(path, options)
  watcher.on('change', listener)
  await new Promise<void>(resolve => watcher.on('ready', resolve))
  return watcher
}

describe('the relink case, forty times, at its own paths', () => {
  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
  })

  afterEach(() => {
    // the next round starts from the same layout, not a deeper one
    rmSync(fixture, { recursive: true, force: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      const target = write('relinked/target/file.ts')
      const link = write('relinked/root/linked')
      writeFileSync(target.path, '')
      writeFileSync(link.path, '')

      const root = new Context()
      root.baseUrl = import.meta.url
      const fiber: Fiber<Context> = await root.plugin(Fs)
      let ctx!: Context
      await root.inject(['fs'], (inner) => { ctx = inner })

      const seen: string[] = []
      await watch(ctx, dirname(link.path), (filename) => { seen.push(filename) }, {
        filter: ['linked/**/*.ts'],
      })

      rmSync(link.path)
      symlinkSync(dirname(target.path), link.path, 'junction')
      await touch(target.path, () => seen.length)
      expect([...new Set(seen)]).to.deep.equal([resolve(link.path, 'file.ts')])

      await fiber.dispose()
    }, 15000)
  }
})
