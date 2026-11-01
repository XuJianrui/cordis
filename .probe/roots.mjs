// Probe 262: watch behaviour on non-default filesystems (network, case-insensitive,
// long paths, UNC). Runs chokidar with the options the fs-node driver uses and
// reports one JSON line per root.
//
// PROBE262_ROOTS="label=path;label=path"  roots to probe (default: os.tmpdir())
// PROBE262_RUNS=3                          runs per cell
import { mkdirSync, mkdtempSync, renameSync, rmSync, statfsSync, statSync, watch as rawWatch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { watch } from 'chokidar'

const runs = Number(process.env.PROBE262_RUNS || 3)
const settleMs = Number(process.env.PROBE262_SETTLE_MS || 900)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function parseRoots() {
  const raw = process.env.PROBE262_ROOTS || ''
  const list = raw.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=')
    return { label: s.slice(0, i), path: s.slice(i + 1) }
  })
  if (!list.length) list.push({ label: 'tmp', path: tmpdir() })
  return list
}

const FS_TYPES = {
  0x01021994: 'tmpfs', 0xef53: 'ext4', 0x58465342: 'xfs', 0x9123683e: 'btrfs',
  0x6969: 'nfs', 0xff534d42: 'cifs', 0x65735546: 'fuse', 0x794c7630: 'overlayfs',
  0x2011bab0: 'exfat', 0x4d44: 'vfat', 0x1a1f9d0: 'vfat', 0x1a1f9d0: 'vfat',
  0x4244: 'hfs', 0x482b: 'hfs+', 0x1a2b3c4d: 'apfs',
}

function fsType(path) {
  try {
    const { type } = statfsSync(path)
    return FS_TYPES[type] ?? `0x${(type >>> 0).toString(16)}`
  } catch (error) {
    return `error:${error.code ?? error.message}`
  }
}

function caseInsensitive(root) {
  // Two names that differ only in case, in the same directory. Lowercasing the
  // whole path would also lowercase the (case-sensitive) parent directories.
  const stamp = `${process.pid}-${Date.now()}`
  const probe = join(root, `CaseProbe-${stamp}.txt`)
  const folded = join(root, `caseprobe-${stamp}.txt`)
  writeFileSync(probe, 'x')
  try {
    return statSync(folded).isFile()
  } catch {
    return false
  } finally {
    rmSync(probe, { force: true })
  }
}

/** Build a path whose total length exceeds 260 characters. */
function longPath(root) {
  let dir = join(root, 'long')
  const segment = 'd'.repeat(40)
  let depth = 0
  while (dir.length < 300) {
    dir = join(dir, segment + depth)
    depth++
  }
  try {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'leaf.txt')
    writeFileSync(file, 'x')
    const ok = statSync(file).isFile()
    rmSync(join(root, 'long'), { recursive: true, force: true })
    return { ok, length: file.length, error: null }
  } catch (error) {
    try { rmSync(join(root, 'long'), { recursive: true, force: true }) } catch {}
    return { ok: false, length: 0, error: error.code ?? error.message }
  }
}

