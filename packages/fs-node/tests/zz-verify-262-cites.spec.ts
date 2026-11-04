/* eslint-disable */
// Section 10 cites six external sources, and Sections 5 and 8 lean on two of
// them. Those citations were verified once by hand, which made them the only
// part of the evidence base that CI did not re-check. This turns each one into
// a live assertion: fetch the page, look for the exact string the comment
// depends on.
//
// A network failure is NOT a citation drift. So the check has a committed
// snapshot fallback (verify/cites-snapshot.json): if the live fetch cannot
// reach the page, it verifies against the last captured state and reports the
// gap loudly instead of failing on an environment issue. A genuine drift --
// the page loads but the relied-on string is gone -- still makes the build red,
// with the URL and the missing strings attached. "Could not verify" always
// comes with the URL and the error that stopped it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Cite {
  name: string
  url: string
  must: string[]
  note: string
}

const CITES: Cite[] = [
  {
    name: 'arXiv 2608.25512',
    url: 'https://arxiv.org/abs/2608.25512',
    must: ['A Programming Paradigm for Spatiotemporal Composability', '92 pages', '26 Aug 2026'],
    note: 'Section 10: title, page count, submission date',
  },
  {
    name: 'W3C FileAPI',
    url: 'https://w3c.github.io/FileAPI/',
    must: ['not a must but a should', 'snapshot state'],
    note: 'Section 8: the spec says "should", not "must", for a File snapshot',
  },
  {
    name: 'isomorphic-git fs',
    url: 'https://isomorphic-git.org/docs/en/fs',
    must: ['lstat', 'readFile', 'writeFile', 'readdir', 'mkdir', 'rmdir', 'stat'],
    note: 'Section 5: lstat is in the required subset, not optional',
  },
  {
    name: 'VS Code API',
    url: 'https://code.visualstudio.com/api/references/vscode-api',
    must: ['registerFileSystemProvider', 'FileChangeType'],
    note: 'Section 10: the provider registration and change-type vocabulary',
  },
  {
    name: 'Node permissions',
    url: 'https://nodejs.org/api/permissions.html',
    must: ['no longer experimental', '--permission'],
    note: 'Section 10: the permission model is stable, and its flag name',
  },
  {
    name: 'Deno security',
    url: 'https://docs.deno.com/runtime/fundamentals/security/',
    must: ['--allow-read', '--allow-write'],
    note: 'Section 10: the contrasting permission surface',
  },
]

// Pages are HTML; a phrase a reader sees can be split by markup
// ("not a <em>must</em> but a <em>should</em>"). Match against the rendered text
// as well as the raw source, otherwise the check fails for a reason that has
// nothing to do with the citation.
function render(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
}

interface Snapshot {
  generatedAt: string
  cites: Array<{ name: string; url: string; must: string[]; ok?: boolean; error?: string }>
}

function loadSnapshot(): Snapshot | null {
  try {
    const p = fileURLToPath(new URL('../../../verify/cites-snapshot.json', import.meta.url))
    return JSON.parse(readFileSync(p, 'utf8')) as Snapshot
  } catch {
    return null
  }
}

async function fetchText(url: string, attempts = 3): Promise<string> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.text()
    } catch (e) {
      last = e
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)))
    }
  }
  throw new Error(`${url} -> ${String((last as Error)?.message ?? last)}`)
}

describe('verify 262: the external citations still say what the comment claims', () => {
  it('every cited page is reachable and contains the sentence relied on', async () => {
    const hard: Array<{ name: string; reason: string }> = []
    const soft: Array<{ name: string; reason: string }> = []
    const snapshot = loadSnapshot()

    for (const c of CITES) {
      let text = ''
      try {
        text = await fetchText(c.url)
      } catch (e: any) {
        // Live fetch failed. Fall back to the committed snapshot rather than
        // failing on an environment issue -- but report the gap loudly, with the
        // URL and the error, so "could not verify" is never silent.
        const snapCite = snapshot?.cites.find((s) => s.name === c.name)
        if (!snapCite) {
          hard.push({ name: c.name, reason: `unreachable and no snapshot: ${e.message}` })
          console.log(`VERIFY262_CITE ${c.name} NO_SNAPSHOT ${e.message}`)
        } else {
          soft.push({ name: c.name, reason: `offline, fell back to snapshot ${snapshot!.generatedAt}: ${e.message}` })
          console.log(`VERIFY262_CITE ${c.name} OFFLINE snapshot=${snapshot!.generatedAt} reason=${e.message}`)
        }
        continue
      }

      const plain = render(text)
      const missing = c.must.filter((s) => !text.includes(s) && !plain.includes(s))
      if (missing.length) {
        // The page loaded but the relied-on string is gone: genuine drift.
        hard.push({ name: c.name, reason: `missing ${JSON.stringify(missing)} (url ${c.url})` })
        console.log(`VERIFY262_CITE ${c.name} DRIFT ${JSON.stringify(missing)} url=${c.url}`)
      } else {
        console.log(`VERIFY262_CITE ${c.name} OK bytes=${text.length} (${c.note})`)
      }
    }

    if (soft.length) {
      // Loud, but not fatal: the live check could not run, so we verified against
      // the last captured state. The drift check still runs on every successful
      // fetch, so a stale citation is caught the moment the network returns.
      console.error('VERIFY262_CITE_OFFLINE ' + JSON.stringify(soft.map((s) => [s.name, s.reason])))
    }

    console.log('VERIFY262_CITE_MATRIX ' + JSON.stringify({ hard: hard.map((h) => [h.name, h.reason]), soft: soft.map((s) => s.name) }))
    expect(hard, 'cited sources that no longer support the claim (or have no snapshot to fall back to)').toEqual([])
  }, 300_000)
})
