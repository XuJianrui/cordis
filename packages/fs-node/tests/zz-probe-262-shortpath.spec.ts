/* eslint-disable */
// Probe 262: reproduce the 8.3 short-root abort in CI with Node 24.19.0.
// Windows-only. Enables 8.3 name creation, derives a genuine short path, then
// runs the five cases with 24.19.0 and with the job's Node.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const rt = process.env.RUNNER_TEMP || process.cwd()

function ps(command: string) {
  return execFileSync('powershell', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 300_000,
  })
}

it.runIf(process.platform === 'win32')('probe 262: 8.3 short root in CI', () => {
  const drive = rt.slice(0, 2)
  const long = join(rt, 'probe262-shortpath-volume-' + Date.now())
  mkdirSync(long, { recursive: true })
  try {
    ps(`fsutil 8dot3name set ${drive} 0`)
  } catch (error: any) {
    console.log('SHORTPATH_FSUTIL_FAILED ' + (error?.message ?? error))
  }

  let short = ''
  try {
    short = ps(`(New-Object -ComObject Scripting.FileSystemObject).GetFolder("${long}").ShortPath`).trim()
  } catch (error: any) {
    console.log('SHORTPATH_SHORT_FAILED ' + (error?.message ?? error))
  }
  const available = !!short && short !== long && existsSync(short)
  console.log('SHORTPATH_ENV ' + JSON.stringify({ drive, long, short, available }))
  if (!available) return

  const zip = join(rt, 'node-v24.19.0-win-x64.zip')
  const dir = join(rt, 'node-v24.19.0-win-x64')
  const exe = join(dir, 'node.exe')
  if (!existsSync(exe)) {
    try {
      ps(`Invoke-WebRequest -Uri https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip -OutFile "${zip}"; Expand-Archive -Path "${zip}" -DestinationPath "${rt}" -Force`)
    } catch (error: any) {
      console.log('SHORTPATH_DOWNLOAD_FAILED ' + (error?.message ?? error))
    }
  }

  for (const [label, node] of [['24.19.0', exe], ['current', process.execPath]] as const) {
    if (!existsSync(node)) {
      console.log(`SHORTPATH_MISSING ${label}`)
      continue
    }
    try {
      const output = execFileSync(node, [resolve(root, '.probe/shortpath-ci.mjs'), short, long], {
        encoding: 'utf8',
        timeout: 180_000,
      })
      console.log(`SHORTPATH_RUN ${label} ` + output.trim())
    } catch (error: any) {
      console.log(`SHORTPATH_RUN_FAILED ${label} ` + (error?.message ?? error))
      if (error?.stdout) console.log(String(error.stdout))
    }
  }
  try {
    ps(`Remove-Item -LiteralPath "${long}" -Recurse -Force -ErrorAction SilentlyContinue`)
  } catch {}
}, 600_000)
