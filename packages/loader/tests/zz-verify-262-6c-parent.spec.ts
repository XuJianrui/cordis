import { expect, describe, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createResolve } from '../src/resolve.ts'

/**
 * 6c says of the two writers that exist today: "`include`, `loader/src/resolve.ts`
 * ... never create parents." That is checkable directly: point `createResolve`
 * at a directory with no `.cordis` subtree and see whether it comes back with a
 * working resolver, which it can only do by having created the parent itself.
 */
describe('6c: does loader/src/resolve.ts create the missing parent it writes into', () => {
  it('reports whether a missing .cordis directory is created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cordis-6c-'))
    try {
      const baseUrl = pathToFileURL(join(root, 'src', 'cordis.yml')).href
      // The fixture writes a package.json one level up so that the scope root is
      // found; nothing creates `.cordis` for the resolver.
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture-6c', type: 'module' }))

      const before = existsSync(join(root, '.cordis'))

      const resolve = await createResolve(baseUrl)

      const after = existsSync(join(root, '.cordis'))
      const entries = after ? await readdir(join(root, '.cordis')) : []

      console.log('6C_BEFORE_CORDIS_EXISTS =', before)
      console.log('6C_RESOLVE_RETURNED =', resolve === undefined ? 'undefined' : 'a function')
      console.log('6C_AFTER_CORDIS_EXISTS =', after)
      console.log('6C_ENTRIES =', JSON.stringify(entries))

      // The claim under test: does this writer create its own parent?
      console.log('6C_CREATED_PARENT =', before === false && after === true)

      // Deliberately loose: this probe records a reading, it does not pin one.
      expect(typeof before).toBe('boolean')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
