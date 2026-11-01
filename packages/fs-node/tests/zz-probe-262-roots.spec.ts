/* eslint-disable */
// Probe 262: the real driver (`ctx.fs.watch`) on non-default filesystems.
// Prepares the mounts itself (CI runners allow passwordless sudo / admin), then
// logs one JSON line per root. PROBE262_ROOTS overrides the prepared list.
import { execFileSync } from 'node:child_process'
import { Context } from 'cordis'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import Fs from '../src/index.ts'

const runs = Number(process.env.PROBE262_RUNS || 3)
const settle = Number(process.env.PROBE262_SETTLE_MS || 900)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

function prepareRoots(): string {
  if (process.env.PROBE262_ROOTS) return process.env.PROBE262_ROOTS
  const rt = process.env.RUNNER_TEMP || tmpdir()
  const script = process.platform === 'win32'
    ? '.probe/setup-windows.ps1'
    : process.platform === 'darwin' ? '.probe/setup-macos.sh' : '.probe/setup-linux.sh'
  try {
    const command = process.platform === 'win32' ? 'powershell' : 'bash'
    const args = process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, script)]
      : [resolve(root, script)]
    const output = execFileSync(command, args, { encoding: 'utf8', timeout: 600_000 })
    console.log('PROBE262_SETUP\n' + output)
  } catch (error: any) {
    console.log('PROBE262_SETUP_FAILED ' + (error?.message ?? error))
  }
  try {
    const status = readFileSync(join(rt, 'mount-status.txt'), 'utf8')
    console.log('PROBE262_MOUNT_STATUS\n' + status)
  } catch {}
  try {
    return readFileSync(join(rt, 'roots.txt'), 'utf8').split('\n').map(s => s.trim()).filter(Boolean).join(';')
  } catch {
    return ''
  }
}

function parseRoots() {
  const raw = process.env.PROBE262_ROOTS || ''
  const list = raw.split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf('=')
    return { label: s.slice(0, i), path: s.slice(i + 1) }
  })
  return list.length ? list : [{ label: 'tmp', path: process.env.RUNNER_TEMP || process.cwd() }]
}

const cases: [string, (dir: string, file: string) => any][] = [
  ['write', (dir, file) => writeFileSync(file, 'v')],
  ['delete', (dir, file) => rmSync(file, { force: true })],
  ['recreate-200', async (dir, file) => {
    rmSync(file, { force: true })
    await sleep(200)
    writeFileSync(file, 'v')
  }],
  ['atomic-rename', (dir, file) => {
    writeFileSync(file + '.tmp', 'v')
    renameSync(file + '.tmp', file)
  }],
  ['mkdir-inside', (dir) => mkdirSync(join(dir, 'sub'), { recursive: true })],
  ['nested-create', (dir) => {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'deep.txt'), 'v')
  }],
]

async function measure(base: string, shape: 'file' | 'dir', name: string, op: (dir: string, file: string) => any) {
  const readings: string[][] = []
  for (let run = 1; run <= runs; run++) {
    const dir = join(base, 'driver', shape, name, `run${run}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'watched.txt')
    writeFileSync(file, 'seed')
    await sleep(200)
    const seen: string[] = []
    const root = new Context()
    const fiber = await root.plugin(Fs)
    try {
      const stop = await root.fs.watch(shape === 'file' ? file : dir, (filename) => { seen.push(filename) })
      await sleep(150)
      await op(dir, file)
      await sleep(settle)
      await stop()
    } finally {
      await fiber.dispose()
    }
    readings.push(seen.map(p => p.replace(dir, '').replace(/\\/g, '/')))
    rmSync(dir, { recursive: true, force: true })
  }
  return readings
}

async function missingPath(base: string) {
  const out: any = {}
  // missing -> file
  {
    const dir = join(base, 'driver', 'missing', 'as-file')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'later.txt')
    const seen: string[] = []
    const root = new Context()
    const fiber = await root.plugin(Fs)
    try {
      const stop = await root.fs.watch(file, (filename) => { seen.push(filename) })
      await sleep(150)
      writeFileSync(file, 'v')
      await sleep(settle)
      await stop()
    } finally {
      await fiber.dispose()
    }
    out.asFile = seen.map(p => p.replace(dir, ''))
  }
  // missing -> directory with a file inside
  {
    const dir = join(base, 'driver', 'missing', 'as-dir')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const target = join(dir, 'later')
    const seen: string[] = []
    const root = new Context()
    const fiber = await root.plugin(Fs)
    try {
      const stop = await root.fs.watch(target, (filename) => { seen.push(filename) })
      await sleep(150)
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'inside.txt'), 'v')
      await sleep(settle)
      await stop()
    } finally {
      await fiber.dispose()
    }
    out.asDir = seen.map(p => p.replace(dir, ''))
  }
  rmSync(join(base, 'driver', 'missing'), { recursive: true, force: true })
  return out
}

it('probe 262: real driver on each root', async () => {
  const roots = prepareRoots()
  process.env.PROBE262_ROOTS = roots
  try {
    const output = execFileSync(process.execPath, [resolve(root, '.probe/roots.mjs')], {
      encoding: 'utf8',
      timeout: 900_000,
      env: { ...process.env, PROBE262_ROOTS: roots },
    })
    console.log(output)
  } catch (error: any) {
    console.log('PROBE262_GRID_FAILED ' + (error?.message ?? error))
  }
  for (const root of parseRoots()) {
    const result: any = { label: root.label, path: root.path, platform: process.platform, node: process.version, cells: {} }
    try {
      mkdirSync(root.path, { recursive: true })
      for (const shape of ['file', 'dir'] as const) {
        for (const [name, op] of cases) {
          result.cells[`${shape}:${name}`] = await measure(root.path, shape, name, op)
        }
      }
      result.missing = await missingPath(root.path)
    } catch (error: any) {
      result.error = error?.code ?? error?.message
    }
    console.log('PROBE262_DRIVER ' + JSON.stringify(result))
  }
}, 600_000)
