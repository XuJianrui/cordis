import { Context } from 'cordis'
import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { platform, release } from 'node:os'
import { describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import Fs from '../src/index.ts'

// The user path rather than the unit: `hmr` ships `files: ['.', '!**/node_modules',
// '!**/.*']`, so a source file replaced by a directory should not look like a file
// change to the watcher that feeds it.
//
// Without `hmr` itself here — it needs loader internals — the reading is the one that
// matters to it: a `change` naming a path that is a directory.
//
// Both arms in the same run: the same shape under a plain watch and under that filter,
// so "no event" cannot be confused with "this filter drops the entry anyway".

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__userdir__')
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const FILTERS: Array<[string, string[] | undefined]> = [
  ['none', undefined],
  ['hmr-default', ['.', '!**/node_modules', '!**/.*']],
]

describe(`a source file replaced by a directory (${TAG})`, () => {
  for (const [name, filter] of FILTERS) {
    it(name, async () => {
      const home = resolve(base, `${name}-${Math.random().toString(36).slice(2)}`)
      const root = resolve(home, 'base')
      mkdirSync(resolve(root, 'src'), { recursive: true })
      writeFileSync(resolve(root, 'src/thing.ts'), 'export const a = 1\n')

      const ctx = new Context()
      const fiber = await ctx.plugin(Fs)
      let inner: any
      await ctx.inject(['fs'], (c) => { inner = c })

      const kinds: string[] = []
      const watcher = inner.fs.watch(root, filter ? { filter } : {})
      watcher.on('change', (f: string) => {
        const s = lstatSync(f, { throwIfNoEntry: false })
        kinds.push(`${(relative(root, f) || '.').replace(/\\/g, '/')}:${s ? (s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'link' : 'file') : 'gone'}`)
      })
      await new Promise<void>((r) => watcher.on('ready', () => r()))

      // control: an ordinary write must arrive, or silence below proves nothing
      const control: string[] = []
      watcher.on('change', (f: string) => { control.push(f) })
      for (let i = 0; i < 40 && !control.length; i++) {
        writeFileSync(resolve(root, 'src/other.ts'), `v${i}`)
        await new Promise((r) => setTimeout(r, 100))
      }
      const controlHeard = control.length > 0

      const mark = kinds.length
      writeFileSync(resolve(root, 'src/other.ts'), 'settled')
      rmSync(resolve(root, 'src/thing.ts'))
      mkdirSync(resolve(root, 'src/thing.ts'), { recursive: true })
      for (let i = 0; i < 8; i++) {
        writeFileSync(resolve(root, 'src/thing.ts/inner.ts'), `v${i}`)
        await new Promise((r) => setTimeout(r, 140))
      }
      await watcher.dispose()
      await fiber.dispose()

      const got = kinds.slice(mark)
      const named = [...new Set(got.filter((x) => !x.endsWith(':file')))]
      console.log(`@@UD ${TAG} ${name} control=${controlHeard} heard=${got.length} not-file=${JSON.stringify(named)}@@`)
      try { rmSync(home, { recursive: true, force: true }) } catch {}
    }, 60000)
  }
})
