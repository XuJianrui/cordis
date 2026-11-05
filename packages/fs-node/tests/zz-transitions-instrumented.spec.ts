import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { platform, release } from "node:os";
import { beforeAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { watch } from "chokidar";
import picomatch from "picomatch";
const testDir = dirname(fileURLToPath(import.meta.url));
const base = resolve(testDir, "__instr__");
const ROUNDS = Number(process.env.INSTR_ROUNDS || 6);
const TAG = `${platform()}-${release().split(".")[0]}-${process.version.slice(1)}`;
const match = picomatch("linked/**/*.ts", { posix: true });
function contains(a, b) {
  return !a || b === a || b.startsWith(a + "/");
}
function keepByFilter(rel, isDir) {
  for (let end = rel.length; end > 0; end = rel.lastIndexOf("/", end - 1)) {
    if (match(rel.slice(0, end))) return true;
  }
  return isDir && (contains("linked", rel) || contains(rel, "linked"));
}
function cordisPredicate(root, log) {
  const map = /* @__PURE__ */ new Map();
  return (input, stats) => {
    const p = resolve(input);
    const rel = relative(root, p).split(sep).join(posix.sep) || ".";
    if (p === root) {
      log.push(`${rel}[root]keep`);
      return false;
    }
    if (stats?.isSymbolicLink()) map.delete(p);
    else if (stats) map.set(p, stats.isDirectory());
    const isDirectory = map.get(p);
    const kind = stats ? stats.isDirectory() ? "dir" : stats.isSymbolicLink() ? "lnk" : "file" : "nostats";
    if (isDirectory === void 0) {
      log.push(`${rel}[${kind}]keep(unknown)`);
      return false;
    }
    const verdict = !keepByFilter(rel, isDirectory);
    log.push(`${rel}[${kind}]${verdict ? "IGNORE" : "keep"}`);
    return verdict;
  };
}
function snapshot(w, root) {
  try {
    const obj = w.getWatched();
    return Object.keys(obj).map((k) => `${relative(root, k) || "."}:[${(obj[k] || []).join("|")}]`).sort().join("  ");
  } catch {
    return "(threw)";
  }
}
async function round(arm, i) {
  const home = resolve(base, `${arm}/${i}`);
  const root = resolve(home, "root");
  const a = resolve(home, "a");
  const b = resolve(home, "b");
  mkdirSync(root, { recursive: true });
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(resolve(a, "file.ts"), "v0");
  writeFileSync(resolve(b, "file.ts"), "v0");
  const link = resolve(root, "linked");
  symlinkSync(a, link, "junction");
  const log = [];
  const events = [];
  const errors = [];
  const w = watch(root, { ignoreInitial: true, ignored: cordisPredicate(root, log) });
  w.on("all", (e, p) => events.push(`${e}:${relative(root, p) || "."}`));
  w.on("error", (e) => errors.push(e?.code || "err"));
  await new Promise((done) => w.once("ready", () => done()));
  const before = snapshot(w, root);
  const scanCalls = log.length;
  const markEvents = events.length;
  let writeTo = "";
  if (arm === "retarget") {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(b, link, "junction");
    writeTo = resolve(b, "file.ts");
  } else {
    rmSync(link, { recursive: true, force: true });
    mkdirSync(link, { recursive: true });
    writeTo = resolve(link, "file.ts");
  }
  for (let n = 0; n < 20; n++) {
    if (events.length > markEvents) break;
    writeFileSync(writeTo, `v${n + 1}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const after = snapshot(w, root);
  await w.close();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
  }
  const got = events.slice(markEvents);
  const verdict = got.some((e) => /linked[\\/].*file\.ts$/.test(e)) ? "file" : got.some((e) => /:linked$/.test(e)) ? "self" : got.length ? "other" : "none";
  const calls = log.slice(scanCalls);
  const ignored = calls.filter((c) => c.endsWith("IGNORE")).length;
  console.log(
    `@@IN ${TAG} ${arm} ${i} ${verdict} ev=${got.length ? got.slice(0, 3).join(",") : "-"} calls=${calls.length} ignored=${ignored} keysBefore=${before} keysAfter=${after} err=${errors[0] || "-"}@@`
  );
}
const ARMS = ["retarget", "link2dir"];
describe("what the watcher holds, and what it reports, per platform", () => {
  beforeAll(() => {
    rmSync(base, { recursive: true, force: true });
  });
  for (const arm of ARMS) {
    for (let i = 0; i < ROUNDS; i++) {
      it(`${arm} ${i}`, async () => {
        await round(arm, i);
      }, 4e4);
    }
  }
});