async function rawWatchCase(root) {
  const dir = join(root, 'rawwatch')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  let count = 0
  let failure
  let watcher
  try {
    watcher = rawWatch(dir)
    watcher.on('change', () => count++)
    watcher.on('rename', () => count++)
    watcher.on('error', (error) => { failure = `error:${error.code ?? error.message}` })
    await sleep(300)
    writeFileSync(join(dir, 'a.txt'), 'x')
    await sleep(settleMs)
    return failure ?? count
  } catch (error) {
    return `error:${error.code ?? error.message}`
  } finally {
    watcher?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function remoteMap() {
  const raw = process.env.PROBE262_REMOTE || ''
  const map = {}
  for (const item of raw.split(';').map(s => s.trim()).filter(Boolean)) {
    const i = item.indexOf('=')
    map[item.slice(0, i)] = item.slice(i + 1)
  }
  return map
}

/** Write through the backing directory, i.e. as another client would. */
async function remoteWriteCase(rootPath, backing) {
  const dir = join(rootPath, 'remote')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(backing, 'remote'), { recursive: true })
  const events = []
  let watcher
  let visible = false
  try {
    watcher = watch(dir, { ignoreInitial: true })
    watcher.on('all', (event, path) => events.push(`${event}:${relative(dir, path)}`))
    watcher.on('error', (error) => events.push(`error:${error.code ?? error.message}`))
    await new Promise(resolve => watcher.once('ready', resolve))
    await sleep(150)
    writeFileSync(join(backing, 'remote', 'from-server.txt'), 'x')
    visible = exists(join(dir, 'from-server.txt'))
    await sleep(settleMs)
  } catch (error) {
    events.push(`error:${error.code ?? error.message}`)
  } finally {
    await watcher?.close()
  }
  events.push(`visible:${visible}`)
  // Best effort: a mount view and its backing directory can disagree.
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  try { rmSync(join(backing, 'remote'), { recursive: true, force: true }) } catch {}
  return events
}

function exists(path) {
  try { statSync(path); return true } catch { return false }
}

/** Did the operation actually reach the state the cell is supposed to test? */
function postState(name, dir, file) {
  switch (name) {
    case 'delete':
      return { fileExists: exists(file) }
    case 'mkdir-inside':
      return { subExists: exists(join(dir, 'sub')) }
    case 'nested-create':
      return { nestedExists: exists(join(dir, 'nested', 'deep.txt')) }
    case 'case-rename': {
      const upper = join(dirname(file), basename(file).toUpperCase())
      return { same: upper === file, upperExists: exists(upper), fileExists: exists(file) }
    }
    default:
      return { fileExists: exists(file) }
  }
}

const cells = [
  ['write', async (dir, file) => { writeFileSync(file, 'v') }],
  ['delete', async (dir, file) => { rmSync(file, { force: true }) }],
  ...['0', '20', '200'].map(ms => [`recreate-${ms}`, async (dir, file) => {
    rmSync(file, { force: true })
    await sleep(Number(ms))
    writeFileSync(file, 'v')
  }]),
  ['atomic-rename', async (dir, file) => {
    writeFileSync(file + '.tmp', 'v')
    renameSync(file + '.tmp', file)
  }],
  ['case-rename', async (dir, file) => {
    // Only the basename changes case: on a case-sensitive filesystem the parent
    // directories would otherwise not resolve.
    const upper = join(dirname(file), basename(file).toUpperCase())
    if (upper === file) return
    try { renameSync(file, upper) } catch {}
  }],
  ['mkdir-inside', async (dir) => { mkdirSync(join(dir, 'sub'), { recursive: true }) }],
  ['nested-create', async (dir) => {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'deep.txt'), 'v')
  }],
]

async function grid(root) {
  const out = {}
  for (const shape of ['file', 'dir']) {
    for (const [name, op] of cells) {
      const readings = []
      for (let run = 1; run <= runs; run++) {
        const dir = join(root, 'grid', shape, name, `run${run}`)
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'watched.txt')
        writeFileSync(file, 'seed')
        await sleep(300)
        const raw = []
        const cb = []
        const errors = []
        const isFile = shape === 'file'
        let post
        let watcher
        try {
          watcher = watch(dir, {
            ignoreInitial: true,
            depth: isFile ? 0 : undefined,
            ignored: (path) => {
              path = resolve(path)
              if (isFile && path !== dir && path !== file) return true
              return false
            },
          })
          watcher.on('error', (error) => errors.push(`error:${error.code ?? error.message}`))
          watcher.on('all', (event, path) => raw.push(`${event}:${relative(dir, path).split(sep).join('/')}`))
          watcher.on('add', (path) => {
            if (!isFile || resolve(path) === resolve(file)) cb.push(`add:${relative(dir, path).split(sep).join('/')}`)
          })
          watcher.on('change', (path) => {
            if (!isFile || resolve(path) === resolve(file)) cb.push(`change:${relative(dir, path).split(sep).join('/')}`)
          })
          await new Promise(resolve => watcher.once('ready', resolve))
          await sleep(150)
          await op(dir, file)
          post = postState(name, dir, file)
          await sleep(settleMs)
        } catch (error) {
          raw.push(`error:${error.code ?? error.message}`)
        } finally {
          await watcher?.close()
        }
        readings.push({ raw, cb, errors, post })
        try { rmSync(dir, { recursive: true, force: true }) } catch {}
      }
      out[`${shape}:${name}`] = readings
    }
  }
  return out
}

const remote = remoteMap()
const report = []
for (const root of parseRoots()) {
  let exists = true
  try { mkdirSync(root.path, { recursive: true }); statSync(root.path) } catch { exists = false }
  if (!exists) {
    report.push({ label: root.label, path: root.path, exists: false })
    continue
  }
  const entry = {
    label: root.label,
    path: root.path,
    exists: true,
    platform: process.platform,
    node: process.version,
    fsType: fsType(root.path),
    caseInsensitive: caseInsensitive(root.path),
    longPath: longPath(root.path),
    rawWatchEvents: await rawWatchCase(root.path),
    cells: await grid(root.path),
    remoteWrite: remote[root.label] ? await remoteWriteCase(root.path, remote[root.label]) : null,
  }
  console.log('PROBE262_ROOT ' + JSON.stringify(entry))
  report.push(entry)
}
console.log('PROBE262_ROOTS_DONE ' + JSON.stringify({ roots: report.length, runs }))
