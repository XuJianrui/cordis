import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The identity of one module file as of one observation.
 *
 * `path` is the realpath and the key of the store; `url` is the `file:` URL the
 * module was loaded from, which is what the rest of hmr speaks.
 */
export interface Identity {
  path: string
  url: string
  // the volume serial number and the file index together name a file: `ino`
  // repeats across volumes, and read as a `number` it loses precision above
  // 2^53 (NTFS indices reach ~9.007e15, where two distinct files have been
  // observed to collapse into a single number)
  dev: bigint
  ino: bigint
  // `{ bigint: true }` returns every numeric field as a bigint, so there is
  // nothing to convert and no precision to lose
  size: bigint
  // nanosecond mtime, the finest form the stat offers. It does not fix the
  // ~1ms clock that stamps writes (two writes closer than that share a
  // timestamp however it is read), it only keeps what the filesystem recorded
  mtimeNs: bigint
  // `Date.now()`, read before the stat: file timestamps come from the same
  // realtime clock, while `performance.now()` is monotonic and not comparable
  observedAt: number
  // content hash, recorded only when the timestamps alone cannot settle the
  // question (see `changed`): reading content costs I/O, so it is skipped
  // whenever the observation is trustworthy
  hash?: string
}

/**
 * Compares module files against their recorded identity.
 *
 * The disk is the source of truth: `changed` answers whether a file can be
 * proven unchanged, and everything that cannot be proven counts as changed.
 * Watcher events and `reconcile({ roots })` only narrow down which files are
 * asked, so a caller does not need to know which files an operation touched.
 */
export class IdentityStore {
  // realpath -> Identity
  private records = new Map<string, Identity>()

  /**
   * @param window how long after a write an observation of it stays
   * suspicious, in milliseconds. Writes spaced `window` or more apart always
   * advance mtime (measured on NTFS: the write clock ticks about once per
   * millisecond), so an observation taken that long after the last write can
   * trust the timestamps. A younger one cannot: the next write may land in
   * the same tick and leave all three fields untouched. The default of 1000
   * also covers filesystems with 1s timestamp granularity.
   */
  constructor(public window = 1000) {}

  observe(url: string): Identity | undefined {
    const path = toPath(url)
    if (!path) return undefined
    // the clock is read before the stat so that the window covers the stat
    // itself: an mtime within the window of this earlier moment is certainly
    // within it of the stat
    const observedAt = Date.now()
    const st = stat(path)
    if (!st) return undefined
    const record: Identity = {
      path,
      url,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeNs: st.mtimeNs,
      observedAt,
    }
    if (!this.trustworthy(record)) record.hash = hashPath(path)
    this.records.set(path, record)
    return record
  }

  observeAll(urls: Iterable<string>) {
    for (const url of urls) this.observe(url)
  }

  changed(url: string): boolean {
    const path = toPath(url)
    // the file is gone, or resolves somewhere no record was made for
    if (!path) return true
    const rec = this.records.get(path)
    // never observed: the content cannot be proven unchanged
    if (!rec) return true
    const st = stat(rec.path)
    // deleted since the observation
    if (!st) return true
    // A difference proves the file changed. The reverse does not hold: a
    // write that lands in the same tick as the recorded one leaves all three
    // fields untouched, which is why an identical triple is not yet an answer.
    if (st.dev !== rec.dev || st.ino !== rec.ino || st.size !== rec.size) return true
    if (st.mtimeNs !== rec.mtimeNs) return true
    // The timestamps agree, and they only prove "unchanged" when the last
    // write finished `window` or more before the observation: any later write
    // is then spaced from it by more than the clock resolution and had to
    // advance mtime. Otherwise the content itself decides.
    if (this.trustworthy(rec)) return false
    return hashPath(rec.path) !== rec.hash
  }

  /**
   * Every recorded or loaded module under `root` whose content cannot be
   * proven unchanged. The directory tree is not walked: only files that are
   * already recorded or loaded can affect the runtime, which is what keeps a
   * `node_modules` root with tens of thousands of files cheap. A file that is
   * neither, such as one a package operation just added, is not reported.
   */
  expand(root: string, loaded: Iterable<string>): string[] {
    const rootPath = toPath(root)
    if (!rootPath) return []
    const candidates = new Set<string>()
    for (const rec of this.records.values()) {
      if (under(rec.path, rootPath)) candidates.add(rec.url)
    }
    for (const url of loaded) {
      const path = toPath(url)
      // loaded after the last observation: there is no record to compare
      // against yet, and it cannot be proven unchanged
      if (path && !this.records.has(path) && under(path, rootPath)) {
        candidates.add(url)
      }
    }
    return [...candidates].filter(url => this.changed(url))
  }

  /** Drop the record for `path`, e.g. once its module left the graph. */
  forget(path: string) {
    this.records.delete(path)
  }

  private trustworthy(rec: Identity) {
    return rec.mtimeNs < BigInt(rec.observedAt) * 1_000_000n - BigInt(this.window) * 1_000_000n
  }
}

function toPath(url: string) {
  try {
    return realpathSync(fileURLToPath(url))
  } catch {
    return undefined
  }
}

function stat(path: string) {
  try {
    return statSync(path, { bigint: true })
  } catch {
    return undefined
  }
}

function hashPath(path: string) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function under(path: string, root: string) {
  return path === root || path.startsWith(root + sep)
}
