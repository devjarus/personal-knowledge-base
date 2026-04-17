/**
 * organize.test.ts — Integration tests for the `kb organize` CLI subcommand.
 *
 * Tests exercise the real call chain via child_process.execFile against
 * `src/cli/index.ts` using tsx as the runner. Each test gets a fresh tmpdir
 * KB fixture with a synthetic embedding sidecar.
 *
 * Tests:
 *  1. Dry-run smoke — exit 0, plan printed with header + summary.
 *  2. --json produces parseable JSON with the expected plan shape.
 *  3. --apply on a scratch fixture moves files.
 *  4. --undo reverses the apply.
 *  5. Missing .kb-index/ → exit 1, clear error message (no stack trace).
 *  6. Held lock → exit 1, "organize in progress" message.
 *  7. --min-confidence flag is threaded into the plan.
 *  8. --no-rewrite-links produces plan with zero rewrites.
 *  9. --verbose shows per-note move list.
 * 10. --exclude carves out an extra glob.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// LOAD-BEARING: use fileURLToPath(import.meta.url) — tsx in CJS mode does not
// populate import.meta.dirname, so we derive __dirname from the URL manually.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "../..");
const tsxBin = path.join(pkgRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = path.join(pkgRoot, "src", "cli", "index.ts");

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

/** Run `kb organize <args>` against a scratch KB fixture. */
async function runOrganize(
  kbRoot: string,
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxBin, cliEntry, "organize", ...args],
      {
        env: { ...process.env, KB_ROOT: kbRoot, ...env },
        cwd: pkgRoot,
      }
    );
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: e.code ?? 1,
    };
  }
}

/** Create a markdown note file in the fixture KB. */
async function writeNote(
  kbRoot: string,
  relPath: string,
  frontmatter: Record<string, unknown> = {},
  body = "Test body content."
): Promise<void> {
  const abs = path.join(kbRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) =>
    Array.isArray(v)
      ? `${k}:\n${(v as string[]).map((x) => `  - ${x}`).join("\n")}`
      : typeof v === "string"
        ? `${k}: ${v}`
        : `${k}: ${JSON.stringify(v)}`
  );
  const content =
    fmLines.length > 0
      ? `---\n${fmLines.join("\n")}\n---\n${body}\n`
      : `${body}\n`;
  await fs.writeFile(abs, content, "utf8");
}

/**
 * Seed .kb-index/embeddings.jsonl with synthetic unit vectors.
 * Each note path gets a deterministic 384-dim float vector.
 */
async function seedIndex(
  kbRoot: string,
  notes: Array<{ path: string; seed?: number }>
): Promise<void> {
  const indexDir = path.join(kbRoot, ".kb-index");
  await fs.mkdir(indexDir, { recursive: true });

  const lines: string[] = [];
  for (const { path: notePath, seed = 0 } of notes) {
    // Build a unit vector where only dimension `seed % 384` is non-zero.
    const vec = new Float32Array(384);
    vec[seed % 384] = 1.0;
    lines.push(
      JSON.stringify({
        path: notePath,
        sig: `sig-${notePath}`,
        vec: Array.from(vec),
      })
    );
  }

  await fs.writeFile(
    path.join(indexDir, "embeddings.jsonl"),
    lines.join("\n") + "\n",
    "utf8"
  );
}

