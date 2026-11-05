import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// After a round has gone silent, is the watch on the root still alive?
//
// `raw` is emitted from the fs.watch callback before any of chokidar's filters,
// so "no raw at all" means the callback never ran — not that an event was
// filtered away. What it does not say is which watch was silent: the one on the
// root, or the one the root is supposed to create for the link.
//
// So after the outcome is known, this writes a file straight into the root and
// waits for it. The root is created once and never touched, so its watch is the
// one thing that cannot legitimately be invalidated in a round.
//
//   fail, root answers    the root watch is fine; only the link path was lost
//   fail, root silent     the root watch itself is gone
//
// The check runs after the outcome, so it cannot change it.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__alive291__')
const ROUNDS = Number(process.env.ALIVE_ROUNDS || 150)
const BUDGET = 40
const PING = 2000

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

describe('is the root watch alive when a round goes silent', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    mkdirSync(resolve(base, 'relinked/root'), { recursive: true })
    mkdirSync(resolve(base, 'relinked/target'), { recursive: true })
  })

  for (let index = 0; index < ROUNDS; index++) {
    it(`round ${index}`, async () => {
      const root = resolve(base, 'relinked/root')
      const target = resolve(base, 'relinked/target/file.ts')
      const link = resolve(root, 'linked')
      const ping = resolve(root, 'ping.ts')

      writeFileSync(target, '')
      rmSync(link, { recursive: true, force: true })
      writeFileSync(link, '')
      rmSync(ping, { force: true })

      const raw: string[] = []
      const seen: string[] = []
      const pinged: string[] = []
      const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored(root) })
      watcher.on('raw', (event: string, path: string) => raw.push(`${event}:${path}`))
      watcher.on('all', (event: string, path: string) => {
        if (/file/.test(path)) seen.push(path)
        if (/ping/.test(path)) pinged.push(path)
      })
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

      // after the outcome: is the root watch still able to report anything?
      const rawBeforePing = raw.length
      writeFileSync(ping, 'x')
      const until = Date.now() + PING
      while (!pinged.length && Date.now() < until) {
        await new Promise(r => setTimeout(r, 10))
      }
      // read from raw, not from the `all` stream: the predicate filters
      // `ping.ts` out (it is not under `linked/`), so `all` never fires for it
      const rootAlive = raw.filter((s) => /ping/.test(s)).length > 0
      const rawAfterPing = raw.length
      await watcher.close()

      console.log(
        `@@AL ${index} ${seen.length ? 'pass' : 'timeout'}` +
        ` raw=${raw.length} before=${before.count}/${before.hasLink ? 'L' : 'n'}` +
        ` after=${after.count}/${after.hasLink ? 'L' : 'n'}` +
        ` alive=${rootAlive} pingRaw=${rawAfterPing - rawBeforePing}` +
        ` writes=${writes}@@`,
      )
    }, 30000)
  }
})
