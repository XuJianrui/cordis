import { mkdirSync, mkdtempSync, lstatSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = mkdtempSync(join(tmpdir(), 'cordis-262-symlink-'))
const results = []

for (let run = 1; run <= 5; run++) {
  const dir = join(base, `run${run}`)
  mkdirSync(dir, { recursive: true })

  const fileTarget = join(dir, 'file-target.txt')
  const fileLink = join(dir, 'file-link')
  writeFileSync(fileTarget, 'x')
  const file = { kind: 'file', run }
  try {
    symlinkSync(fileTarget, fileLink)
    file.create = 'ok'
    file.lstat = lstatSync(fileLink).isSymbolicLink() ? 'symlink' : 'other'
    rmSync(fileLink)
    file.rm = 'ok'
    file.targetIntact = statSync(fileTarget).isFile()
  } catch (error) {
    file.error = error.code || error.message
  }
  results.push(file)

  const dirTarget = join(dir, 'dir-target')
  const dirLink = join(dir, 'dir-link')
  mkdirSync(dirTarget)
  writeFileSync(join(dirTarget, 'keep.txt'), 'x')
  const directory = { kind: 'dir', run }
  try {
    symlinkSync(dirTarget, dirLink)
    directory.create = 'ok'
    directory.lstat = lstatSync(dirLink).isSymbolicLink() ? 'symlink' : 'other'
    rmSync(dirLink, { recursive: true, force: true })
    directory.rm = 'ok'
    directory.targetIntact = statSync(join(dirTarget, 'keep.txt')).isFile()
  } catch (error) {
    directory.error = error.code || error.message
  }
  results.push(directory)
}

console.log('SYMLINK_ENV ' + JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }))
for (const result of results) console.log('SYMLINK_RUN ' + JSON.stringify(result))
console.log('SYMLINK_SUMMARY ' + JSON.stringify({
  total: results.length,
  created: results.filter(result => result.create === 'ok').length,
  lstatSymlink: results.filter(result => result.lstat === 'symlink').length,
  removed: results.filter(result => result.rm === 'ok').length,
  targetsIntact: results.filter(result => result.targetIntact).length,
}))

rmSync(base, { recursive: true, force: true })