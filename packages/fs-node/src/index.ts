import { BaseFs, Watcher } from '@cordisjs/fs'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchPath } from './watcher.ts'

// `C:` is relative to the current directory of drive C, which depends on the
// process. A separator after the colon names a location.
const driveRelative = /^[a-zA-Z]:(?![\\/])/

function toPath(url: URL) {
  const filename = fileURLToPath(url)
  // checked before `resolve()`, which makes a drive-relative path absolute
  if (process.platform === 'win32' && driveRelative.test(filename)) {
    throw new TypeError(
      `expected an absolute path, got the drive-relative form ${JSON.stringify(filename)} from ${JSON.stringify(url.href)}`,
    )
  }
  // `fileURLToPath()` keeps a trailing slash
  return resolve(filename)
}

/** The local file system of Node.js. */
class NodeFs extends BaseFs {
  static mount = 'file:'

  /**
   * The type the location has now, read with one `stat`. `throwIfNoEntry: false`
   * only covers `ENOENT` and `ENOTDIR`; the rest still raise, so an unreadable
   * location -- a symlink loop, a permission wall, a dropped mount -- answers
   * `undefined` rather than taking the call down.
   */
  shape(url: URL): 'file' | 'dir' | undefined {
    try {
      const stats = statSync(fileURLToPath(url), { throwIfNoEntry: false })
      if (!stats) return undefined
      return stats.isDirectory() ? 'dir' : 'file'
    } catch {
      return undefined
    }
  }

  watch(watcher: Watcher) {
    return watchPath(watcher, toPath(watcher.url))
  }
}

export default NodeFs
