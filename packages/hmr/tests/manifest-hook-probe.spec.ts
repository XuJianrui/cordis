import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModuleLoader } from '@cordisjs/plugin-loader'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// probe only: reads whether a resolve hook can bypass the stale manifest
// reader for the imports the reload path makes. Not for merge.

const root = join(tmpdir(), 'cordis-manifest-hook')
const pkg = join(root, 'node_modules', 'p')
const req = createRequire(import.meta.url)
const { registerHooks } = req('node:module') as any
const internal = ModuleLoader.fromInternal()!

// the bypass under test: a resolution that lands in an invalidated package is
// redone from the manifest on disk, so the fresh entry wins
const invalidated = new Set<string>()
registerHooks({
  resolve(specifier: string, context: any, nextResolve: any) {
    const result = nextResolve(specifier, context)
    if (!result?.url) return result
    let path: string
    try {
      path = fileURLToPath(result.url)
    } catch {
      return result
    }
    for (const dir of invalidated) {
      if (!path.startsWith(dir)) continue
      let entry: string | undefined
      try {
        entry = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).main
      } catch {
        return result
      }
      const target = entry && join(dir, entry)
      if (target && target !== path) {
        return { url: pathToFileURL(target).href, format: result.format }
      }
    }
    return result
  },
})

describe('manifest hook probe', () => {
  beforeAll(() => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'p', main: './a.js' }))
    writeFileSync(join(pkg, 'a.js'), 'module.exports = "A"\n')
    writeFileSync(join(pkg, 'b.js'), 'module.exports = "B"\n')
    writeFileSync(join(root, 'main.mjs'), `import v from 'p'\n\nexport default v\n`)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('observes whether a hook bypass reaches the loader imports', async () => {
    const mainUrl = pathToFileURL(join(root, 'main.mjs')).href
    const seen: string[] = []

    seen.push(`warm: ${(await internal.import(mainUrl, import.meta.url, {})).default}`)

    // the entry moves to b.js
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'p', main: './b.js' }))

    // without the bypass the re-evaluated module still resolves the old entry
    seen.push(`stale: ${(await internal.import(`${mainUrl}?v=1`, import.meta.url, {})).default}`)

    // with the package invalidated, the hook reads the manifest from disk
    invalidated.add(pkg)
    seen.push(`bypassed: ${(await internal.import(`${mainUrl}?v=2`, import.meta.url, {})).default}`)

    expect(seen.map(line => line.split('\\').pop())).to.deep.equal([
      'warm: A',
      'stale: A',
      'bypassed: B',
    ])
  }, 30000)
})
