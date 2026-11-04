# Evidence matrix — `ctx.fs` watch contract

Every claim that appears in the #262 comments, with the reading that backs it,
the scope it holds in, and the run it comes from. A row with no reading is a
claim that has not been evidenced; do not cite it.

**How to read the grades**

| grade | meaning |
| :--- | :--- |
| `MEASURED` | a probe produced a reading; the reading and its interval are below |
| `MODELLED` | a model checker settled it over a bounded state space, not the driver |
| `READ` | a code reading at a named revision, no execution |
| `SCOPED` | measured, but only on the cells named; do not generalise |
| `OPEN` | no reading yet. This row may not be used as a premise |

**Baseline.** `d8b7ea1` (upstream `main`, 2026-10-31) unless a row says
otherwise. All runs are fork runs; the fork is the probe surface.

---

## 1. Watch: one event per write (N6)

| claim | grade | reading | run |
| :--- | :--- | :--- | :--- |
| A fresh watcher delivers exactly one event per write | **SCOPED — ubuntu and windows only** | 28/28 jobs on ubuntu/windows delivered 60/60 seeds. 1680/1680 delivery opportunities. | [41736747356](https://github.com/XuJianrui/cordis/actions/runs/41736747356), [41756237186](https://github.com/XuJianrui/cordis/actions/runs/41756237186) |
| The same holds on macOS | **FALSE as stated** | 6 of 12 macOS jobs fell short: 5 at 59/60, 1 at 58/60. macOS 24: 4/6 full (mean 59.500). macOS 26: 2/6 full (mean 59.333). | same |
| The macOS shortfall is chance | **rejected** | Fisher exact, 6/12 vs 28/28 full jobs: **p = 2.4 × 10⁻⁴** | derived |
| Overall delivery rate | **MEASURED** | 2394/2400 = **0.99750** (40 jobs × 60 seeds). BCa 95% CI on delivered-per-job: **[59.65, 59.93]** | [41769479447](https://github.com/XuJianrui/cordis/actions/runs/41769479447) |
| Event index cannot be used to deduplicate | **MEASURED** | sequence numbers increment per event, so two duplicate events receive two different numbers. 1757 writes observed, `i` range 0–99. | [41736747356](https://github.com/XuJianrui/cordis/actions/runs/41736747356) |

> **This is a correction to the published comments.** They say "60/60 seeds"
> flatly. That is true of the cell that was quoted (a non-macOS cell) and false
> of macOS. The honest sentence is: *one event per write holds on ubuntu and
> windows across 28 jobs; on macOS 6 of 12 jobs dropped one or two of sixty.*

---

## 2. Watch: how many events a write actually produces, per layer

One sample per job (the last `ADJ_LAYER` row), n = 30 jobs, 10 000 BCa
resamples, Holm-corrected across the four ratios.

| layer | events per write | 95% CI | effect vs 1.0 | power | Holm p | significant |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `L0_fileRaw` (raw `fs.watch` on the file) | **1.873** | [1.737, 1.952] | 2.99 | 1.00 | 3.3 × 10⁻¹⁶ | yes |
| `L1_dirRaw` (raw `fs.watch` on the parent) | **1.686** | [1.507, 1.841] | 1.51 | 1.00 | 4.3 × 10⁻⁹ | yes |
| `L2_chokidar` (driver options verbatim) | **1.0044** | [1.0011, 1.0100] | 0.39 | **0.53** | 0.043 | no |
| `L3_ctxfs` (product `ctx.fs.watch`) | **1.0044** | [1.0011, 1.0100] | 0.39 | **0.53** | 0.043 | yes (marginal) |

Run: [41769479447](https://github.com/XuJianrui/cordis/actions/runs/41769479447) · sources: 131 job logs from 19 runs.

**What this settles.** The raw layers fire roughly twice per write while the
driver layers fire once. That gap is why counting raw callbacks and concluding
"delivery stopped" was wrong: the instrument's zero was the instrument's, not
the driver's.

**What it does not settle.** The CI on `L3_ctxfs` excludes 1.0 by a hair
(lower bound 1.0011) but power is **0.53**: at the measured effect size a
30-job sample cannot reliably tell 1.0044 from 1.000. The reading is
**inconclusive, not a confirmation**. Settling it needs ~3× the jobs, not a
re-reading of the same 30.

---

## 3. Watch: lifecycle (ready, stop, iterator, pending next)

| claim | grade | reading | run |
| :--- | :--- | :--- | :--- |
| Registration settles and delivers a first event | **MEASURED with a caveat** | `ADJ_ITER_READY_MS` n=28, mean **6.39 ms** [3, 13]. First-event wait succeeded in **1 of 5** recorded cases (`done:false` ×1, `timeout:true` ×4). | [41736747356](https://github.com/XuJianrui/cordis/actions/runs/41736747356) |
| No callback after stop | **MEASURED** | `ADJ_ITER_AFTER_STOP_CALLBACKS` n=5, **all 0**. | same |
| `break` closes the iterator and settles a pending `next()` | **MEASURED** | `ADJ_ITER_PENDING_SETTLED` `{done:true, resolved:true}` ×5 | same |
| A raw-callback count of 0 means no delivery | **REFUTED** | `ADJ_ITER_STATS.rawCallbacks` n=5, mean **0.2**, max 1 — yet `ADJ_LAYER` shows 15.6 events per job at `L3`. The counter is not the delivery. | same + [41746559054](https://github.com/XuJianrui/cordis/actions/runs/41746559054) |

> The 4-of-5 timeouts are a **probe defect already recorded**: `touchUntil`
> stops writing as soon as one event arrives, so the later "first event" wait
> runs against a file that is no longer being touched. It is not evidence about
> the driver. Do not cite it as such.

---

## 4. Cancellation

| claim | grade | reading | run |
| :--- | :--- | :--- | :--- |
| `signal` aborts a one-shot call | **MEASURED** | 5 trials × 28 jobs = 140 aborts, every one `code=ABORT_ERR`, `name=AbortError`. Trial latency mean **2.86–4.32 ms** across the five trials. | [41736747356](https://github.com/XuJianrui/cordis/actions/runs/41736747356) |
| An unaborted control completes | **MEASURED** | `ADJ_ABORT_CONTROL_MS` n=28, mean **40.07 ms**, range [20, 118]. | same |
| Abort beats completion by a wide margin | **MEASURED, scoped** | ~3 ms vs ~40 ms control, i.e. abort returns an order of magnitude earlier than the work would have finished. Holds on the 6 CI cells; no other platform was tested. | same |

---

## 5. Conformance against the real driver

| capability | verdict | count | meaning |
| :--- | :--- | :--- | :--- |
| `WRITE` | **PASS** | 34/34 | implemented and exercised |
| `STOP` | **PASS** | 34/34 | implemented and exercised |
| `ITERATOR` | **PASS** | 34/34 | implemented and exercised |
| `DELETE` | **SKIP** | 34/34 | driver declares `delete: false`; a skip is reported as a skip, not as a pass |
| `RERESOLVE` | **SKIP** | 34/34 | driver declares `reResolve: false` |

Run: [41736747356](https://github.com/XuJianrui/cordis/actions/runs/41736747356) · 34 job logs, zero variance across them.

**Why the skips matter.** The in-memory backend passes 5/5 including delete and
re-resolve. The real driver's skips are the difference between "the contract is
satisfiable" and "this backend satisfies it", and the comment must not blur
them.

---

## 6. Primitive set and shape (code readings + probes)

| claim | grade | reading | source |
| :--- | :--- | :--- | :--- |
| `ctx.fs` currently exposes two methods | **MEASURED** | `CTX_FS_METHODS.__len = 2` in 58/58 jobs | probe logs |
| `readFile`, `stat`, `writeFile` are absent | **MEASURED** | `HAS_READFILE` / `HAS_STAT` / `HAS_WRITEFILE` all `undefined` in 58/58 jobs | probe logs |
| Node's `writeFile` throws `ENOENT` on a missing parent | **MEASURED** | `NODE_WRITEFILE_MISSING_PARENT = ENOENT` in 58/58 jobs | probe logs |
| `include` never creates a parent directory | **READ** | no `mkdir` in `packages/include/src/index.ts` | code at `d8b7ea1` |
| `loader` does create it explicitly | **READ** | `await mkdir(dir, { recursive: true })` at `packages/loader/src/resolve.ts:80` | code at `d8b7ea1` |
| Intercepting the spy leaves zero fs layers visible | **MEASURED, unexplained** | `FS_LAYERS_WHEN_SPY_INTERCEPTED.__len = 0` in 40/40 jobs; `LAYERS_SEEN = [{"read":["**"]},{}]` | [41736747356](https://github.com/XuJianrui/cordis/actions/runs/41736747356) |
| A narrowed intercept still permits exactly one write | **MEASURED** | `NARROW_ATTEMPT.write.__len = 1` in 40/40 jobs | same |

The `FS_LAYERS_WHEN_SPY_INTERCEPTED = 0` row is **not** in the comments and has
no explanation yet. It is recorded here so it is not lost, and marked
`unexplained` so it is not cited as support for anything.

---

## 7. Model-checked properties

TLC over `evidence/tla/ctxfs.tla`, bounds `MaxPending = 3`, `MaxWrites = 3`.
Each config asserts an **expected** verdict: a checker that can only say "no
error" proves nothing.

| config | expected | actual | violated invariant |
| :--- | :--- | :--- | :--- |
| `MC-cleared` | clean | **clean** | — |
| `MC-uncleared` | violated | **violated** | `AtMostOnePerWrite` |
| `MC-stale` | violated | **violated** | `NeverStale` |

Run: [41769029532](https://github.com/XuJianrui/cordis/actions/runs/41769029532) · `TLC: all 3 cases matched their expected outcome`.

**What this settles.** A stale registration (a file watch on a path that became
a directory) is **reachable** within the bound, and two events for one write are
**reachable** when the buffer is not cleared at registration.

**What it does not settle.** A bounded run is not a proof for unbounded traces,
and the model abstracts asynchronous callbacks into atomic steps. "Reachable at
3 pending, 3 writes" does not say "reachable in production at any rate". The
frequency question is section 1's job, and section 1 is where macOS disagrees
with the rest.

---

## 8. Rows that are still open

| # | question | why it is open |
| :--- | :--- | :--- |
| O1 | Is the macOS shortfall a lost `inotify`/FSEvents event, a coalesced write, or a probe-side race? | nothing isolates the mechanism; the probe records the count, not the cause |
| O2 | What is the true rate at `L3_ctxfs`? | power 0.53 at n=30; needs ~3× the jobs |
| O3 | Does `intercept` default to allow-all in a way a caller can tighten? | no probe; code reading only |
| O4 | Why does intercepting the spy hide every fs layer? | reading recorded, cause unknown |
| O5 | Does the Windows 8.3 abort still reproduce on 26.x? | earlier note says it does not; no run in this batch re-tested it |