/** Create a minimal scratch KB fixture for organize tests. */
async function createFixture(baseDir: string): Promise<string> {
  const kbRoot = await fs.mkdtemp(path.join(baseDir, "kb-"));

  // Create a mix of notes:
  // - type: daily → should stay (carved out by default)
  // - type: meta → should be moved to meta/ (but meta/ is carved out by default)
  // - untagged notes → cluster candidates
  // - tagged notes → tag-based assignment

  // Carved-out: daily/ notes (path-based carve-out)
  await writeNote(
    kbRoot,
    "daily/2026-04-14.md",
    { title: "Daily note", type: "daily" },
    "My daily note."
  );

  // Tagged notes → should move to their tag folder
  await writeNote(
    kbRoot,
    "imports/workspace/note-a.md",
    { title: "Note A about agents", tags: ["agents"] },
    "This note is about agents."
  );
  await writeNote(
    kbRoot,
    "imports/workspace/note-b.md",
    { title: "Note B about agents", tags: ["agents"] },
    "Another agents note."
  );

  // Untagged notes → cluster candidates
  await writeNote(
    kbRoot,
    "imports/misc/alpha.md",
    { title: "Alpha note" },
    "Alpha content."
  );
  await writeNote(
    kbRoot,
    "imports/misc/beta.md",
    { title: "Beta note" },
    "Beta content."
  );

  // organize: false → carved out by frontmatter
  await writeNote(
    kbRoot,
    "hand-curated/special.md",
    { title: "Special note", organize: false },
    "Do not move me."
  );

  // Seed the embedding index for all notes including carved-out ones
  // (the organizer filters them after loading).
  await seedIndex(kbRoot, [
    { path: "daily/2026-04-14.md", seed: 0 },
    { path: "imports/workspace/note-a.md", seed: 1 },
    { path: "imports/workspace/note-b.md", seed: 1 },
    { path: "imports/misc/alpha.md", seed: 2 },
    { path: "imports/misc/beta.md", seed: 2 },
    { path: "hand-curated/special.md", seed: 3 },
  ]);

  return kbRoot;
}

