import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// What has to be true before the replacement for the loss to happen?
//
// The failure is: the replacement produces no event at all, and nothing rescans,
// so the link never gets a watch. Four shapes, same job, same machine, so the
// only difference is what `linked` was before the replacement:
//
//   asfile     a plain file, replaced by a link to the target   (the case)
//   aslink     already a link to the same target, replaced again
//   absent     not there at all, then created as that link
//   catalyst   as `asfile`, plus one unrelated file written into the root
//              right after the replacement
//
// `aslink` and `asfile` both keep the entry's name, so if the loss needs the
// entry's name to survive the replacement, both fail. `absent` creates the name,
// so if that is what makes a rescan notice, it passes. `catalyst` asks whether
// any later event in the same directory is enough to repair it — the earlier gap
// probe suggests it is, since a ping both restored the root's stream and bound
// the link.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__cond291__')
const ROUNDS = Number(process.env.COND_ROUNDS || 150)
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

type Shape = 'asfile' | 'aslink' | 'absent' | 'catalyst'

async function round(shape: Shape) {
  const root = resolve(base, `${shape}/relinked/root`)
  const target = resolve(base, `${shape}/relinked/target/file.ts`)
  const link = resolve(root, 'linked')
  const catalyst = resolve(root, 'catalyst.ts')

  rmSync(catalyst, { force: true })
  writeFileSync(target, '')
  rmSync(link, { recursive: true, force: true })
  if (shape === 'absent') {
    // nothing at the name when the scan runs
  } else if (shape === 'aslink') {
    symlinkSync(dirname(target), link, 'junction')
  } else {
    writeFileSync(link, '')
  }

  const seen: string[] = []
  const raw: string[] = []
  const watcher = watch(root, { ignoreInitial: true, ignored: makeIgnored(root) })
  watcher.on('raw', (event: string, path: string) => raw.push(`${event}:${path}`))
  watcher.on('all', (_event: string, path: string) => { if (/file/.test(path)) seen.push(path) })
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  rmSync(link, { recursive: true, force: true })
  symlinkSync(dirname(target), link, 'junction')
  if (shape === 'catalyst') writeFileSync(catalyst, 'x')

  let writes = 0
  for (; writes < BUDGET; writes++) {
    if (seen.length) break
    writeFileSync(target, `v${writes}`)
    await new Promise(r => setTimeout(r, 100))
  }

  const keys = Object.keys(watcher.getWatched())
  const hasLink = keys.some((k) => /[\\/]linked$/.test(k) || k === 'linked')
  await watcher.close()
  rmSync(catalyst, { force: true })

  return { ok: seen.length > 0, writes, raw: raw.length, hasLink }
}

describe('what has to be true before the replacement', () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true })
    for (const shape of ['asfile', 'aslink', 'absent', 'catalyst']) {
      mkdirSync(resolve(base, `${shape}/relinked/root`), { recursive: true })
      mkdirSync(resolve(base, `${shape}/relinked/target`), { recursive: true })
    }
  })

  for (const shape of ['asfile', 'aslink', 'absent', 'catalyst'] as Shape[]) {
    for (let index = 0; index < ROUNDS; index++) {
      it(`${shape} ${index}`, async () => {
        const r = await round(shape)
        console.log(`@@CD ${shape} ${index} ${r.ok ? 'pass' : 'timeout'} raw=${r.raw} link=${r.hasLink ? 'L' : 'n'} writes=${r.writes}@@`)
      }, 30000)
    }
  }
})
