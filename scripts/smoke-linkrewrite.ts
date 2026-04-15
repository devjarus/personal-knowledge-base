/**
 * smoke-linkrewrite.ts — Live smoke test for Phase 3 link rewriting.
 *
 * Creates a scratch KB in os.tmpdir(), seeds 5 notes with cross-references,
 * runs apply (with link rewrites), verifies zero new broken links,
 * then runs undo and verifies byte-identical restoration.
 *
 * Run: pnpm tsx scripts/smoke-linkrewrite.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

async function main(): Promise<void> {
// Create scratch KB
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "kb-smoke-"));
process.env.KB_ROOT = tmpDir;

console.log("Scratch KB:", tmpDir);

// Helper: write a raw file
async function writeRaw(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmpDir, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

// Seed embedding index
async function seedIndex(notePaths: string[]): Promise<void> {
  const indexDir = path.join(tmpDir, ".kb-index");
  await mkdir(indexDir, { recursive: true });
  const DIM = 8;
  const lines = notePaths.map((notePath, i) => {
    const seed = i + 1;
    const vec: number[] = [];
    let acc = 0;
    for (let j = 0; j < DIM; j++) {
      const v = Math.sin(seed * (j + 1) * 0.37 + seed);
      vec.push(v);
      acc += v * v;
    }
    const norm = Math.sqrt(acc);
    return JSON.stringify({
      path: notePath,
      sig: "test:100",
      model: "test-model",
      dim: DIM,
      vec: vec.map((v) => v / norm),
    });
  });
  await writeFile(path.join(indexDir, "embeddings.jsonl"), lines.join("\n") + "\n", "utf8");
}

// Snapshot all .md files
async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith(".md")) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        snap.set(rel, await readFile(abs, "utf8"));
      }
    }
  }
  await walk(root);
  return snap;
}

// 5 notes with cross-references:
// a.md: tagged "agents" → will move to agents/
// b.md: references a.md with wiki-path [[imports/workspace/a]]
// c.md: tagged "rag" → will move to rag/
// d.md: references c.md with md-path ../research/c.md
// e.md: references a.md with wiki-slug [[a]] (should NOT be rewritten)

await writeRaw(
  "imports/workspace/a.md",
  "---\ntags: [agents]\n---\n# Agent Note A\n\nContent about agents.\n"
);
await writeRaw(
  "imports/workspace/b.md",
  "# Note B\n\nSee [[imports/workspace/a]] for agent info.\nAlso check [Agent](../workspace/a.md).\n"
);
await writeRaw(
  "imports/research/c.md",
  "---\ntags: [rag]\n---\n# RAG Note C\n\nContent about RAG.\n"
);
await writeRaw(
  "imports/research/d.md",
  "# Note D\n\nRefer to [RAG doc](../research/c.md) for details.\n"
);
await writeRaw(
  "top-level-e.md",
  "# Top E\n\nAlso [[a]] is relevant (slug-only link — should stay unchanged).\n"
);

const allPaths = [
  "imports/workspace/a.md",
  "imports/workspace/b.md",
  "imports/research/c.md",
  "imports/research/d.md",
  "top-level-e.md",
];

await seedIndex(allPaths);

// Snapshot pre-apply
const preSnap = await snapshotTree(tmpDir);
console.log("\n=== Pre-apply files ===");
for (const [k, v] of [...preSnap.entries()].sort()) {
  console.log(`  ${k}:`, v.split("\n")[0]);
}

// Import modules — paths are relative to scripts/, so src/core/* is at ../src/core/*
const { buildOrganizePlan, applyOrganizePlan, undoLastOrganize } = await import(
  "../src/core/organize.js"
);
const { _invalidateNotesCache } = await import("../src/core/fs.js");
const { _invalidateSemanticCache } = await import("../src/core/semanticIndex.js");
const { _invalidateLinkIndexCache, buildLinkIndex } = await import("../src/core/links.js");

_invalidateNotesCache();
_invalidateSemanticCache();

// Build plan
const plan = await buildOrganizePlan({ mode: "full", kbRoot: tmpDir });
console.log("\n=== Plan ===");
console.log("Moves:");
for (const m of plan.moves) console.log(`  ${m.from} → ${m.to} (${m.reason})`);
console.log("Rewrites:");
for (const r of plan.rewrites) console.log(`  ${r.file}: ${r.before} → ${r.after}`);
console.log("Unassigned:", plan.unassigned.map((u: { path: string; reason: string }) => `${u.path}: ${u.reason}`).join(", ") || "(none)");

// Baseline broken links
_invalidateLinkIndexCache();
const preIndex = await buildLinkIndex();
console.log("\nPre-apply broken links:", preIndex.broken.length);
if (preIndex.broken.length > 0) {
  for (const b of preIndex.broken) console.log(`  ${b.from}: ${b.raw}`);
}

// Apply
_invalidateNotesCache();
_invalidateSemanticCache();

const applyResult = await applyOrganizePlan(plan, {});
console.log("\n=== Apply result ===");
console.log("Applied:", applyResult.applied, "Skipped:", applyResult.skipped.length);
console.log("Ledger:", applyResult.ledgerPath);

// Post-apply state
const postSnap = await snapshotTree(tmpDir);
console.log("\n=== Post-apply files ===");
for (const [k, v] of [...postSnap.entries()].sort()) {
  console.log(`  ${k}:\n   ${v.trim().split("\n").join("\n   ")}`);
}

// Check links were rewritten
console.log("\n=== Link rewrite verification ===");
for (const [k, v] of [...postSnap.entries()].sort()) {
  const hasOldLink = v.includes("imports/workspace/a") || v.includes("imports/research/c");
  const hasNewLink = v.includes("agents/") || v.includes("rag/");
  console.log(`  ${k}: old links=${hasOldLink ? "YES (BAD)" : "no"} new links=${hasNewLink ? "YES" : "no"}`);
}

// Check top-level-e.md has unchanged slug link
const eContent = postSnap.get("top-level-e.md");
if (eContent?.includes("[[a]]")) {
  console.log("\n  top-level-e.md: slug link [[a]] preserved (CORRECT)");
} else {
  console.log("\n  top-level-e.md: WARNING - slug link may have been rewritten");
  console.log("  Content:", eContent);
}

// Post-apply broken links
_invalidateNotesCache();
_invalidateSemanticCache();
_invalidateLinkIndexCache();

const postIndex = await buildLinkIndex();
console.log("\nPost-apply broken links:", postIndex.broken.length);
if (postIndex.broken.length > 0) {
  for (const b of postIndex.broken) console.log(`  ${b.from}: ${b.raw}`);
}

const newBroken = Math.max(0, postIndex.broken.length - preIndex.broken.length);
console.log("New broken links introduced:", newBroken, newBroken === 0 ? "(PASS)" : "(FAIL)");

// Undo
_invalidateNotesCache();
_invalidateSemanticCache();

const undoResult = await undoLastOrganize();
console.log("\n=== Undo result ===");
console.log("Reverted:", undoResult.reverted, "Conflicts:", undoResult.conflicts.length);

// Post-undo state
const postUndoSnap = await snapshotTree(tmpDir);
console.log("\n=== Post-undo files ===");
for (const [k] of [...postUndoSnap.entries()].sort()) {
  console.log(`  ${k}`);
}

// Verify byte-identical restoration
let allMatch = true;
for (const [relPath, content] of preSnap) {
  const restored = postUndoSnap.get(relPath);
  if (restored === content) {
    console.log(`  ${relPath}: MATCH`);
  } else {
    console.log(`  ${relPath}: MISMATCH`);
    console.log(`    Expected: ${JSON.stringify(content.slice(0, 100))}`);
    console.log(`    Got:      ${JSON.stringify((restored ?? "").slice(0, 100))}`);
    allMatch = false;
  }
}
console.log("\nByte-identical restoration:", allMatch ? "YES (PASS)" : "NO (FAIL)");

// Cleanup
await rm(tmpDir, { recursive: true, force: true });
console.log("\nScratch KB cleaned up.");
console.log("\n=== SMOKE TEST COMPLETE ===");
} // end main

main().catch((err) => { console.error(err); process.exit(1); });
