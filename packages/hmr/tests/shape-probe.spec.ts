import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleLoader } from '@cordisjs/plugin-loader'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// probe only: the same type flip in four shapes, side by side, to find which
// detail decides whether the cached manifest reader goes stale. Not for merge.

const base = join(tmpdir(), 'cordis-shape')

async function flip(shape: string) {
  const root = join(base, shape)
  const pkg = join(root, 'node_modules', 'p')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
  // A and C carry the extra fields an installed manifest has
  const initial = shape === 'A'
    ? { name: 'p', version: '1.0.0', main: './x.js' }
    : { name: 'p', type: 'commonjs' }
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(initial))
  writeFileSync(join(pkg, 'm.js'), 'module.exports = "CJS"\n')

  const internal = ModuleLoader.fromInternal()!
  const mUrl = pathToFileURL(join(pkg, 'm.js')).href
  const warm = (await internal.import(mUrl, import.meta.url, {})).default

  // the flip: the type changes and the file is rewritten as ESM
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'p', type: 'module' }))
  writeFileSync(join(pkg, 'm.js'), 'export default "ESM"\n')

  const mid = shape === 'A' || shape === 'D'
    ? (await internal.import(mUrl, import.meta.url, {})).default
    : undefined
  let query: string
  try {
    query = (await internal.import(`${mUrl}?q`, import.meta.url, {})).default
  } catch {
    query = 'threw'
  }
  return { warm, mid, query }
}

describe('type flip shapes', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('A: extra fields and a same-url import', async () => {
    expect(await flip('A')).to.deep.equal({ warm: 'CJS', mid: 'CJS', query: 'ESM' })
  }, 30000)

  it('B: the minimal shape', async () => {
    expect(await flip('B')).to.deep.equal({ warm: 'CJS', mid: undefined, query: 'CJS' })
  }, 30000)

  it('C: extra fields without the same-url import', async () => {
    expect(await flip('C')).to.deep.equal({ warm: 'CJS', mid: undefined, query: 'CJS' })
  }, 30000)

  it('D: the same-url import without the extra fields', async () => {
    expect(await flip('D')).to.deep.equal({ warm: 'CJS', mid: 'CJS', query: 'CJS' })
  }, 30000)
})
