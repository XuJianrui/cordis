import { mkdirSync, rmSync, symlinkSync, watch as bareWatch, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// Is the silence in the handle, or in the directory?
//
// On a failed round the root's watch reports nothing, while the very same watch
// answers a file written a moment later. Two things could explain that, and a
// rate cannot tell them apart:
//
//   the handle    this registration is silent; the directory is fine
//   the directory the stream for this directory is down; any registration is
//                 silent for a while
//
// So on a failed round only, a *second*, bare `fs.watch` is created on the same
// root — a fresh registration, made after the replacement — and one file is
// written. Then:
//
//   bare fires, chokidar does not   the handle is silent; the directory is fine
//   neither fires                   the directory is silent for every caller
//   both fire                       the gap had already ended by then
//
// The bare watch is created only after the round has failed, so a passing round
// is left exactly as the case leaves it; a per-round extra consumer suppresses
// this failure entirely (1200 rounds clean when every round got one).

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__nb291__')
const ROUNDS = Number(process.env.NB_ROUNDS || 150)
const BUDGET = 40
const PING = 3000

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

describe('is the silence in the handle or in the directory', () => {
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
      const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored(root) })
      watcher.on('raw', (event: string, path: string) => raw.push(`${event}:${path}`))
      watcher.on('all', (_event: string, path: string) => { if (/file/.test(path)) seen.push(path) })
      await new Promise<void>((done) => watcher.once('ready', () => done()))

      rmSync(link)
      symlinkSync(dirname(target), link, 'junction')

      let writes = 0
      for (; writes < BUDGET; writes++) {
        if (seen.length) break
        writeFileSync(target, `v${writes}`)
        await new Promise(r => setTimeout(r, 100))
      }

      if (seen.length) {
        await watcher.close()
        console.log(`@@NB ${index} pass writes=${writes}@@`)
        return
      }

      // failed: register a second, bare watch on the same root, then write once
      let bare = 0
      let bareError: string | null = null
      const secondary = bareWatch(root, () => { bare++ })
      secondary.on('error', (error: any) => { bareError = String(error?.code ?? error) })

      const rawBefore = raw.length
      writeFileSync(ping, 'x')
      // wait the whole window so both observations are made on the same write,
      // rather than stopping at whichever one happens to arrive first
      const until = Date.now() + PING
      while (Date.now() < until) {
        await new Promise(r => setTimeout(r, 10))
      }

      const chokidarSaw = raw.slice(rawBefore).some((s) => /ping/.test(s))
      secondary.close()
      await watcher.close()
      rmSync(ping, { force: true })

      console.log(
        `@@NB ${index} timeout writes=${writes} bare=${bare} bareError=${bareError ?? '-'}` +
        ` chokidarSawPing=${chokidarSaw} rawInRound=${rawBefore}@@`,
      )
    }, 60000)
  }
})
