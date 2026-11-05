import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'

// The relink case driven by the watch layer alone, with NO `ignored` predicate
// and no options beyond `ignoreInitial`. This is the control that decides
// whether the drop depends on the predicate this package supplies or happens
// without it.
//
// `zz-291-pred.spec.ts` is the same case with the predicate; comparing the two
// is the whole point, so nothing else differs between them.

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__nf291__')
const ROUNDS = 40
const BUDGET = 40

const target = resolve(fixture, 'relinked/target/file.ts')
const link = resolve(fixture, 'relinked/root/linked')

async function touch(path: string, cond: () => unknown) {
  for (let i = 0; i < BUDGET; i++) {
    if (cond()) return true
    writeFileSync(path, `v${i}`)
    await new Promise(r => setTimeout(r, 100))
  }
  return !!cond()
}

describe('relink, watch layer alone, no predicate', () => {
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

      const seen: string[] = []
      const watcher = watch(dirname(link), { ignoreInitial: true })
      watcher.on('all', (_event, path) => seen.push(path))
      await new Promise<void>((done) => watcher.once('ready', () => done()))

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      const ok = await touch(target, () => seen.length)
      await watcher.close()
      console.log(`@@NF ${index} ${ok ? 'pass' : 'timeout'} n=${seen.length}@@`)
    }, 20000)
  }
})
