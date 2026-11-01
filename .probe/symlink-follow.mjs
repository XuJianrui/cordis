// Probe 262: does `stat` follow a symlink while `lstat` does not, and do
// `rm` / recursive `rm` leave the target alone? Run on every runner.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(process.env.PROBE262_BASE || process.env.RUNNER_TEMP || tmpdir(), 'cordis-262-link-'))
const out = { platform: process.platform, node: process.version, base }

function attempt(name, fn) {
  try {
    out[name] = { ok: true, value: fn() }
  } catch (error) {
    out[name] = { ok: false, error: error.code ?? error.message }
  }
}

const target = join(base, 'target.txt')
writeFileSync(target, 'payload')
const link = join(base, 'link.txt')

attempt('fileLink', () => { symlinkSync(target, link); return true })
if (out.fileLink.ok) {
  attempt('statFollowsFile', () => statSync(link).isFile())
  attempt('lstatLink', () => lstatSync(link).isSymbolicLink())
  attempt('readThroughLink', () => readFileSync(link, 'utf8'))
  attempt('rmLinkOnly', () => { rmSync(link); return statSync(target).isFile() })
}

const dir = join(base, 'dir')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'inside.txt'), 'x')
const dirLink = join(base, 'dirlink')

attempt('dirLink', () => { symlinkSync(dir, dirLink, 'dir'); return true })
if (out.dirLink.ok) {
  attempt('statFollowsDir', () => statSync(dirLink).isDirectory())
  attempt('readdirThroughLink', () => readdirSync(dirLink))
  attempt('rmRecursiveLinkOnly', () => { rmSync(dirLink, { recursive: true, force: true }); return statSync(join(dir, 'inside.txt')).isFile() })
}

const dangling = join(base, 'dangling.txt')
attempt('danglingLink', () => { symlinkSync(join(base, 'missing.txt'), dangling); return true })
if (out.danglingLink.ok) {
  attempt('statDangling', () => statSync(dangling).isFile())
  attempt('lstatDangling', () => lstatSync(dangling).isSymbolicLink())
}

console.log('PROBE262_LINK ' + JSON.stringify(out))
rmSync(base, { recursive: true, force: true })
