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
  on macOS 6 of 12 jobs dropped one or two of sixty.* Overall 2394/2400 =
  0.99750, delivered-per-job BCa CI **[59.65, 59.93]**.
- Card: 5 (grid ≠ contract) and 1 (single cell ≠ general). **The published
  comments still carry the old sentence** — they have not been re-published with
  this correction, and that is tracked as an open action, not as done.

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
| Re-published the three comments with the macOS correction (A7) | the published text still says "60/60 seeds"; until it is patched, a reader gets the wrong scope |
| Raised the job count to fix power 0.53 | the L3 ratio stays inconclusive; ~90 jobs would be needed at the measured effect size |
| Instrumented the driver for I4 (stale handle) | the model says the state is reachable; the driver side is unmeasured, so I4 stays an obligation |
| Explained `FS_LAYERS_WHEN_SPY_INTERCEPTED = 0` | recorded as O4, not cited |
| Re-tested the Windows 8.3 abort on 26.x | the earlier note that it does not reproduce is carried forward unverified (O5) |
