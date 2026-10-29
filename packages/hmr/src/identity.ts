import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Identity {
  // the realpath, the key of the store, and the `file:` URL the module was
  // loaded from, which is what the rest of hmr speaks
  path: string
  url: string
  // read with `{ bigint: true }`: as numbers, `ino` and `mtimeNs` lose
  // precision — NTFS indices pass 2^53, where two files a step apart
  // collapse into one — and `mtimeNs` is the finest timestamp the stat offers
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  // `Date.now()`, read before the stat: file timestamps come from the same
  // realtime clock, while `performance.now()` is monotonic and not comparable
  observedAt: number
  // the content hash, recorded when the timestamps alone cannot settle the
  // question; reading content costs I/O, so it is skipped otherwise
  hash?: string
}

// Compares module files against their recorded identity: `changed` answers
// whether a file can be proven unchanged, and what cannot be proven counts
// as changed.
export class IdentityStore {
  // realpath -> Identity
  private records = new Map<string, Identity>()
  // url -> realpath, so that when a file is deleted and `toPath(url)` can no
  // longer resolve via realpathSync, its record can still be found and pruned
  private urls = new Map<string, string>()

  // `window`: how long after a write an observation of it stays suspicious,
  // in milliseconds. The write clock ticks about once per millisecond, so an
  // observation taken `window` or more after the last write can trust the
  // timestamps; a younger one cannot, and the content decides instead. The
  // default also covers filesystems that stamp whole seconds.
  constructor(public window = 1000) {}

  observe(url: string): Identity | undefined {
    const path = toPath(url)
    if (!path) {
      this.unobserve(url)
      return undefined
    }
    const oldPath = this.urls.get(url)
    if (oldPath && oldPath !== path) {
      this.records.delete(oldPath)
    }
    this.urls.set(url, path)

    const st = stat(path)
    if (!st) {
      this.unobserve(url)
      return undefined
    }
    // the clock is read before the stat, so the window covers the stat itself
    const observedAt = Date.now()
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

  // Drop the record of a file that no longer resolves. A deleted file has no
  // identity to keep: leaving the record behind would make every later
  // `expand` report the ghost again, forever.
  private unobserve(url: string): boolean {
    const path = this.urls.get(url)
    this.urls.delete(url)
    if (path) return this.records.delete(path)
    return false
  }

  observeAll(urls: Iterable<string>) {
    for (const url of urls) this.observe(url)
  }

  changed(url: string): boolean {
    const path = toPath(url)
    // gone, or resolving somewhere no record was made for
    if (!path) return true
    const rec = this.records.get(path)
    // never observed: the content cannot be proven unchanged
    if (!rec) return true
    const st = stat(rec.path)
    // deleted since the observation
    if (!st) return true
    // a difference proves the change; the reverse does not hold, because a
    // write that lands in the same tick as the recorded one leaves all four
    // fields untouched
    if (st.dev !== rec.dev || st.ino !== rec.ino || st.size !== rec.size) return true
    if (st.mtimeNs !== rec.mtimeNs) return true
    if (this.trustworthy(rec)) return false
    return hashPath(rec.path) !== rec.hash
  }

  // Every recorded or loaded module under `root` whose content cannot be
  // proven unchanged. The directory tree is not walked: only files that are
  // already recorded or loaded can affect the runtime, which is what keeps a
  // `node_modules` root with tens of thousands of files cheap.
  expand(root: string, loaded: Iterable<string>): string[] {
    const rootPath = toPath(root)
    if (!rootPath) return []
    const candidates = new Set<string>()
    for (const rec of this.records.values()) {
      if (under(rec.path, rootPath)) candidates.add(rec.url)
    }
    for (const url of loaded) {
      const path = toPath(url)
      // loaded after the last observation: no record to compare against yet
      if (path && !this.records.has(path) && under(path, rootPath)) {
        candidates.add(url)
      }
    }
    return [...candidates].filter(url => this.changed(url))
  }

  private trustworthy(rec: Identity) {
    const observedAtNs = BigInt(rec.observedAt) * 1_000_000n
    const diff = rec.mtimeNs > observedAtNs ? rec.mtimeNs - observedAtNs : observedAtNs - rec.mtimeNs
    return diff > BigInt(this.window) * 1_000_000n
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
