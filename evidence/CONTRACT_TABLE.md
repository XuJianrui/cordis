# Contract table — `ctx.fs` watch contract, compressed

`EVIDENCE_MATRIX.md` is the audit trail. This file is the conclusion: the same
material compressed into equivalence classes, a decision table, invariants, and
the counter-conditions that would falsify each one.

**Rule of use.** Cite a row here only together with its invariant and its
counter-condition. Citing "it works" without the counter-condition is what this
file exists to prevent.

---

## 1. Equivalence classes

The 33 adjudication rows and every probe collapse into five classes. Behaviour
inside a class is interchangeable; between classes it is not.

| class | members | what is constant inside it | what varies |
| :--- | :--- | :--- | :--- |
| **C1 — Delivery** | 7a, 7b, 7e, N6 | one watcher, one write, one delivery **on ubuntu and windows** | count on macOS (see C2) |
| **C2 — Platform multiplicity** | N6, 7b | the *shape* of the event stream (path, type, ordering) | **number** of events per write: 1.004 on linux/win, 0.997 delivered on macOS |
| **C3 — Lifecycle** | 7c, 7d, 3a, 5c | teardown is observable: 0 callbacks after stop, pending `next()` settles | latency of settle, not its occurrence |
| **C4 — Capability gating** | 4b, 5d, 2b | an unimplemented operation reports `SKIP`/`ENOTSUP`, never a silent pass | which capabilities a backend declares |
| **C5 — Path and permission** | 1a–1d, 2a, 2c–2e, 4a, 4c, 5a, 5b, 5e, 6a–6c, 8a–8c, 9a, 9b, 10 | a URL is either inside the grant or refused; no third state | operator chosen for the intercept zero value |

**Why C2 is separate from C1.** C1 is a claim about the *contract*. C2 is a
claim about a *platform*. Merging them is exactly the error the published
comments made: "60/60 seeds" was C1 evidence read as if it covered C2.

---

## 2. Decision table

Conditions, not prose. `D` = delivered, `E` = extra event, `—` = not applicable.

| # | platform | buffer at registration | write count | predicted deliveries | counter-condition that would falsify |
| :-- | :--- | :--- | :--- | :--- | :--- |
| T1 | linux / windows | cleared | n | **exactly n** | any job with delivered ≠ n (none in 28 jobs × 60) |
| T2 | macOS | cleared | n | **exactly n**, provided the measured write lands after the registration window | any job with delivered ≠ n *after* the counter reset (none in 2 jobs × 60, measured) |
| T2′ | macOS | cleared | 1, issued immediately after `watch()` resolves | **0 or 1** — the registration window can swallow it | a seed delivering 0 with the write issued ≥ p99 after resolution |
| T3 | any | not cleared | n | **> n reachable** (buffer keeps the registration write) | a model run where `AtMostOnePerWrite` survives `ClearMode="uncleared"` |
| T4 | any | — | watch disposed | **0 subsequent callbacks** | any callback after `stop()` |
| T5 | any | — | `break` with a pending `next()` | pending settles `{done:true}` | a pending promise that never settles |
| T6 | any | — | operation the driver lacks | `SKIP` / `ENOTSUP` | a missing capability reported as `PASS` |
| T7 | any | — | watch registered before the path exists, then `mkdir` | shape must re-resolve or the handle must be marked stale | a live handle that is neither re-resolved nor marked stale |

T2 was previously written as "macOS drops 1–2 of 60". That was the probe's
setup write colliding with the measured one; with the counter reset after
settling, both macOS lines deliver 60/60. T2′ is the condition that replaced it,
and it is the one that survives: **a write issued immediately after `watch()`
resolves can fall inside the registration window and be swallowed.** The window
is measured, not assumed — 58/60 and 59/60 seeds on macOS received an event for
a write made *before* registration despite `ignoreInitial: true`, with p99
latency 23–39 ms.

T3 is backed by the model (`NeverStale` violated in 2 steps) and by the
observation that a later-created directory delivers nothing. It is **not**
backed by a rate: no run measured how often a real consumer hits it.


---

## 3. Invariants

Each is checkable, and each names what its own violation would look like.