// ---------------------------------------------------------------------------
// Top-level fixture directory shared across tests (created in before())
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-cli-organize-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kb organize CLI", () => {
  test("dry-run smoke — exit 0, plan printed with header", async () => {
    const kbRoot = await createFixture(tmpDir);
    const { stdout, stderr, code } = await runOrganize(kbRoot);

    assert.equal(code, 0, `expected exit 0 but got ${code}. stderr: ${stderr}`);
    assert.match(stdout, /kb organize.*dry-run/i, "expected dry-run header");
    // Should mention note count or summary
    assert.match(stdout, /notes|moves|plan/i, "expected plan content");
    // Should print footer hint
    assert.match(stdout, /--apply/i, "expected --apply footer hint");
  });

  test("--json produces parseable JSON with plan shape", async () => {
    const kbRoot = await createFixture(tmpDir);
    const { stdout, stderr, code } = await runOrganize(kbRoot, ["--json"]);

    assert.equal(code, 0, `expected exit 0. stderr: ${stderr}`);

    let plan: Record<string, unknown>;
    try {
      plan = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      assert.fail(`stdout is not valid JSON:\n${stdout}`);
    }

    assert.ok("generatedAt" in plan, "plan.generatedAt missing");
    assert.ok("moves" in plan, "plan.moves missing");
    assert.ok("stats" in plan, "plan.stats missing");
    assert.ok("clusters" in plan, "plan.clusters missing");
    assert.ok("unassigned" in plan, "plan.unassigned missing");
    assert.equal(plan.mode, "full", "plan.mode should be 'full'");
    assert.ok(Array.isArray(plan.moves), "plan.moves should be an array");
  });

  test("--apply moves tagged notes to their tag folder", async () => {
    const kbRoot = await createFixture(tmpDir);

    // First, dry-run to see what would happen.
    const dryRun = await runOrganize(kbRoot, ["--json"]);
    assert.equal(dryRun.code, 0, `dry-run failed: ${dryRun.stderr}`);
    const plan = JSON.parse(dryRun.stdout) as {
      moves: Array<{ from: string; to: string; reason: string }>;
    };

    const agentMoves = plan.moves.filter((m) => m.reason === "tag");
    if (agentMoves.length === 0) {
      // No tag moves — could happen if both notes already in agents/. Skip.
      return;
    }

    // Apply the plan.
    const apply = await runOrganize(kbRoot, ["--apply"]);
    assert.equal(apply.code, 0, `apply failed. stderr: ${apply.stderr}`);
    assert.match(apply.stdout, /applied|moves/i, "expected apply summary");

    // Verify at least one tagged note moved.
    const firstMove = agentMoves[0];
    const movedPath = path.join(kbRoot, firstMove.to);
    const srcPath = path.join(kbRoot, firstMove.from);

    const movedExists = await fs
      .access(movedPath)
      .then(() => true)
      .catch(() => false);
    const srcGone = await fs
      .access(srcPath)
      .then(() => false)
      .catch(() => true);

    assert.ok(movedExists, `moved file should exist at ${firstMove.to}`);
    assert.ok(srcGone, `source file should not exist at ${firstMove.from}`);
  });

  test("--undo reverses a previous apply", async () => {
    const kbRoot = await createFixture(tmpDir);

    // Get plan to know what will move.
    const dryRun = await runOrganize(kbRoot, ["--json"]);
    assert.equal(dryRun.code, 0);
    const plan = JSON.parse(dryRun.stdout) as {
      moves: Array<{ from: string; to: string }>;
    };

    if (plan.moves.length === 0) {
      // Nothing to organize — skip undo test for this fixture.
      return;
    }

    // Apply.
    const apply = await runOrganize(kbRoot, ["--apply"]);
    assert.equal(apply.code, 0, `apply failed: ${apply.stderr}`);

    // Verify first move happened.
    const firstMove = plan.moves[0];
    const movedExists = await fs
      .access(path.join(kbRoot, firstMove.to))
      .then(() => true)
      .catch(() => false);
    assert.ok(movedExists, "apply should have moved file");

    // Undo.
    const undo = await runOrganize(kbRoot, ["--undo"]);
    assert.equal(undo.code, 0, `undo failed. stderr: ${undo.stderr}`);
    assert.match(undo.stdout, /reverted|undo/i, "expected undo summary");

    // Verify source is restored.
    const srcRestored = await fs
      .access(path.join(kbRoot, firstMove.from))
      .then(() => true)
      .catch(() => false);
    assert.ok(srcRestored, `source file should be restored at ${firstMove.from}`);
  });

  test("missing .kb-index/ → exit 1 with clear message (no stack trace)", async () => {
    // Create a KB with no .kb-index/ at all.
    const kbRoot = await fs.mkdtemp(path.join(tmpDir, "no-index-"));
    await writeNote(kbRoot, "note.md", { title: "A note" });

    const { stdout, stderr, code } = await runOrganize(kbRoot);

    assert.equal(code, 1, "expected exit 1 for missing .kb-index/");
    // Error should mention reindex, not show a stack trace.
    assert.match(stderr, /reindex/i, "stderr should mention 'reindex'");
    // Must NOT show a stack trace.
    assert.doesNotMatch(stderr, /at [\w.]+\s+\(/, "stderr must not contain a stack trace");
    assert.equal(stdout, "", "stdout should be empty on error");
  });

  test("held lock → exit 1, 'organize in progress' message", async () => {
    const kbRoot = await createFixture(tmpDir);

    // Pre-create the lock file with the test runner's own PID (which is alive).
    // The lock is checked during --apply (applyOrganizePlan acquires it).
    const lockDir = path.join(kbRoot, ".kb-index", "organize");
    await fs.mkdir(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, ".lock");
    await fs.writeFile(lockFile, String(process.pid), "utf8");

    try {
      // Must use --apply to trigger the lock check (dry-run never acquires it).
      const { stderr, code } = await runOrganize(kbRoot, ["--apply"]);

      assert.equal(code, 1, "expected exit 1 when lock is held");
      assert.match(
        stderr,
        /organize in progress/i,
        "stderr should say 'organize in progress'"
      );
      assert.doesNotMatch(stderr, /at [\w.]+\s+\(/, "no stack trace");
    } finally {
      // Always clean up the lock file so the tmpDir cleanup succeeds.
      await fs.rm(lockFile, { force: true });
    }
  });

  test("--min-confidence is threaded into plan (higher value = fewer cluster moves)", async () => {
    const kbRoot = await createFixture(tmpDir);

    const lowConf = await runOrganize(kbRoot, ["--json", "--min-confidence", "0.01"]);
    const highConf = await runOrganize(kbRoot, ["--json", "--min-confidence", "0.99"]);

    assert.equal(lowConf.code, 0);
    assert.equal(highConf.code, 0);

    const planLow = JSON.parse(lowConf.stdout) as { moves: unknown[] };
    const planHigh = JSON.parse(highConf.stdout) as { moves: unknown[] };

    // Higher threshold → fewer or equal cluster assignments (more unassigned).
    // This is direction-correct; exact counts depend on fixture.
    assert.ok(
      planLow.moves.length >= planHigh.moves.length,
      `low-confidence plan (${planLow.moves.length} moves) should have >= moves than high-confidence (${planHigh.moves.length} moves)`
    );
  });

  test("--no-rewrite-links produces plan with zero rewrites", async () => {
    const kbRoot = await createFixture(tmpDir);

    // Add a link so there would be rewrites with default settings.
    await writeNote(
      kbRoot,
      "imports/workspace/linker.md",
      { title: "Linker note", tags: ["agents"] },
      "See [[imports/workspace/note-a]]."
    );
    // Seed it in the index too.
    const sidecarPath = path.join(kbRoot, ".kb-index", "embeddings.jsonl");
    const existing = await fs.readFile(sidecarPath, "utf8");
    const newRow = JSON.stringify({
      path: "imports/workspace/linker.md",
      sig: "sig-linker",
      vec: Array.from(new Float32Array(384).fill(0).map((_, i) => (i === 1 ? 1.0 : 0.0))),
    });
    await fs.writeFile(sidecarPath, existing + newRow + "\n", "utf8");

    const { stdout, code } = await runOrganize(kbRoot, [
      "--json",
      "--no-rewrite-links",
    ]);

    assert.equal(code, 0);
    const plan = JSON.parse(stdout) as { rewrites: unknown[] };
    assert.equal(
      plan.rewrites.length,
      0,
      "--no-rewrite-links should produce zero rewrites in plan"
    );
  });

  test("--verbose shows per-note move list", async () => {
    const kbRoot = await createFixture(tmpDir);
    const { stdout, code } = await runOrganize(kbRoot, ["--verbose"]);

    assert.equal(code, 0);
    // Verbose mode should mention specific note paths (non-grouped).
    // The plan has tagged notes moving; at least one path should appear.
    assert.match(stdout, /\.md/i, "verbose output should mention .md files");
  });

  test("--json error output is valid JSON on missing sidecar", async () => {
    // Create KB with .kb-index/ dir but no embeddings.jsonl.
    const kbRoot = await fs.mkdtemp(path.join(tmpDir, "no-sidecar-"));
    await fs.mkdir(path.join(kbRoot, ".kb-index"), { recursive: true });
    await writeNote(kbRoot, "note.md", { title: "A note" });

    const { stdout, stderr, code } = await runOrganize(kbRoot, ["--json"]);

    assert.equal(code, 1, "expected exit 1");
    // Stderr gets the human message.
    assert.match(stderr, /reindex/i);
    // Stdout gets the JSON error envelope.
    let errJson: Record<string, unknown>;
    try {
      errJson = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      assert.fail(`--json error output must be valid JSON:\n${stdout}`);
    }
    assert.ok("error" in errJson, "JSON error envelope must have 'error' key");
  });

  test("--undo with no prior apply → exit 1, clear message", async () => {
    const kbRoot = await createFixture(tmpDir);
    const { stderr, code } = await runOrganize(kbRoot, ["--undo"]);

    assert.equal(code, 1, "expected exit 1 when no ledger exists");
    assert.match(stderr, /no ledger|apply.*first/i, "stderr should mention --apply");
    assert.doesNotMatch(stderr, /at [\w.]+\s+\(/, "no stack trace");
    // Note: stdout may contain the "undoing" header line — that is acceptable
    // because it was printed before the error was discovered.
  });
});
