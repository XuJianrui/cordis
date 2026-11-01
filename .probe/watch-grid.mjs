import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { watch } from 'chokidar'

const settleMs = Number(process.env.PROBE262_SETTLE_MS || 500)
const runs = Number(process.env.PROBE262_RUNS || 5)
const base = mkdtempSync(join(process.env.PROBE262_BASE || process.env.RUNNER_TEMP || tmpdir(), 'cordis-262-grid-'))
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const cells = [
  ['write', async (dir, file) => { writeFileSync(file, 'v') }],
  ['delete', async (dir, file) => { rmSync(file, { force: true }) }],
  ...['0', '20', '200', '1000', '1500'].map(ms => [`recreate-${ms}`, async (dir, file) => {
    rmSync(file, { force: true })
    await sleep(Number(ms))
    writeFileSync(file, 'v')
  }]),
  ['atomic-rename', async (dir, file) => {
    writeFileSync(file + '.tmp', 'v')
    renameSync(file + '.tmp', file)
  }],
  ['mkdir-inside', async (dir) => { mkdirSync(resolve(dir, 'sub'), { recursive: true }) }],
  ['sibling-create', async (dir) => { writeFileSync(resolve(dir, 'sibling.txt'), 'v') }],
  ['nested-file-create', async (dir) => {
    mkdirSync(resolve(dir, 'nested'), { recursive: true })
    writeFileSync(resolve(dir, 'nested/deep.txt'), 'v')
  }],
]

const results = []
for (const shape of ['file', 'dir']) {
  for (const [name, op] of cells) {
    for (let run = 1; run <= runs; run++) {
      const dir = join(base, shape, name, `run${run}`)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'watched.txt')
      writeFileSync(file, 'seed')
      const raw = []
      const cb = []
      const isFile = shape === 'file'
      const watcher = watch(dir, {
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
        if (!isFile || resolve(path) === file) cb.push(`add:${relative(dir, path).split(sep).join('/')}`)
      })
      watcher.on('change', (path) => {
        if (!isFile || resolve(path) === file) cb.push(`change:${relative(dir, path).split(sep).join('/')}`)
      })
      await new Promise(resolve => watcher.once('ready', resolve))
      await op(dir, file)
      await sleep(settleMs)
      await watcher.close()
      results.push({ label: `${shape}/${name}-run${run}`, shape, raw, cb })
    }
  }
}

const chokidar = JSON.parse(readFileSync(resolve('node_modules/chokidar/package.json'), 'utf8')).version
console.log('GRID_ENV ' + JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  chokidar,
  settleMs,
  runs,
  tmpdir: base,
}))

const grouped = new Map()
for (const result of results) {
  const cell = result.label.replace(/-run\d+$/, '')
  if (!grouped.has(cell)) grouped.set(cell, [])
  grouped.get(cell).push(JSON.stringify({ raw: result.raw, cb: result.cb }))
}
for (const [cell, readings] of grouped) {
  console.log(`GRID_CELL ${cell} ${JSON.stringify([...new Set(readings)])}`)
}
console.log('GRID_DONE ' + results.length)

writeFileSync(join(process.env.RUNNER_TEMP || tmpdir(), 'probe-262-watch.json'), JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  chokidar,
  settleMs,
  runs,
  results,
}, null, 2) + '\n')

rmSync(base, { recursive: true, force: true })