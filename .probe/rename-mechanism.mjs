// Probe 262: the driver watches a file through its parent because, per the code
// comment, a file replaced through a rename "is lost by a watch on the file
// itself". This measures the rename event and, more importantly, whether the
// watch still reports a later write to the same path.
import { mkdirSync, mkdtempSync, renameSync, rmSync, watch as rawWatch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { watch } from 'chokidar'

const runs = Number(process.env.PROBE262_RUNS || 5)
const settle = Number(process.env.PROBE262_SETTLE_MS || 900)
const base = mkdtempSync(join(process.env.PROBE262_BASE || process.env.RUNNER_TEMP || tmpdir(), 'cordis-262-rename-'))
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function once(mode, run) {
  const dir = join(base, mode, `run${run}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'watched.txt')
  writeFileSync(file, 'seed')
  await sleep(300)
  const events = []
  let close
  if (mode === 'raw-file') {
    // node:fs.watch on the file itself, no chokidar parent fallback
    const watcher = rawWatch(file)
    watcher.on('change', () => events.push('change:watched.txt'))
    watcher.on('rename', () => events.push('rename:watched.txt'))
    watcher.on('error', () => {})
    close = () => watcher.close()
  } else {
    const watcher = mode === 'file'
      ? watch(file, { ignoreInitial: true })
      : watch(dir, {
        ignoreInitial: true,
        depth: 0,
        ignored: (path) => {
          path = path.replace(/\\/g, '/')
          const rel = relative(dir, path).replace(/\\/g, '/')
          return rel !== '' && rel !== 'watched.txt'
        },
      })
    watcher.on('all', (event, path) => events.push(`${event}:${relative(dir, path).replace(/\\/g, '/')}`))
    await new Promise(resolve => watcher.once('ready', resolve))
    close = () => watcher.close()
  }
  await sleep(150)
  writeFileSync(file + '.tmp', 'v')
  renameSync(file + '.tmp', file)
  await sleep(settle)
  const rename = events.splice(0)
  // The replacement is in place. A watch that followed the old inode must stay
  // silent here; a watch that follows the path must report it.
  writeFileSync(file, 'later')
  await sleep(settle)
  const later = events.splice(0)
  await close()
  rmSync(dir, { recursive: true, force: true })
  return { rename, later }
}

const out = { platform: process.platform, node: process.version, runs }
for (const mode of ['file', 'parent', 'raw-file']) {
  const readings = []
  for (let run = 1; run <= runs; run++) readings.push(await once(mode, run))
  out[mode] = readings
}
console.log('PROBE262_RENAME ' + JSON.stringify(out))
rmSync(base, { recursive: true, force: true })
