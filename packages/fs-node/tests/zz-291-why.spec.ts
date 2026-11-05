import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// Why does a directory that is never replaced stop reporting?
//
// 800 rounds of the spec's shape gave a perfectly separable reading: every pass
// had raw events and a bound link; every failure had neither. So the failure is
// not "noticed but not re-bound" — the watch on the root never fired at all,
// even though the root is created once and never touched.
//
// The candidate that explains a dead watch on an untouched directory is that the
// watch is not fresh: the watch layer keeps a registry keyed by path, and a new
// watcher on a path it has seen before may attach to what the previous round
// left behind. That would make the rate depend on teardown, not on the case.
//
// Two arms in one job, same machine, same load, so the comparison is paired:
//
//   reuse   every round watches the same root, as the spec does
//   fresh   every round watches a root that has never been watched before
//
// If `fresh` never fails, the state is inherited across rounds and the case is
// measuring teardown. If `fresh` fails at the same rate, the state is created
// within a round and teardown has nothing to do with it.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__why291__')
const ROUNDS = Number(process.env.WHY_ROUNDS || 200)
const BUDGET = 40

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

function makeIgnored(root: string) {
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
  return { count: keys.length, hasLink: keys.some((k) => /[\\/]linked$/.test(k) || k === 'linked') }
}

async function round(root: string, target: string, tag: string) {
  const link = resolve(root, 'linked')
  writeFileSync(target, '')
  rmSync(link, { recursive: true, force: true })
  writeFileSync(link, '')

  const raw: string[] = []
  const seen: string[] = []
  const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored(root) })
  watcher.on('raw', (event: string, path: string) => raw.push(`${event}:${path}`))
  watcher.on('all', (_event: string, path: string) => { if (/file/.test(path)) seen.push(path) })
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
  const detail = raw.slice(0, 2).map(s => s.replace(root, '')).join('|') || '-'
  await watcher.close()

  console.log(
    `@@WY ${tag} ${outcome} raw=${raw.length} [${detail}]` +
    ` before=${before.count}/${before.hasLink ? 'L' : 'n'}` +
    ` after=${after.count}/${after.hasLink ? 'L' : 'n'} writes=${writes}@@`,
  )
}

describe('why a root that is never replaced goes quiet', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(resolve(base, 'reuse/relinked/root'), { recursive: true })
    mkdirSync(resolve(base, 'reuse/relinked/target'), { recursive: true })
    for (let i = 0; i < ROUNDS; i++) {
      mkdirSync(resolve(base, `fresh/n${i}/relinked/root`), { recursive: true })
      mkdirSync(resolve(base, `fresh/n${i}/relinked/target`), { recursive: true })
    }
  })

  for (let i = 0; i < ROUNDS; i++) {
    it(`reuse ${i}`, async () => {
      await round(
        resolve(base, 'reuse/relinked/root'),
        resolve(base, 'reuse/relinked/target/file.ts'),
        `reuse ${i}`,
      )
    }, 30000)
  }

  for (let i = 0; i < ROUNDS; i++) {
    it(`fresh ${i}`, async () => {
      await round(
        resolve(base, `fresh/n${i}/relinked/root`),
        resolve(base, `fresh/n${i}/relinked/target/file.ts`),
        `fresh ${i}`,
      )
    }, 30000)
  }
})
