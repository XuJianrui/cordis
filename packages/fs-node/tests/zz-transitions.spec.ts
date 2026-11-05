import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { platform, release } from 'node:os'
import { beforeAll, describe, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { watch } from 'chokidar'
import picomatch from 'picomatch'

// Every transition of the watched entry, on whichever version is installed.
//
// Earlier rounds measured four shapes; the reverse transitions, the directory
// cases and the absent cases were never run. This covers the whole table in one
// job, so "which transitions work" is answered once rather than one arm per turn.
//
// Each arm has one expected answer, written down here rather than inferred from
// a regex afterwards:
//
//   expect 'entry'  the change is about the entry itself (it is a file now)
//   expect 'under'  the change is about a file the entry exposes
//
//   state at ready    transition                   arm            expect
//   ----------------  ---------------------------  -------------  ------
//   plain file        written in place             file-write     entry
//   plain file        becomes a link to a dir      file-2-link    under
//   plain file        becomes a dir                file-2-dir     under
//   link to A         written through              link-write     under
//   link to A         retargeted to B              link-retarget  under
//   link to A         becomes a plain file         link-2-file    entry
//   link to A         becomes a real dir           link-2-dir     under
//   real dir          written inside               dir-write      under
//   real dir          becomes a link to A          dir-2-link     under
//   absent            created as a plain file      gone-2-file    entry
//   absent            created as a link to A       gone-2-link    under
//   absent            created as a real dir        gone-2-dir     under
//
// `link-retarget-nofollow` repeats the retarget with `followSymlinks: false`,
// which localises a difference to the follow path rather than to change detection.

const testDir = dirname(fileURLToPath(import.meta.url))
const base = resolve(testDir, '__tt__')
const ROUNDS = Number(process.env.TT_ROUNDS || 20)
const BUDGET = 20
const TAG = `${platform()}-${release().split('.')[0]}-${process.version.slice(1)}`

const match = picomatch('linked/**/*.ts', { posix: true })
function contains(a: string, b: string) { return !a || b === a || b.startsWith(a + '/') }
function keepIt(p: string, isDir: boolean) {
  for (let end = p.length; end > 0; end = p.lastIndexOf('/', end - 1)) {
    if (match(p.slice(0, end))) return true
  }
  return isDir && (contains('linked', p) || contains('linked', p))
}

type Arm =
  | 'file-write' | 'file-2-link' | 'file-2-dir'
  | 'link-write' | 'link-retarget' | 'link-retarget-nofollow'
  | 'link-2-file' | 'link-2-dir'
  | 'dir-write' | 'dir-2-link'
  | 'gone-2-file' | 'gone-2-link' | 'gone-2-dir'

// `none` is a real expectation here, not a placeholder: the filter is
// `linked/**/*.ts`, which does not match a plain file named `linked`, so an
// entry that stays a plain file is outside the watch by design and should
// report nothing. Marking those arms `entry` would have made correct
// behaviour look like a failure.
const EXPECT: Record<Arm, 'entry' | 'under' | 'none' | 'any'> = {
  'file-write': 'none',
  'file-2-link': 'under',
  'file-2-dir': 'under',
  'link-write': 'under',
  'link-retarget': 'under',
  'link-retarget-nofollow': 'under',
  'link-2-file': 'any',
  'link-2-dir': 'under',
  'dir-write': 'under',
  'dir-2-link': 'under',
  'gone-2-file': 'none',
  'gone-2-link': 'under',
  'gone-2-dir': 'under',
}

const ALL = Object.keys(EXPECT) as Arm[]

async function round(arm: Arm, i: number) {
  const home = resolve(base, `${arm}/${i}`)
  const root = resolve(home, 'root')
  const a = resolve(home, 'a')
  const b = resolve(home, 'b')
  mkdirSync(root, { recursive: true })
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  writeFileSync(resolve(a, 'file.ts'), 'v0')
  writeFileSync(resolve(b, 'file.ts'), 'v0')
  const link = resolve(root, 'linked')

  // the state of the entry when the scan runs
  if (arm.startsWith('file-')) writeFileSync(link, '')
  else if (arm.startsWith('link-')) symlinkSync(a, link, 'junction')
  else if (arm.startsWith('dir-')) mkdirSync(link, { recursive: true })
  // gone-* leaves nothing at the name

  const map = new Map<string, boolean>()
  const ignored = (input: string, stats?: any) => {
    const p = resolve(input)
    if (p === root) return false
    if (stats?.isSymbolicLink()) map.delete(p)
    else if (stats) map.set(p, stats.isDirectory())
    const isDir = map.get(p)
    if (isDir === undefined) return false
    return !keepIt(relative(root, p).split(sep).join(posix.sep), isDir)
  }

  const options: any = { ignoreInitial: true, ignored }
  if (arm === 'link-retarget-nofollow') options.followSymlinks = false

  const events: string[] = []
  let raw = 0
  const watcher = watch(root, options)
  watcher.on('raw', () => { raw++ })
  watcher.on('all', (e: string, p: string) => events.push(`${e}:${relative(root, p) || '.'}`))
  await new Promise<void>((done) => watcher.once('ready', () => done()))

  const mark = events.length

  // the transition, and where the writes go afterwards
  let writeTo = ''
  switch (arm) {
    case 'file-write':
      writeTo = link
      break
    case 'link-write':
      writeTo = resolve(a, 'file.ts')
      break
    case 'dir-write':
      writeTo = resolve(link, 'file.ts')
      break
    case 'file-2-link':
    case 'dir-2-link':
    case 'gone-2-link':
      rmSync(link, { recursive: true, force: true })
      symlinkSync(a, link, 'junction')
      writeTo = resolve(a, 'file.ts')
      break
    case 'link-retarget':
    case 'link-retarget-nofollow':
      rmSync(link, { recursive: true, force: true })
      symlinkSync(b, link, 'junction')
      writeTo = resolve(b, 'file.ts')
      break
    case 'file-2-dir':
    case 'link-2-dir':
    case 'gone-2-dir':
      rmSync(link, { recursive: true, force: true })
      mkdirSync(link, { recursive: true })
      writeTo = resolve(link, 'file.ts')
      break
    case 'link-2-file':
    case 'gone-2-file':
      rmSync(link, { recursive: true, force: true })
      writeFileSync(link, 'v0')
      writeTo = link
      break
  }

  for (let n = 0; n < BUDGET; n++) {
    if (events.length > mark) break
    writeFileSync(writeTo, `v${n + 1}`)
    await new Promise(r => setTimeout(r, 100))
  }

  const keys = Object.keys(watcher.getWatched())
  const hasLink = keys.some(k => /[\\/]linked$/.test(k))
  await watcher.close()
  try { rmSync(home, { recursive: true, force: true }) } catch {}

  const got = events.slice(mark)
  const want = EXPECT[arm]
  const namedEntry = got.some(e => /:(\.|linked)$/.test(e))
  const namedUnder = got.some(e => /:linked[\\/].*\.ts$/.test(e) || /:linked[\\/]file\.ts$/.test(e))

  let kind = 'none'
  if (want === 'none') {
    // silence is the correct answer; any event means the entry leaked into the
    // watch despite the filter excluding it
    kind = got.length ? 'leak' : 'pass'
  } else if (want === 'any') {
    kind = got.length ? 'pass' : 'none'
  } else if (want === 'entry') {
    if (namedEntry) kind = 'pass'
    else if (got.length) kind = 'wrong'
  } else {
    if (namedUnder) kind = 'pass'
    else if (namedEntry) kind = 'entry-only'
    else if (got.length) kind = 'wrong'
  }

  return { kind, raw, hasLink, got: got.slice(0, 2) }
}

describe('every transition of the watched entry', () => {
  beforeAll(() => { rmSync(base, { recursive: true, force: true }) })

  for (const arm of ALL) {
    for (let i = 0; i < ROUNDS; i++) {
      it(`${arm} ${i}`, async () => {
        const r = await round(arm, i)
        console.log(`@@TT ${TAG} ${arm} ${i} ${r.kind} raw=${r.raw} key=${r.hasLink ? 'y' : 'n'} got=${r.got.join(',') || '-'}@@`)
      }, 40000)
    }
  }
})
