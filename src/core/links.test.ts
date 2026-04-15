/**
 * Integration + unit tests for src/core/links.ts.
 *
 * Run with:  npx tsx src/core/links.test.ts
 *
 * Uses a temporary on-disk KB (real file I/O) so it exercises the actual
 * readNote / listNotes / buildLinkIndex call chain end-to-end.
 *
 * Exit code: 0 = all pass, 1 = at least one failure.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---- tiny test harness ----
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ---- helpers ----

async function writeFile(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

// ---- setup ----

async function runTests(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-links-test-"));

  try {
    // Point KB_ROOT at our temp dir for all subsequent calls.
    process.env.KB_ROOT = tmpDir;

    // Lazy-load links after env is set so kbRoot() picks up the new value.
    const { buildLinkIndex, _invalidateLinkIndexCache } = await import("./links.js");
    const { _invalidateNotesCache } = await import("./fs.js");

    // Helper to reset caches between sub-tests.
    function resetCaches(): void {
      _invalidateNotesCache();
      _invalidateLinkIndexCache();
    }

    // -----------------------------------------------------------------------
    // T1-A: basic wiki link resolves to correct target
    // -----------------------------------------------------------------------
    console.log("\n-- T1-A: wiki link resolution --");
    await writeFile(tmpDir, "welcome.md", "# Welcome\nSee also [[target-note]]\n");
    await writeFile(tmpDir, "target-note.md", "# Target\nContent here.\n");
    resetCaches();

    let idx = await buildLinkIndex();
    const inboundTarget = idx.inbound.get("target-note.md") ?? [];
    assertEqual(inboundTarget.length, 1, "target-note.md has exactly 1 inbound link");
    assertEqual(inboundTarget[0].from, "welcome.md", "inbound link is from welcome.md");
    assertEqual(inboundTarget[0].kind, "wiki", "link kind is wiki");
    assertEqual(inboundTarget[0].target, "target-note.md", "target resolved correctly");

    // -----------------------------------------------------------------------
    // T1-B: broken wiki link produces null target and appears in broken[]
    // -----------------------------------------------------------------------
    console.log("\n-- T1-B: broken wiki link --");
    await writeFile(tmpDir, "linker.md", "# Linker\n[[does-not-exist]]\n");
    resetCaches();

    idx = await buildLinkIndex();
    const brokenRefs = idx.broken.filter((r) => r.from === "linker.md");
    assertEqual(brokenRefs.length, 1, "linker.md has 1 broken link");
    assertEqual(brokenRefs[0].target, null, "broken link target is null");

    // -----------------------------------------------------------------------
    // T1-C: markdown link (relative path) resolves
    // -----------------------------------------------------------------------
    console.log("\n-- T1-C: md link resolution --");
    await writeFile(tmpDir, "notes/a.md", "# A\nSee [B](b.md)\n");
    await writeFile(tmpDir, "notes/b.md", "# B\nContent.\n");
    resetCaches();

    idx = await buildLinkIndex();
    const inboundB = idx.inbound.get("notes/b.md") ?? [];
    assertEqual(inboundB.length, 1, "notes/b.md has 1 inbound md link");
    assertEqual(inboundB[0].kind, "md", "link kind is md");

    // -----------------------------------------------------------------------
    // T1-D: external URLs are skipped (not added to broken)
    // -----------------------------------------------------------------------
    console.log("\n-- T1-D: external URL skipped --");
    await writeFile(tmpDir, "external.md", "# External\n[Google](https://google.com)\n[email](mailto:x@y.com)\n");
    resetCaches();

    idx = await buildLinkIndex();
    const outboundExternal = idx.outbound.get("external.md") ?? [];
    assertEqual(outboundExternal.length, 0, "external URLs produce no outbound refs");

    // -----------------------------------------------------------------------
    // T1-E: links inside fenced code blocks are ignored
    // -----------------------------------------------------------------------
    console.log("\n-- T1-E: code-fence suppresses link parsing --");
    await writeFile(tmpDir, "codeblock.md", [
      "# Code",
      "```",
      "[[target-note]]",
      "[link](notes/b.md)",
      "```",
      "Real link [[target-note]]",
    ].join("\n") + "\n");
    resetCaches();

    idx = await buildLinkIndex();
    const outboundCode = idx.outbound.get("codeblock.md") ?? [];
    // Should only have 1 link (the real one after the closing fence), not 3.
    assertEqual(outboundCode.length, 1, "code-fence suppresses 2 links; 1 real link remains");

    // -----------------------------------------------------------------------
    // T1-F: wiki pipe-alias and fragment stripping
    // -----------------------------------------------------------------------
    console.log("\n-- T1-F: wiki pipe-alias and fragment stripped --");
    await writeFile(tmpDir, "aliases.md", "# Aliases\n[[target-note|Display Text]] and [[target-note#heading]]\n");
    resetCaches();

    idx = await buildLinkIndex();
    const inboundTargetAlias = idx.inbound.get("target-note.md") ?? [];
    // welcome.md, linker.md(no), aliases.md, codeblock.md → welcome.md + aliases.md + codeblock.md
    assert(inboundTargetAlias.some((r) => r.from === "aliases.md"), "aliases.md links resolve to target-note.md");

    // -----------------------------------------------------------------------
    // T1-G: ambiguous basename → unresolved (two notes share same base name)
    // -----------------------------------------------------------------------
    console.log("\n-- T1-G: ambiguous basename → unresolved --");
    await writeFile(tmpDir, "folder1/shared.md", "# Shared 1\n");
    await writeFile(tmpDir, "folder2/shared.md", "# Shared 2\n");
    await writeFile(tmpDir, "ambiguous-linker.md", "# Ambig\n[[shared]]\n");
    resetCaches();

    idx = await buildLinkIndex();
    const ambigBroken = idx.broken.filter((r) => r.from === "ambiguous-linker.md");
    assertEqual(ambigBroken.length, 1, "ambiguous wiki link is broken (unresolved)");

    // -----------------------------------------------------------------------
    // T1-H: cache is returned on second call (signature unchanged)
    // -----------------------------------------------------------------------
    console.log("\n-- T1-H: cache hit on second buildLinkIndex() call --");
    const idx2 = await buildLinkIndex();
    // Same object identity — cache was returned.
    assert(idx2 === idx, "second buildLinkIndex() returns cached index (same object)");

    // -----------------------------------------------------------------------
    // T1-I: md link that escapes KB root is skipped
    // -----------------------------------------------------------------------
    console.log("\n-- T1-I: md link escaping KB root is skipped --");
    await writeFile(tmpDir, "escape.md", "# Escape\n[Outside](../../../etc/passwd)\n");
    resetCaches();

    idx = await buildLinkIndex();
    const outboundEscape = idx.outbound.get("escape.md") ?? [];
    assertEqual(outboundEscape.length, 0, "path-traversal md link is silently skipped");

    // -----------------------------------------------------------------------
    // T1-J: _invalidateLinkIndexCache forces rebuild
    // -----------------------------------------------------------------------
    console.log("\n-- T1-J: invalidate causes rebuild --");
    const idxBefore = await buildLinkIndex();
    _invalidateLinkIndexCache();
    const idxAfter = await buildLinkIndex();
    assert(idxBefore !== idxAfter, "after invalidation, buildLinkIndex() returns a new object");

    // -----------------------------------------------------------------------
    // T5-A: maskInlineCode — single backtick suppresses link
    // -----------------------------------------------------------------------
    console.log("\n-- T5-A: maskInlineCode — single backtick --");
    const { maskInlineCode } = await import("./links.js");
    const singleTick = "Look at `[[fake-link]]` here.";
    const maskedSingle = maskInlineCode(singleTick);
    assert(!maskedSingle.includes("[["), "single-tick backtick span masks [[");
    assert(maskedSingle.length === singleTick.length, "single-tick: line length preserved");

    // -----------------------------------------------------------------------
    // T5-B: maskInlineCode — double backtick suppresses link
    // -----------------------------------------------------------------------
    console.log("\n-- T5-B: maskInlineCode — double backtick --");
    const doubleTick = "See ``[[also-fake]]`` for details.";
    const maskedDouble = maskInlineCode(doubleTick);
    assert(!maskedDouble.includes("[["), "double-tick backtick span masks [[");
    assert(maskedDouble.length === doubleTick.length, "double-tick: line length preserved");

    // -----------------------------------------------------------------------
    // T5-C: maskInlineCode — real link outside backtick is preserved
    // -----------------------------------------------------------------------
    console.log("\n-- T5-C: maskInlineCode — real link outside backtick preserved --");
    const mixedLine = "Look at `code` then [[target-note]].";
    const maskedMixed = maskInlineCode(mixedLine);
    assert(maskedMixed.includes("[[target-note]]"), "link outside inline code is preserved after masking");
    assert(maskedMixed.length === mixedLine.length, "mixed: line length preserved");

    // -----------------------------------------------------------------------
    // T5-D: parseLinks — inline backtick link does not appear in broken list
    // -----------------------------------------------------------------------
    console.log("\n-- T5-D: inline backtick link excluded from broken links --");
    await writeFile(tmpDir, "backtick-test.md", [
      "# Backtick Test",
      "This has `[[not-a-real-link]]` inside code.",
      "This has a real link [[target-note]].",
    ].join("\n") + "\n");
    resetCaches();

    idx = await buildLinkIndex();
    const backtickBroken = idx.broken.filter((r) => r.from === "backtick-test.md");
    assertEqual(backtickBroken.length, 0, "inline-backtick fake link does not appear in broken[]");
    const backtickOutbound = idx.outbound.get("backtick-test.md") ?? [];
    assertEqual(backtickOutbound.length, 1, "only the real [[target-note]] link is counted");

    // -----------------------------------------------------------------------
    // Integration: end-to-end inbound + outbound + broken counts
    // -----------------------------------------------------------------------
    console.log("\n-- Integration: inbound/outbound/broken summary --");
    resetCaches();
    idx = await buildLinkIndex();
    // Just assert the maps are non-empty
    assert(idx.inbound.size > 0, "inbound map is non-empty");
    assert(idx.outbound.size > 0, "outbound map is non-empty");
    assert(idx.broken.length > 0, "broken list is non-empty");

  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
