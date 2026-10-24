import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import Module from 'node:module'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModuleLoader } from '@cordisjs/plugin-loader'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// probe only: reads what the four manifest caches do after a package update,
// through the same loader the reload path uses. Not for merge.

const root = join(tmpdir(), 'cordis-manifest-probe')
const pkg = join(root, 'node_modules', 'p')
const req = createRequire(join(root, 'main.cjs'))

// the paths differ per platform, so only the last segment of a path is compared
const tail = (line: string) => {
  const parts = line.split(/[\\/]/)
  return parts.length > 1 ? parts.pop()! : line
}

function manifest(content: object) {
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(content))
}

describe('manifest probe', () => {
  beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
    manifest({ name: 'p', version: '1.0.0', main: './a.js' })
    writeFileSync(join(pkg, 'a.js'), 'module.exports = "A"\n')
    writeFileSync(join(pkg, 'b.js'), 'module.exports = "B"\n')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('observes the CJS resolution after an entry change', () => {
    const seen: string[] = []
    seen.push(`resolve warm: ${req.resolve('p')}`)
    seen.push(`require warm: ${req('p')}`)

    manifest({ name: 'p', version: '1.0.0', main: './b.js' })
    seen.push(`resolve after flip: ${req.resolve('p')}`)

    // the CJS path cache is the one layer with a writable entry
    const pathCache = (Module as any)._pathCache as Record<string, string> | undefined
    seen.push(`pathCache present: ${!!pathCache}`)
    let cleared = 0
    if (pathCache) {
      for (const key of Object.keys(pathCache)) {
        if (pathCache[key].includes(join('node_modules', 'p'))) {
          delete pathCache[key]
          cleared++
        }
      }
    }
    seen.push(`pathCache cleared: ${cleared}`)
    seen.push(`resolve after clearing: ${req.resolve('p')}`)
    seen.push(`require after clearing: ${req('p')}`)

    expect(seen.map(tail)).to.deep.equal([
      'a.js',
      'require warm: A',
      'a.js',
      'pathCache present: true',
      'pathCache cleared: 1',
      'a.js',
      'require after clearing: A',
    ])
  })

  it('observes the ESM side through the loader the reload path uses', async () => {
    const internal = ModuleLoader.fromInternal()!
    const aUrl = pathToFileURL(join(pkg, 'a.js')).href
    const bUrl = pathToFileURL(join(pkg, 'b.js')).href
    const seen: string[] = []

    seen.push(`import abs a.js warm: ${(await internal.import(aUrl, import.meta.url, {})).default}`)
    writeFileSync(join(pkg, 'a.js'), 'module.exports = "A2"\n')
    seen.push(`import abs a.js again: ${(await internal.import(aUrl, import.meta.url, {})).default}`)
    seen.push(`import abs b.js fresh: ${(await internal.import(bUrl, import.meta.url, {})).default}`)

    // the helper is what the loader resolves entry names through
    const helper = join(root, 'resolve-helper.mjs')
    writeFileSync(helper, 'export default (specifier) => import.meta.resolve(specifier)\n')
    const resolveIn = (await internal.import(pathToFileURL(helper).href, import.meta.url, {})).default
    seen.push(`meta.resolve p: ${resolveIn('p')}`)

    expect(seen.map(tail)).to.deep.equal([
      'import abs a.js warm: A',
      'import abs a.js again: A',
      'import abs b.js fresh: B',
      'a.js',
    ])
  }, 30000)

  it('observes the module format after a type flip', async () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
    manifest({ name: 'p', type: 'commonjs' })
    writeFileSync(join(pkg, 'm.js'), 'module.exports = "CJS"\n')

    const internal = ModuleLoader.fromInternal()!
    const mUrl = pathToFileURL(join(pkg, 'm.js')).href
    const seen: string[] = []

    seen.push(`import m.js as commonjs: ${(await internal.import(mUrl, import.meta.url, {})).default}`)

    // flip the type and rewrite the file as ESM
    manifest({ name: 'p', type: 'module' })
    writeFileSync(join(pkg, 'm.js'), 'export default "ESM"\n')
    seen.push(`import m.js same url: ${(await internal.import(mUrl, import.meta.url, {})).default}`)
    seen.push(`import m.js?v=2 cache miss: ${(await internal.import(`${mUrl}?v=2`, import.meta.url, {})).default}`)

    writeFileSync(join(pkg, 'n.js'), 'export default "ESM-N"\n')
    seen.push(`import n.js fresh file: ${(await internal.import(pathToFileURL(join(pkg, 'n.js')).href, import.meta.url, {})).default}`)

    expect(seen.map(tail)).to.deep.equal([
      'import m.js as commonjs: CJS',
      'import m.js same url: CJS',
      'import m.js?v=2 cache miss: ESM',
      'import n.js fresh file: ESM-N',
    ])
  }, 30000)
})
