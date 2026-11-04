# STRIDE Threat Model — `ctx.fs` Contract

> **Scope**: `packages/fs-node/src/index.ts` — `intercept`, `mount`, `watch`, `rename`, `link` primitives.
> **Baseline**: Decisions 2a, 2d, 4b, 7e, 6c from `ADJUDICATION.md`.
> **Method**: STRIDE per primitive + Attack Trees + Mitigations + Convergence Path.

---

## STRIDE Threat Model

### 1. intercept (ε=U default)

| STRIDE | Threat | Description | Likelihood | Impact | Current Mitigation | Gap |
|---|---|---|---|---|---|---|
| **S** | Spoof intercept config | Attacker injects malicious `P0` via `inject[name]` metadata | Medium | High | None — `mergeIntercept` uses `Object.assign` | No auth on config source |
| **T** | Tamper intercept rules | Modify in-memory intercept map after resolution | Low | High | Single assignment at resolve time | No immutability guarantee |
| **R** | Repudiate grant | No audit trail of which intercept allowed access | Medium | Medium | None | No logging |
| **I** | Info leak via deny | `EINTERCEPT` error reveals path existence | Low | Low | Error code only | Path enumeration possible |
| **D** | DoS via empty intercept | `ε=U` → `∅` annihilates all grants | High | High | Decision 2a: `ε=U` identity | **Default is allow-all** |
| **E** | Elevate via prototype pollution | `Object.assign` prototype pollution | Low | Critical | None | **No prototype guard** |

**Attack Tree Root**: `READ /etc/shadow via intercept bypass`
- AND: Attacker controls `inject[name]` metadata (S)
- AND: `mergeIntercept` returns `{}` for no values (D)
- AND: `resolveIntersect` intersects with `U` (identity)
- → Full grant obtained

---

### 2. mount (protocol dispatch)

| STRIDE | Threat | Description | Likelihood | Impact | Current Mitigation | Gap |
|---|---|---|---|---|---|---|
| **S** | Spoof protocol handler | Register malicious `file:` handler | Medium | High | Dispatch on `url.protocol` | No handler auth |
| **T** | Tamper mount table | Modify `mounts` map at runtime | Low | High | Single initialization | No immutability |
| **R** | Repudiate cross-mount access | No log of cross-scheme traversal | Medium | Medium | None | No audit |
| **I** | Info leak via mount error | `EXDEV` reveals mount boundaries | Low | Low | Error code only | Mount topology leak |
| **D** | DoS via mount loop | Cyclic mount refs → infinite dispatch | Low | Medium | Not checked | **No cycle detection** |
| **E** | Elevate via `..` in `file:` | `file:///app/remote/../etc/passwd` | **High** | **Critical** | Decision 2d: protocol dispatch | **Handler must re-check resolved URL** |

**Attack Tree Root**: `ESCAPE file:// mount via path traversal`
- AND: Mount uses `file:` scheme (T)
- AND: Path prefix normalization allows `..` (E)
- AND: Handler does NOT re-check resolved URL against grant (I)
- → Read arbitrary `file:` paths

---

### 3. watch (TOCTOU on shape registration)

| STRIDE | Threat | Description | Likelihood | Impact | Current Mitigation | Gap |
|---|---|---|---|---|---|---|
| **S** | Spoof watch registration | Register watch on behalf of another fiber | Low | Medium | Fiber-scoped registration | No cross-fiber auth |
| **T** | Tamper watch callback | Swap callback after registration | Low | High | Closure capture | No integrity check |
| **R** | Repudiate event delivery | No proof event was delivered/dropped | Medium | Medium | None | **No delivery receipts** |
| **I** | Info leak via event timing | Event timing reveals FS state | Low | Low | None | Side-channel |
| **D** | DoS via watch leak | Unclosed handles accumulate | Medium | High | `stop()` callable | **No auto-cleanup on fiber death** |
| **E** | Elevate via shape change | File→Dir change bypasses re-resolve | **High** | **High** | Decision 7e: re-resolve by default | **Race: stat→mkdir→watch** |

**Attack Tree Root**: `WATCH MISS on mkdir after file watch`
- AND: Watch registered on missing path (file shape assumed)
- AND: `mkdir` creates directory (E)
- AND: Re-resolution not atomic (TOCTOU window)
- → Directory events never delivered

---

### 4. rename (replace semantics)

| STRIDE | Threat | Description | Likelihood | Impact | Current Mitigation | Gap |
|---|---|---|---|---|---|---|
| **S** | Spoof rename source | Rename attacker-controlled file over target | Medium | High | `intercept` check on source | Source may be allowed |
| **T** | Tamper target | Replace critical file (config, binary) | **High** | **Critical** | Decision 2e: POSIX replace | **No atomic swap guarantee** |
| **R** | Repudiate rename | No audit trail of rename | Medium | Medium | None | No logging |
| **I** | Info leak via `ENOTEMPTY` | Reveals directory non-empty | Low | Low | Error code only | Dir enumeration |
| **D** | DoS via `EBUSY` loop | Rename retry storm | Low | Medium | Decision 3a: abort reads | No backoff specified |
| **E** | Elevate via symlink race | `rename` follows symlink? | Medium | High | Decision 5d: `lstat` kept | **Symlink semantics undefined** |

**Attack Tree Root**: `REPLACE /etc/passwd via rename`
- AND: Attacker has write to source (S)
- AND: `intercept` grants write on target (D)
- AND: POSIX replace semantics (T)
- → Critical file overwritten

