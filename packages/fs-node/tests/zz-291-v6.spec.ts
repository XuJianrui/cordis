import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { platform, release } from 'node:os'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import picomatch from 'picomatch'
// the version this repository depends on, and the one the upstream project ships
import { watch as watch4 } from 'chokidar'
import { watch as watch6 } from 'chokidar6'

// The same shape against two different versions of the watch layer.
//
// Everything measured so far ran through this repository's dependency, which is
// pinned to 4.0.3. The project that is being reported against is at 6.0.0, which
// is a rewrite (backend / policy / reconcile / tree, no handler.js) — so a report
// that cites line numbers from 4.0.3 says nothing about what ships today, and a
// reading taken through 4.0.3 cannot support a claim about 6.0.0.
//
//   v4   the pinned dependency, the shape that has been measured all along
//   v6   the current release, same fixture, same filter, same timing
//
// If v6 also loses the entry, the report is about the current code and the line
// numbers need re-deriving. If v6 is clean, the report is about a version the
// project no longer ships and has to say so.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__v6__')
const ROUNDS = Number(process.env.V6_ROUNDS || 100)
const BUDGET = 40
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const match = picomatch('linked/**/*.ts', { posix: true })

function contains(a: string, b: string) {
  return !a || b === a || b.startsWith(a + '/')
}

function keep(path: string, isDirectory: boolean) {
  for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (match(path.slice(0, end))) return true
  }
  return isDirectory && (contains('linked', path) || contains(path, 'linked'))
}

// the predicate this repository supplies, in the shape 4.0.3 expects
function makeIgnored(root: string) {
  const remembered = new Map<string, boolean>()
  return (input: string, stats?: any) => {
    const path = resolve(input)
    if (path === root) return false
    if (stats?.isSymbolicLink()) remembered.delete(path)
    else if (stats) remembered.set(path, stats.isDirectory())
    const isDirectory = remembered.get(path)
    if (isDirectory === undefined) return false
    return !keep(relative(root, path).split(sep).join(posix.sep), isDirectory)
  }
}

const ROOT = resolve(base, 'fx/root')
const TARGET = resolve(base, 'fx/target')
const LINK = resolve(ROOT, 'linked')

async function round(which: 'v4' | 'v6') {
  writeFileSync(resolve(TARGET, 'file.ts'), '')
  rmSync(LINK, { recursive: true, force: true })
  writeFileSync(LINK, '')

  const seen: string[] = []
  const raw: string[] = []
  const watch: any = which === 'v4' ? watch4 : watch6
  const watcher = watch(ROOT, { ignoreInitial: true, ignored: makeIgnored(ROOT) })
  watcher.on('raw', () => raw.push('1'))
  watcher.on('all', (_e: string, p: string) => { if (/file/.test(p)) seen.push(p) })
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  rmSync(LINK)
  symlinkSync(dirname(resolve(TARGET, 'file.ts')), LINK, 'junction')

  let writes = 0
  for (; writes < BUDGET; writes++) {
    if (seen.length) break
    writeFileSync(resolve(TARGET, 'file.ts'), `v${writes}`)
    await new Promise(r => setTimeout(r, 100))
  }

  let watched = 0
  try {
    watched = Object.keys(watcher.getWatched()).length
  } catch {
    watched = -1
  }
  await watcher.close()
  return { ok: seen.length > 0, writes, raw: raw.length, watched }
}

describe('the same shape on 4.0.3 and 6.0.0', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    mkdirSync(TARGET, { recursive: true })
  })

  for (const which of ['v4', 'v6'] as const) {
    for (let index = 0; index < ROUNDS; index++) {
      it(`${which} ${index}`, async () => {
        const r = await round(which)
        console.log(
          `@@V6 ${which} ${index} ${r.writes >= BUDGET ? 'timeout' : 'pass'}` +
          ` writes=${r.writes} raw=${r.raw} watched=${r.watched} ${TAG}@@`,
        )
      }, 30000)
    }
  }
})
