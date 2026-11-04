# Self-check ledger — #262 evidence round, 2026-11-04

A ledger of statements that were made, then caught, then retracted or rewritten.
An empty ledger means the gate did not run. This one is not empty.

Format: **what was claimed** → *what caught it* → **what replaced it**.

---

## A. Claims retracted

### A1. "Reading job logs returns 403 because the token lacks a scope"

- Caught by: re-testing the same job id three ways —
  `Authorization` + follow redirect → **401**, no header → **403**,
  take the `Location` and fetch it **without** any auth → **200, 18473 bytes**.
- What it actually was: `/actions/jobs/{id}/logs` answers 302 to a
  blob-storage URL, and that store rejects any request carrying an
  `Authorization` header (`400 InvalidAuthenticationInfo`). The bug was in my
  fetcher, not in the token.
- Replaced by: `scripts/fetch_job_logs.py`, two-hop fetch, and
  **`github.token` is sufficient** — no `actions: read` scope exists for classic
  PATs and none is needed.
- Card: 1 (probe defect read as a platform limit). This is the sixth instance of
  the same pattern in this project; the memory file already lists five.

### A2. "The workflow needs an `EVIDENCE_PAT` secret"

- Caught by: the same experiment as A1 succeeding with `github.token`.
- Replaced by: reverting the secret reference. The secret may be deleted.

### A3. "`apalache-0.28.0-linux.tar.gz` is the release asset"

- Caught by: querying the releases API — latest is **v0.62.4**, asset
  `apalache-0.62.4.tgz`. The URL I wrote never existed; the step failed on
  download.
- Replaced by: the real version **and** a `find` for the binary instead of a
  guessed path.

### A4. "The spec needs type annotations"

- Caught by: the Apalache log itself —
  `ctxfs.tla:33:5-33:13: type input error: Expected a type annotation for VARIABLE delivered`.
  That is Snowcat's requirement. The spec was written for **TLC**, which does
  not ask for annotations.
- Replaced by: TLC via `tla2tools.jar` and `evidence/tla/run-tlc.sh`, which
  asserts an **expected verdict per config**. The Apalache route is abandoned,
  not worked around.

### A5. "Bootstrap produced results — 5 readings from 131 logs"

- Caught by: looking at what the five readings were: all categorical, one of
  them `{"timeout":true}`. A parser that finds almost nothing is broken, not a
  finding.
- What it actually was: two bugs stacked. The probes print
  `<ts> ADJ_LAYER = {...}`, and GitHub colourises logs, so ANSI escapes sit
  between the timestamp and the key. My patterns guessed `KEY=<number>`.
- Replaced by: strip ANSI, accept an optional timestamp, parse `KEY = value`,
  flatten numeric JSON fields to `KEY.field`, keep booleans and strings
  categorical. Result: 43 numeric fields and 30 per-job ratio samples.

### A6. "TLC passed" (first green run)

- Caught by: reading the committed JSON instead of the conclusion —
  `"cases": {}` while `"summary"` still parsed. The case regex expected
  `CASE <name>  (expect: …)` but the runner emits
  `CASE <name>  - <description>  (expect: …)`.
- Replaced by: a regex that skips the description, plus recording the
  **violated invariant name** per case. Now `cases` carries all three.

### A7. "One event per write — 60/60 seeds" (published in the comments)

- Caught by: aggregating all 40 jobs instead of reading one cell.
  **34/40 jobs delivered 60/60; 5 delivered 59/60; 1 delivered 58/60.**
  Every shortfall is on macOS (4 on macOS 26, 2 on macOS 24); all 28
  ubuntu/windows jobs were exact. Fisher exact 6/12 vs 28/28: **p = 2.4 × 10⁻⁴**.
- Replaced by: *one event per write holds on ubuntu and windows across 28 jobs;
  on macOS 6 of 12 jobs dropped one or two of sixty.*
- Card: 5 (grid ≠ contract) and 1 (single cell ≠ general).

### A7b. "macOS drops events" — the explanation I was about to publish