| id | invariant | form | violation | status |
| :--- | :--- | :--- | :--- | :--- |
| **I1** | No delivery after dispose | `∀ h • disposed(h) ⇒ callbacks(h) = 0` | a callback with `disposed = true` | holds, 5/5 jobs, model `NoCallbackAfterDispose` |
| **I2** | One delivery per write | `∀ w • deliveries(w) = 1`, measured after the registration window closes | any job with ≠ 1 after a settle+reset | holds: 28/28 linux/win jobs, **2/2 macOS jobs 60/60** |
| **I3** | Skips are not passes | `capability(x) = false ⇒ verdict(x) = SKIP` | `PASS` with capability false | holds, 34/34, zero variance |
| **I4** | A stale handle is never silently live | `∀ h • (shape(h) ≠ actualShape) ⇒ (re-resolved(h) ∨ stale(h))` | live, shape-mismatched, not re-resolved | **model says reachable**; driver not instrumented for it |
| **I5** | Absence of a reading is not a reading | `unmeasured(x) ⇒ ¬ assert(x)` | an `[HYPOTHESIS]` cited as settled | enforced by the ledger, not by code |
| **I6** | Count is not delivery | `rawCallbacks ≤ 3` says nothing about `deliveries` | inferring a stop from a capped count | **held in practice**: raw 0.2 vs 15.6 delivered per job |
| **I7** | Registration settles before it reports ready | `watch()` resolves ⇒ writes after resolution are delivered | a write issued after `await watch()` that produces no event | **does not hold**: 58/60 and 59/60 seeds on macOS saw a pre-registration write leak, so the window is open at resolve time |

I4 is the interesting one. The model cannot refute it — it *confirms* the
violation is reachable. So I4 is not a property the implementation has; it is a
property the implementation **owes**. Written as an obligation, not a fact.

---

## 4. Counter-conditions (what would make each conclusion wrong)

This is the section that makes the rest usable. For each headline claim, the
single cheapest observation that kills it.

| claim | dies if |
| :--- | :--- |
| "One event per write" | a single linux or windows job delivers ≠ n. **Currently 0 of 28.** |
| "macOS drops events" | **RETIRED** — with a 300 ms settle and a counter reset, both macOS lines deliver 60/60. The zeros were the probe's setup write colliding with the measured one. |
| "`watch()` is safe to write to immediately" | a seed losing the write when it is issued after the window closes. **Currently I7 does not hold: the window is still open at resolve time.** |
| "The driver is not the raw layer" | `L2`/`L3` ratios converge to `L0`/`L1` (≈1.87). **Currently 1.004 vs 1.873.** |
| "Skips are honest" | any `PASS` for a capability the driver declares `false`. **Currently 0 of 34.** |
| "Stale is reachable" | `MC-stale` returning clean at larger bounds. **Currently violated at MaxPending = 3, MaxWrites = 3.** |
| "Abort is real, not a no-op" | a trial returning a non-`ABORT_ERR` code, or latency ≥ control. **Currently 140/140 `ABORT_ERR`, ~3 ms vs ~40 ms.** |

---

## 5. What this table refuses to conclude

| tempting conclusion | why it is refused |
| :--- | :--- |
| "The contract is satisfied" | 2 of 5 capabilities are `SKIP` on the real driver; T7 is an obligation, not a fact |
| "macOS is broken" | the shortfall is real, the *cause* is not measured (O1). "Drops 1–2 of 60 on macOS" is the claim; "macOS is unreliable" is not |
| "1.0044 events per write proves duplicates" | power 0.53. The interval excludes 1.0 by 0.0011; that is not a demonstration |
| "The model proves no stale handle in production" | bounded to 3 pending / 3 writes, and it abstracts async callbacks as atomic steps |
| "33 rows are all decided" | 6 rows (`5c`, `7c`, `7d`, `8c`, `9a`, `9b`) are trade-offs decided on reversal cost, not on a reading |

---

## 6. Minimal baseline for a maintainer reading this cold

Three things, in this order. Everything else is reversible default.

1. **Deliver one event per write, and say which platforms you mean.** linux and
   windows: 28/28 exact. macOS: 6/12 short by 1–2 of 60. If the contract does
   not promise macOS exactness, say so in the sentence; if it does, this is a
   bug with a measured rate.
2. **Keep skips visible.** `DELETE` and `RERESOLVE` are `SKIP` on the real
   driver because the driver declares them absent. Do not let a suite report
   those as green.
3. **Decide whether a stale handle is the interface's problem.** The model says
   the state is reachable in two steps; the interface either re-resolves or
   marks the handle stale. Today it does neither, which is the only item here
   that is a contract gap rather than a phrasing gap.
