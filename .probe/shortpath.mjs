import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function shortPath(path) {
  try {
    const output = execSync(`for %I in ("${path}") do @echo %~sI`, {
      shell: 'cmd.exe',
      encoding: 'utf8',
      windowsHide: true,
    })
    const line = output.trim().split(/\r?\n/).filter(Boolean).pop()
    return line?.replace(/^"(.*)"$/, '$1')
  } catch {
    return null
  }
}

function run(path, trigger) {
  try {
    const stdout = execFileSync(process.execPath, [join(import.meta.dirname, 'shortpath-child.mjs'), path, trigger], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 'ok', stdout }
  } catch (error) {
    return {
      status: 'error',
      code: error.status,
      signal: error.signal,
      stdout: (error.stdout || '').toString(),
      stderr: (error.stderr || '').toString(),
    }
  }
}

const shortRoot = shortPath(tmpdir())
const longRoot = process.env.RUNNER_TEMP || tmpdir()
const shortDir = join(shortRoot || tmpdir(), 'cordis-262-shortpath-short')
const longDir = join(longRoot, 'cordis-262-shortpath-long')
rmSync(shortDir, { recursive: true, force: true })
rmSync(longDir, { recursive: true, force: true })
mkdirSync(shortDir, { recursive: true })
mkdirSync(longDir, { recursive: true })
writeFileSync(join(shortDir, 'file.txt'), 'seed')
writeFileSync(join(longDir, 'file.txt'), 'seed')

console.log('SHORTPATH_ENV ' + JSON.stringify({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  tmpdir: tmpdir(),
  shortRoot,
  longRoot,
  shortPathAvailable: !!shortRoot && shortRoot.includes('~'),
}))

if (!shortRoot || !shortRoot.includes('~')) {
  console.log('SHORTPATH_SKIP no 8.3 short path available')
  process.exit(0)
}

const cases = {
  shortRootDir: run(shortRoot, join(shortRoot, 'cordis-262-trigger.txt')),
  shortChildDir: run(shortDir, join(shortDir, 'trigger.txt')),
  shortChildFile: run(join(shortDir, 'file.txt'), join(shortDir, 'file.txt')),
  longDir: run(longDir, join(longDir, 'trigger.txt')),
  longFile: run(join(longDir, 'file.txt'), join(longDir, 'file.txt')),
}
for (const [name, result] of Object.entries(cases)) {
  console.log(`SHORTPATH_CASE ${name} ${JSON.stringify(result)}`)
}

rmSync(join(shortRoot, 'cordis-262-trigger.txt'), { force: true })
rmSync(shortDir, { recursive: true, force: true })
rmSync(longDir, { recursive: true, force: true })