- What I wrote first: the shortfall is macOS-side delivery loss, mechanism open.
- Caught by: the user asking **"会不会是你测试本身有bug"**, which is the exact
  question this project has failed to ask seven times before. So I built three
  probes instead of writing the paragraph.
- **n6b** ruled out a short window: adaptive wait, arrival p50 9 ms, p99 15 ms,
  max 15 ms against a 500 ms window; zero seeds late.
  **n6c** ruled out the growing directory: shared-dir arm lost 0, fresh-dir-per-seed
  arm lost 1 — the opposite of the hypothesis.
  **n6d** was then built to test the remaining candidate (a settle window) and
  **produced negative latencies** — p50 −17, −23, −94 ms — which is impossible
  for the write it claimed to measure. n6d was **confounded and is retracted**,
  not reinterpreted: the settle arm was counting the setup write's event.
  **n6e** removed the confounder (settle 300 ms, then **reset the counter**):
  both macOS lines then delivered **60/60, 0 lost, 0 doubled**.
- Replaced by: the seven zeros were the **probe's setup write colliding with the
  measured write**, not a dropped event. The published comments now say so, and
  the correction is live: c2 `73ecc5c5`, c3 `65a7349e`.
- Card: 1 (probe defect read as a platform limit). **This is the eighth
  instance in this project**, and the first one where the user, not the gate,
  raised it.

### A7c. What the failed probe was worth anyway

- n6e also counts events arriving *before* the reset. Those can only come from
  the setup write, made **before** `watch()` was called, with
  `ignoreInitial: true` in force.
- Measured: **58/60 seeds on macOS 24, 59/60 on macOS 26** received such an
  event. So registration suppression is a **window**, not a cut, and the window
  is as wide as the platform's notification latency (p99 23 ms and 39 ms on
  macOS; single digits on inotify — which is why only macOS showed it).
- This is the "first event lost" hypothesis, previously carried as
  `[HYPOTHESIS]` with no mechanism, now with a measured width. Recorded as
  invariant **I7**, which **does not hold**.
- Not a substitute for the retraction: the probe was wrong, *and* it found
  something. Both sentences are required.

### A7d. "A write issued immediately after `await watch()` resolves can be swallowed"

- What I published: that sentence, in c2 and c3. It was an inference from the
  58/60 and 59/60 pre-registration leak, **not a measurement of a post-resolution
  write**.
- Caught by: building n6g to reconcile two readings that disagreed — N6 §1 read
  **1** event for `v0 → watch → v1 immediately`, while n6f read **2** for the same
  sequence with a 300 ms gap. A contradiction between two of my own probes is a
  reason to stop writing, not to pick the more convenient one.
- Result, four arms, 25 seeds each, two changes per seed and nothing else:

  | arm | gap | second write size | macOS 26 | macOS 24 |
  | :--- | :--- | :--- | :--- | :--- |
  | A | 0 ms | 2 B | 1.00 | 1.00 |
  | B | 0 ms | 515 B (257×) | 1.00 | 1.00 |
  | C | 50 ms | 2 B | 1.88 | 1.92 |
  | D | 300 ms | 2 B | 1.96 | 2.00 |

  Source confirms the boundary: chokidar 4.0.3 `node_modules/chokidar/index.js:506`
  throttles `change` per path at **50 ms**. Arm B rules out identity as the key,
  so it is time.
- Replaced by: the write **is delivered, but merged** with the pre-registration
  change into one callback. Two facts now stated instead of one wrong one:
  **I8** (50 ms coalescing, per path) and **I7** (pre-registration delivery on
  macOS only). Both published; c2 `c62cd015`, c3 `7e1ce9cb`.
- Corroborating detail that makes I8 usable: the layer grid spaces writes
  **250 ms** apart, four times the window, which is exactly why it reads 30
  writes as 30 events and never saw the throttle.

### A7e. The contradiction I had to explain before writing anything

`ADJ_N6_EVENTS` reads **1** in 40/40 jobs. n6f reads 1 pre-reset event on 35–38
of 40 seeds. If a pre-registration change leaks, §1 should read 2. It read 1.

