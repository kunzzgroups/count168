#!/usr/bin/env node
/**
 * Mobile parity scan — what did the desktop change that the phone might be missing?
 *
 * The two frontends share no source, so every desktop change has to be mirrored by hand.
 * docs/mobile-desktop-parity.md records the verdict for each desktop commit that has been
 * judged, so this script simply subtracts the judged ones: whatever is left is the backlog
 * that still needs a look.
 *
 *   node scripts/parity-scan.mjs                       # since the date in --since (default 30d)
 *   node scripts/parity-scan.mjs --since=2026-08-19
 *   node scripts/parity-scan.mjs --since=2026-08-19 --all     # ignore the ledger
 *   node scripts/parity-scan.mjs --json                       # machine readable
 *
 * Read-only: it never writes anything, and it never judges a commit for you.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** Paths that only exist on the desktop: a change here can never reach the phone. */
const DESKTOP_ONLY_PATHS = [
  "pages/processlist",
  "pages/bankprocesslist",
  "pages/datacapture",
  "pages/capturemaintenance",
  "pages/transactionmaintenance",
  "pages/formulamaintenance",
  "pages/bankprocessmaintenance",
  "pages/maintenance",
  "pages/userlist",
  "pages/deletedlog",
  "components/AuthenticatedLayout",
  "components/sidebar",
  "shared/formula",
];

/**
 * Commits that cannot be judged one by one: whole-repo multi-line syncs (hundreds of files,
 * tens of thousands of lines). They are listed separately, never silently dropped. What
 * covers them instead: the phone's own sync commits, plus file-level diffs of the phone
 * against the desktop's *current* state (see docs/mobile-desktop-parity.md §3).
 */
const STRUCTURAL_SYNCS = new Set(["4b9f8fdbd9"]);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);
const since = flag("since", new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
const ledgerPath = "docs/mobile-desktop-parity.md";

const git = (argv) =>
  execFileSync("git", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const run = (argv) => {
  try {
    return git(argv);
  } catch (err) {
    console.error(`git ${argv.join(" ")} failed: ${err.message}`);
    process.exit(1);
  }
};

/** sha → {date, subject, files[]} for desktop frontend commits since `since`. */
function desktopCommits() {
  const out = run([
    "log",
    `--since=${since}`,
    "--no-merges",
    "--name-only",
    "--format=@@%h|%ad|%s",
    "--date=short",
    "--",
    "frontend/src",
  ]);
  const commits = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      const [sha, date, subject] = line.slice(2).split("|");
      cur = { sha, date, subject, files: [] };
      commits.push(cur);
    } else if (line.trim() && cur) {
      cur.files.push(line.trim());
    }
  }
  return commits;
}

/** phone source basenames, so a commit touching a file the phone has is worth reading. */
function phoneBasenames() {
  const names = new Set();
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else names.add(entry.name);
    }
  };
  walk("c168_mobile/frontend/src");
  return names;
}

/** shas the ledger already carries a verdict for. */
function judgedShas() {
  let text = "";
  try {
    text = readFileSync(ledgerPath, "utf8");
  } catch {
    return new Set();
  }
  const found = text.match(/\b[0-9a-f]{7,40}\b/g) || [];
  const set = new Set();
  for (const sha of found) {
    set.add(sha.slice(0, 10));
    for (let n = 7; n <= Math.min(10, sha.length); n += 1) set.add(sha.slice(0, n));
  }
  return set;
}

const all = desktopCommits();
const phone = phoneBasenames();
const judged = has("all") ? new Set() : judgedShas();

const phoneTouching = [];
const desktopOnly = [];
for (const commit of all) {
  const files = commit.files.filter((f) => f.startsWith("frontend/src"));
  if (!files.length) continue;
  const onlyDesktop = files.every((f) =>
    DESKTOP_ONLY_PATHS.some((p) => f.replace(/\\/g, "/").includes(p)),
  );
  const hits = [...new Set(files.map((f) => basename(f)).filter((b) => phone.has(b)))];
  const row = { ...commit, hits, files };
  if (onlyDesktop && !hits.length) desktopOnly.push(row);
  else phoneTouching.push(row);
}

/**
 * Cherry-picks: the com/org/site lines each carry a copy of the same change under the same
 * subject. Judge a family once — if any copy is in the ledger, the whole family is done.
 */
const familyKey = (c) => c.subject.trim().slice(0, 58).toLowerCase();
const bySubject = new Map();
for (const commit of phoneTouching) {
  const key = familyKey(commit);
  if (!bySubject.has(key)) bySubject.set(key, []);
  bySubject.get(key).push(commit);
}
const structural = phoneTouching.filter((c) => STRUCTURAL_SYNCS.has(c.sha));
const unjudged = [];
const families = [];
for (const group of bySubject.values()) {
  const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : 1));
  const anyJudged = group.some((c) => judged.has(c.sha) || STRUCTURAL_SYNCS.has(c.sha));
  families.push({ subject: sorted[0].subject, shas: group.map((c) => c.sha), judged: anyJudged });
  if (!anyJudged) unjudged.push(sorted[0]);
}
const summary = {
  since,
  ledger: ledgerPath,
  desktopCommits: all.length,
  desktopOnlyPages: desktopOnly.length,
  phoneTouching: phoneTouching.length,
  families: families.length,
  alreadyJudged: families.filter((f) => f.judged).length,
  unjudged: unjudged.length,
  structuralSyncs: structural.length,
};

if (has("json")) {
  console.log(JSON.stringify({ summary, candidates: unjudged }, null, 2));
} else {
  console.log(
    `桌面改动（frontend/src，since ${since}）：${summary.desktopCommits} 条\n` +
      `  只落在电话版没有的页面 → 不适用：${summary.desktopOnlyPages}\n` +
      `  可能相关：${summary.phoneTouching}（按主题归并成 ${summary.families} 组，其中已判定 ${summary.alreadyJudged} 组）\n` +
      `  待核：${summary.unjudged}\n`,
  );
  if (structural.length) {
    console.log(
      `结构性整仓同步（不逐条判，用「与桌面当前状态做文件级 diff」覆盖）：${structural
        .map((c) => c.sha)
        .join(", ")}\n`,
    );
  }
  if (!unjudged.length) {
    console.log("没有待核项。新增的桌面改动都已在台账里有结论。");
  } else {
    console.log("待核清单（每条都要 git show 读 diff + 到电话版找对应实现）：");
    for (const c of unjudged) {
      const family = families.find((f) => f.shas.includes(c.sha));
      const dupes = family && family.shas.length > 1 ? `  ← 同主题副本 ${family.shas.length - 1} 条一起判` : "";
      console.log(`- [ ] ${c.sha} ${c.date} ${c.subject}${dupes}`);
      console.log(`      电话版同名文件：${c.hits.length ? c.hits.slice(0, 6).join(", ") : "（无同名文件，先判断页面是否存在）"}`);
    }
    console.log(
      "\n判定口径见 docs/mobile-desktop-parity.md：已对齐 / 不适用（电话版无此页、纯视觉、纯性能、后端共用）/ 疑似缺口（附 file:line）。",
    );
    console.log("判定完把结论写回台账（含 sha），下次扫描就不会再列出来。");
  }
}
