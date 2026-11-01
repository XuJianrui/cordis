// Probe 262: run the five short-path cases with the Node binary that is
// executing this file. The parent prepares one short root and one long root.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shortRoot = process.argv[2]
const longRoot = process.argv[3]

function run(path, trigger) {
  try {
    const stdout = execFileSync(process.execPath, [join(here, 'shortpath-child.mjs'), path, trigger], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 'ok', events: Number(stdout.match(/SHORTPATH_EVENTS (\d+)/)?.[1] ?? -1) }
  } catch (error) {
    return {
      status: 'error',
      code: error.status,
      stderr: (error.stderr || '').toString().split('\n').filter(Boolean).slice(-1)[0] ?? '',
    }
  }
}

function prepare(root, name) {
  const dir = join(root, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'file.txt'), 'seed')
  return dir
}

const cases = {}
for (const [label, root] of [['short', shortRoot], ['long', longRoot]]) {
  if (!root) continue
  const dir = prepare(root, `probe-262-${label}`)
  const child = join(dir, 'child')
  mkdirSync(child, { recursive: true })
  writeFileSync(join(child, 'file.txt'), 'seed')
  cases[`${label}RootDir`] = run(dir, join(dir, 'trigger.txt'))
  cases[`${label}ChildDir`] = run(child, join(child, 'trigger.txt'))
  cases[`${label}ChildFile`] = run(join(dir, 'file.txt'), join(dir, 'file.txt'))
  rmSync(dir, { recursive: true, force: true })
}

console.log('SHORTPATH_CI ' + JSON.stringify({
  node: process.version,
  shortRoot,
  longRoot,
  cases,
}))
