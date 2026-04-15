/**
 * Tests for organize/carveouts.ts — isCarvedOut()
 *
 * Run with: pnpm test (tsx runner, node:test)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Frontmatter } from "../types.js";

// Lazy import so we can test without side effects.
async function getIsCarvedOut() {
  const { isCarvedOut } = await import("../organize/carveouts.js");
  return isCarvedOut;
}

const emptyFm: Frontmatter = {};

describe("isCarvedOut — dotfiles", () => {
  test("hidden file at root (.foo.md) is carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut(".foo.md", emptyFm, []), true);
  });

  test("file inside .kb-index/ is carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut(".kb-index/embeddings.jsonl", emptyFm, []), true);
  });

  test("file inside .trash/ is carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut(".trash/2026-04-14/note.md", emptyFm, []), true);
  });

  test("any dotfile segment anywhere in path is carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut("folder/.hidden/note.md", emptyFm, []), true);
  });
});

describe("isCarvedOut — baked-in folder carve-outs", () => {
  test("meta/anything is carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut("meta/session.md", emptyFm, []), true);
    assert.equal(isCarvedOut("meta/deep/note.md", emptyFm, []), true);
  });

  test("daily/anything is carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut("daily/2026-04-14.md", emptyFm, []), true);
  });
});

describe("isCarvedOut — frontmatter flags", () => {
  test("organize: false frontmatter → carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    const fm: Frontmatter = { organize: false };
    assert.equal(isCarvedOut("notes/anything.md", fm, []), true);
  });

  test("pinned: true frontmatter → carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    const fm: Frontmatter = { pinned: true };
    assert.equal(isCarvedOut("notes/anything.md", fm, []), true);
  });

  test("organize: true does NOT carve out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    const fm: Frontmatter = { organize: true };
    assert.equal(isCarvedOut("notes/anything.md", fm, []), false);
  });
});

describe("isCarvedOut — extraGlobs", () => {
  test("extraGlob matching path carves it out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(
      isCarvedOut("imports/archive/old-note.md", emptyFm, ["imports/archive/**"]),
      true
    );
  });

  test("extraGlob that does NOT match leaves note in scope", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(
      isCarvedOut("imports/current/note.md", emptyFm, ["imports/archive/**"]),
      false
    );
  });
});

describe("isCarvedOut — normal notes", () => {
  test("plain foo.md with empty frontmatter is NOT carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut("foo.md", emptyFm, []), false);
  });

  test("imports/workspace/note.md with empty frontmatter is NOT carved out", async () => {
    const isCarvedOut = await getIsCarvedOut();
    assert.equal(isCarvedOut("imports/workspace/note.md", emptyFm, []), false);
  });
});
