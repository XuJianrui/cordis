import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// Which step of the re-binding fails?
//
// The shape is the spec's: the two directories are created once, and only
// `linked` is replaced. That matters — a harness that deletes the root itself
// kills the root's own watch, and then every round reports nothing, which is a
// different failure from the one this case has.
//
// The predicate is a copy of this package's, verified cell by cell against it,
// so the reading applies to the real path without reaching into any internal.
//
// Three readings, all from chokidar's own public API:
//
//   raw          its event stream before its filters: did the directory notice
//                that `linked` changed at all?
//   before       getWatched() at `ready`: was the link bound to begin with?
//   after        getWatched() after the writes: did a watch get bound on it?
//
// The combinations separate the possibilities:
//
//   raw>0, no link bound   the entry was noticed and then dropped
//   raw=0, no link bound   the directory never noticed; nothing to re-bind from
//   raw>0, link bound      bound, yet no event reached the caller: delivery
//   raw=0, link bound      bound, and the writes were never reported

const testDir = dirname(fileURLToPath(import.meta.url))
const fixture = resolve(testDir, '__rebind291__')
const root = resolve(fixture, 'relinked/root')
const target = resolve(fixture, 'relinked/target/file.ts')
const link = resolve(root, 'linked')
const ROUNDS = Number(process.env.REBIND_ROUNDS || 100)
const BUDGET = 40

const match = picomatch('linked/**/*.ts', { posix: true })

function contains(base: string, path: string) {
  return !base || path === base || path.startsWith(base + '/')
}

function keep(path: string, isDirectory: boolean) {
  for (let end = path.length; end > 0; end = path.lastIndexOf('/', end - 1)) {
    if (match(path.slice(0, end))) return true
  }
  return isDirectory && (contains('linked', path) || contains(path, 'linked'))
}

function makeIgnored() {
  const remembered = new Map<string, boolean>()
  return (input: string, stats?: any) => {
    const path = resolve(input)
    if (path === root) return false
    if (stats?.isSymbolicLink()) remembered.delete(path)
    else if (stats) remembered.set(path, stats.isDirectory())
    const isDirectory = remembered.get(path)
    if (isDirectory === undefined) return false
    return !keep(relative(root, path).split(sep).join('/'), isDirectory)
  }
}

function bound(watcher: { getWatched(): Record<string, string[]> }) {
  const keys = Object.keys(watcher.getWatched())
  // the separator follows the platform, so both spellings have to be accepted
  const hasLink = keys.some((key) => /[\\/]linked$/.test(key) || key === 'linked')
  return { count: keys.length, hasLink }
}

describe('relink, where the re-binding stops', () => {
  beforeAll(() => {
    rmSync(fixture, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    mkdirSync(root, { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      writeFileSync(target, '')
      rmSync(link, { recursive: true, force: true })
      writeFileSync(link, '')

      const raw: string[] = []
      const seen: string[] = []
      const errors: string[] = []
      const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored() })
      watcher.on('raw', (event: string, path: string) => raw.push(`${event}:${path}`))
      watcher.on('all', (event: string, path: string) => { if (/file/.test(path)) seen.push(path) })
      watcher.on('error', (error: any) => errors.push(String(error?.code ?? error)))
      await new Promise<void>((done) => watcher.once('ready', () => done()))

      const before = bound(watcher)

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let writes = 0
      for (; writes < BUDGET; writes++) {
        if (seen.length) break
        writeFileSync(target, `v${writes}`)
        await new Promise(r => setTimeout(r, 100))
      }

      const after = bound(watcher)
      const outcome = seen.length ? 'pass' : 'timeout'
      const detail = raw.slice(0, 3).map(s => s.replace(root, '')).join('|') || '-'
      const watched = Object.keys(watcher.getWatched()).map(k => k.replace(root, '') || '/').join(',')
      await watcher.close()

      console.log(
        `@@RB ${index} ${outcome} raw=${raw.length} [${detail}]` +
        ` before=${before.count}/${before.hasLink ? 'L' : 'n'}` +
        ` after=${after.count}/${after.hasLink ? 'L' : 'n'}` +
        ` err=${errors.length} writes=${writes} watched=${watched}@@`,
      )
    }, 30000)
  }
})
