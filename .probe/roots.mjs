// Probe 262: watch behaviour on non-default filesystems (network, case-insensitive,
// long paths, UNC). Runs chokidar with the options the fs-node driver uses and
// reports one JSON line per root.
//
// PROBE262_ROOTS="label=path;label=path"  roots to probe (default: os.tmpdir())
// PROBE262_RUNS=3                          runs per cell
import { mkdirSync, mkdtempSync, renameSync, rmSync, statfsSync, statSync, watch as rawWatch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
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
  const probe = join(root, `case-${process.pid}-${Date.now()}.txt`)
  writeFileSync(probe, 'x')
  try {
    const found = statSync(probe.toLowerCase())
    return found.isFile()
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
  let watcher
  try {
    watcher = rawWatch(dir)
    watcher.on('change', () => count++)
    watcher.on('rename', () => count++)
    await sleep(300)
    writeFileSync(join(dir, 'a.txt'), 'x')
    await sleep(settleMs)
    return count
  } catch (error) {
    return `error:${error.code ?? error.message}`
  } finally {
    watcher?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const cells = [
  ['write', async (dir, file) => { writeFileSync(file, 'v') }],
  ['delete', async (dir, file) => { rmSync(file, { force: true }) }],
  ['recreate-200', async (dir, file) => {
    rmSync(file, { force: true })
    await sleep(200)
    writeFileSync(file, 'v')
  }],
  ['atomic-rename', async (dir, file) => {
    writeFileSync(file + '.tmp', 'v')
    renameSync(file + '.tmp', file)
  }],
  ['case-rename', async (dir, file) => {
    const upper = file.toUpperCase()
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
        rmSync(dir, { recursive: true, force: true })
        mkdirSync(dir, { recursive: true })
        const file = join(dir, 'watched.txt')
        writeFileSync(file, 'seed')
        await sleep(300)
        const raw = []
        const cb = []
        const isFile = shape === 'file'
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
          await sleep(settleMs)
        } catch (error) {
          raw.push(`error:${error.code ?? error.message}`)
        } finally {
          await watcher?.close()
        }
        readings.push({ raw, cb })
        rmSync(dir, { recursive: true, force: true })
      }
      out[`${shape}:${name}`] = readings
    }
  }
  return out
}

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
  }
  console.log('PROBE262_ROOT ' + JSON.stringify(entry))
  report.push(entry)
}
console.log('PROBE262_ROOTS_DONE ' + JSON.stringify({ roots: report.length, runs }))