That gap is what A7d resolved: §1's two writes are microseconds apart, so the
throttle merges them. **The lesson is procedural**: two probes of mine
disagreeing by a factor of two is not a detail to footnote — it is the whole
question, and it has to be closed before a sentence goes out.

### A8. "`fail-fast: true` frees runner slots, so turn it on"

- Caught by: asking what a cancelled sibling cell costs. This project cites
  **per-cell** readings; cancelling siblings deletes the cross-platform
  comparison that sections 1 and 6 of the matrix exist to provide.
- Replaced by: keep `fail-fast: false`, and write the reason into the workflow
  so the next person does not "optimise" it back.

---

## B. Advice declined

### B1. "Delete `concurrency` — it forces single concurrency"

- Why declined: the group is keyed on the ref and cancels in progress, which is
  the behaviour we want. Removing it lets redundant runs pile up and compete for
  the scarce macOS slots.
- The measured failure mode is different: macOS capacity goes to zero and queued
  jobs are cancelled at **15.0 min** (three observations: 15m01s / 15m00s /
  15m00s, `steps = 0`), while linux and windows start in seconds. That is a
  capacity problem, not a serialisation problem.

### B2. "`trstringer/semaphore-action` for 3 concurrent runs per branch"

- Why declined: the semaphore is a **step**, so the runner is already allocated
  when it waits — it spins while holding one of the five macOS slots. It also
  cannot exceed the plan limit (free: 20 total, 5 macOS), and it adds an
  unaudited third-party action to CI.

---

## C. Production / distribution / consumption count

Counts, because a chain that does not balance is a chain with a hole.

| stage | items | where |
| :--- | :-- | :--- |
| **produced** | 4 ratio series (n=30) | `evidence/statistical/summary.json` |
| | 5 probe rounds (n6, n6b, n6c, n6d-retracted, n6e) | runs 41756237186, 41770958846, 41771498521, 41771644892 |
| | 32 numeric reading series | same |
| | 86 categorical tallies | same |
| | 3 model verdicts | `evidence/tla_results/run_41769029532.json` |
| | 131 raw job logs | artifact `bootstrap-results` |
| **distributed** | 7 sections in the matrix | `evidence/EVIDENCE_MATRIX.md` |
| | 5 equivalence classes, 7 decision rows, 6 invariants, 6 counter-conditions | `evidence/CONTRACT_TABLE.md` |
| **consumed** | every matrix row cites a run or a code location | matrix §1–§7 |
| | every contract row cites an invariant + counter-condition | contract §2–§4 |
| | 8 retractions above cite the observation that killed them | this file §A |

**Unconsumed, deliberately.** `FS_LAYERS_WHEN_SPY_INTERCEPTED.__len = 0`
(40/40 jobs) is recorded in the matrix as *unexplained*. It is not consumed by
any conclusion, and it is not allowed to become one until something explains it.
Listed as O4.

**Known gap.** The raw logs live only in the CI artifact (30-day retention);
the derived tables are committed. The logs are 2.0 MB compressed and were kept
out of the repository on purpose, so any claim that needs re-derivation must be
re-fetched with `scripts/fetch_job_logs.py` while the artifact lives.

---

## D. What this round did not do

| not done | why it matters |
| :--- | :--- |
| ~~Re-published the comments with the macOS correction~~ | **done**: c2 `73ecc5c5`, c3 `65a7349e`, both now say the reset-and-settle result and name the registration window |
| Raised the job count to fix power 0.53 | the L3 ratio stays inconclusive; ~90 jobs would be needed at the measured effect size |
| Instrumented the driver for I4 (stale handle) | the model says the state is reachable; the driver side is unmeasured, so I4 stays an obligation |
| Explained `FS_LAYERS_WHEN_SPY_INTERCEPTED = 0` | recorded as O4, not cited |
| Re-tested the Windows 8.3 abort on 26.x | the earlier note that it does not reproduce is carried forward unverified (O5) |
