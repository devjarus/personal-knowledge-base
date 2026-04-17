/**
 * linkArchive.test.ts — unit tests for block insertion/replacement idempotency.
 *
 * Scoped to the pure text-transform (applyRelatedBlock) because that's the
 * part most likely to break silently across re-runs. End-to-end plan/apply/
 * undo is covered by the manual smoke test + the organize/learn ledger
 * patterns this mirrors.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyRelatedBlock, type ArchiveLink } from "@/core/linkArchive";

const links: ArchiveLink[] = [
  { path: "imports/workspace/a.md", title: "Note A", cosine: 0.9 },
  { path: "imports/workspace/b/c.md", title: "Note C", cosine: 0.8 },
];

describe("linkArchive — applyRelatedBlock", () => {
  it("appends a block when none exists, preserves original body", () => {
    const before = "---\ntype: cluster-summary\n---\n\n# Summary\n\nBody.\n";
    const after = applyRelatedBlock(before, links);

    assert.ok(
      after.startsWith("---\ntype: cluster-summary\n---\n\n# Summary\n\nBody.\n"),
      "original content must be preserved",
    );
    assert.match(after, /<!-- related-archive:start -->/);
    assert.match(after, /<!-- related-archive:end -->/);
    assert.match(after, /\[\[imports\/workspace\/a\]\]/);
    assert.match(after, /\[\[imports\/workspace\/b\/c\]\]/);
  });

  it("is idempotent — applying twice produces the same output", () => {
    const before = "# Summary\n\nBody.\n";
    const once = applyRelatedBlock(before, links);
    const twice = applyRelatedBlock(once, links);
    assert.equal(twice, once, "second apply must be a no-op");
  });

  it("replaces the existing block cleanly when links change", () => {
    const before = "# Summary\n\nBody.\n";
    const firstPass = applyRelatedBlock(before, [
      { path: "imports/workspace/old.md", title: "Old", cosine: 0.5 },
    ]);

    // Sanity: first pass wrote the old link.
    assert.match(firstPass, /\[\[imports\/workspace\/old\]\]/);

    const secondPass = applyRelatedBlock(firstPass, links);

    // Old link is gone.
    assert.ok(
      !/imports\/workspace\/old/.test(secondPass),
      "stale link must be evicted, not duplicated",
    );
    // New links are present.
    assert.match(secondPass, /\[\[imports\/workspace\/a\]\]/);
    // Only ONE block remains — no accumulation.
    const startMatches = secondPass.match(/<!-- related-archive:start -->/g) ?? [];
    assert.equal(startMatches.length, 1, "exactly one block must exist");
  });

  it("strips the block when links is empty", () => {
    const before = "# Summary\n\nBody.\n";
    const withBlock = applyRelatedBlock(before, links);
    const withoutBlock = applyRelatedBlock(withBlock, []);
    assert.ok(
      !/related-archive/.test(withoutBlock),
      "empty links must strip the block entirely",
    );
    // Original body survives.
    assert.match(withoutBlock, /# Summary/);
    assert.match(withoutBlock, /Body\./);
  });

  it("preserves exactly one trailing newline", () => {
    const before = "# Summary\n\nBody.\n";
    const after = applyRelatedBlock(before, links);
    assert.ok(after.endsWith("\n"), "file must end with newline");
    assert.ok(!after.endsWith("\n\n\n"), "no runaway trailing newlines");
  });
});