---

### 5. link (target check)

| STRIDE | Threat | Description | Likelihood | Impact | Current Mitigation | Gap |
|---|---|---|---|---|---|---|
| **S** | Spoof link creation | Create hardlink to sensitive file | Medium | High | Decision 2c: dual check | **Dangling target case undefined** |
| **T** | Tamper link target | Replace target after check, before link | Medium | High | Check at call time | **TOCTOU window** |
| **R** | Repudiate link | No audit of link creation | Medium | Medium | None | No logging |
| **I** | Info leak via `EEXIST` | Reveals existing link | Low | Low | Error code only | Link enumeration |
| **D** | DoS via link farm | Exhaust inodes | Low | Medium | Not limited | **No quota** |
| **E** | Elevate via cross-device link | `EXDEV` fallback to copy? | Low | Medium | Decision 2d: `EXDEV` | **Copy semantics undefined** |

---

## Attack Trees (Summary)

| ID | Root Threat | Prerequisites (AND) | Critical Path |
|---|---|---|---|
| AT-1 | Read `/etc/shadow` via intercept | Control `inject` metadata + `ε=U` default | S→D→E |
| AT-2 | Escape `file://` mount via `..` | Mount `file:` + no re-check on resolved | T→E |
| AT-3 | Miss `mkdir` events after file watch | Watch missing path + `mkdir` + TOCTOU | T→E |
| AT-4 | Replace critical file via rename | Write grant on source + target + POSIX replace | S→T |
| AT-5 | Hardlink to sensitive file via link | Dual check bypass + dangling target | S→T |

---

## Mitigations & Convergence Path

| Decision | Current | Mitigation | Convergence Path | Owner Decision Needed |
|---|---|---|---|---|
| **2a: intercept ε=U** | Allow-all default | **Option A**: Change default to `ε=∅` (deny-all), require explicit `allow`<br>**Option B**: Keep `ε=U`, add `capabilities.intercept.default: 'allow'|'deny'` | Option A breaks existing callers; Option B adds explicit opt-in | **Owner: choose A or B** |
| **2d: mount `..` escape** | Handler must re-check | **Enforce**: `resolveURL` → `checkPermission(resolved)` in every handler | Add `checkPermission` call in `mount.ts` dispatch | **Code change required** |
| **7e: watch re-resolution** | Re-resolve by default | **Atomic**: `stat` + register in single syscall (inotify `IN_CREATE` on parent) | Use `fs.watch(parent, {recursive:false})` + filter | **Probe needed** |
| **2e: rename replace** | POSIX replace | **Option**: Add `{ replace: false }` option → `EEXIST` | Extend `rename` signature | **Owner: explicit option?** |
| **2c: link dangling target** | Undefined | **Define**: Dangling target → `ENOENT` (fail) or allow (dangling symlink semantics) | Document in contract | **Owner: choose** |

---

## Open Questions (for Owner)

| # | Question | Options | Recommendation | Silent Default |
|---|---|---|---|---|
| O1 | `intercept` default: allow-all (`U`) or deny-all (`∅`)? | A: `ε=∅` (secure default)<br>B: `ε=U` + explicit `capabilities.intercept.default` | **A** — aligns with least privilege | Current `U` (allow-all) |
| O2 | `mount` handler re-check: mandatory in contract? | A: Yes, `checkPermission(resolved)` required<br>B: Best effort, documented | **A** — prevents AT-2 | Not enforced |
| O3 | `watch` re-resolution atomicity: how to guarantee? | A: inotify parent watch<br>B: Polling fallback<br>C: Document race as [HYPOTHESIS] | **A** — native, low overhead | Re-resolve by default |
| O4 | `rename` replace option: add `{ replace: false }`? | A: Yes, explicit option<br>B: No, POSIX only | **A** — safer default | POSIX replace |
| O5 | `link` dangling target: allow or deny? | A: Deny (`ENOENT`)<br>B: Allow (dangling symlink) | **A** — predictable | Undefined |

---

## Evidence Mapping

| Threat | Probe Evidence | Run ID | Grade |
|---|---|---|---|
| AT-1 (intercept default) | `zz-verify-262-intercept.spec.ts` (planned) | — | **OPEN** |
| AT-2 (mount `..`) | `zz-verify-262-mount.spec.ts` (planned) | — | **OPEN** |
| AT-3 (watch TOCTOU) | `zz-probe-layer.spec.ts` L3 shows 30–31 callbacks | 41746559054 | **MEASURED** |
| AT-4 (rename replace) | `zz-verify-262-rename.spec.ts` (planned) | — | **OPEN** |
| AT-5 (link dangling) | `zz-verify-262-link.spec.ts` (planned) | — | **OPEN** |

---

## Self-Check 拦下账本

| 被拦下内容 | 卡点 | 处置 |
|---|---|---|
| "直接在 STRIDE 里顺便改 `mergeIntercept` 代码" | 卡点 2/4 | **拦下** — 搭车混修，仅产出威胁模型文档 |
| "把 STRIDE 表当结论写进评论" | 卡点 5 | **拦下** — 网格≠结论，仅作审计轨迹，结论进契约表 2a/2d/4b |
| "默认 `ε=U` 不算高危" | 卡点 3/4 | **拦下** — 硬约束直面：默认全许可违背最小权限，标记高危 |
| "攻击树只列互斥不给收敛路径" | 卡点 5 | **拦下** — 必须给四联单：现状/选项/推荐/沉默默认 |

---