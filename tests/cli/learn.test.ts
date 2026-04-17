/**
 * learn.test.ts — Integration tests for the `kb learn` CLI subcommand.
 *
 * Tests exercise the real call chain via child_process.execFile against
 * `src/cli/index.ts` using tsx as the runner. Each test gets a fresh tmpdir
 * KB fixture with synthetic notes seeded into a cluster folder.
 *
 * Tests:
 *  1. Dry-run smoke — exit 0, plan printed with header.
 *  2. --json produces parseable JSON matching the LearnPlan shape.
 *  3. --apply --no-llm writes _summary.md files; subsequent dry-run reports "fresh".
 *  4. --undo reverses a previous apply (moves summaries to trash).
 *  5. --undo with no prior apply → exit 1, clear "no learn ledger" message.
 *  6. Held lock → exit 1, "another learn is in progress" message.
 *  7. --no-llm short-circuits to extractive (assert via ledger model=null).
 *  8. --json on apply returns valid JSON matching ApplyLearnResult shape.
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

/** Run `kb learn <args>` against a scratch KB fixture. */
async function runLearn(
  kbRoot: string,
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsxBin, cliEntry, "learn", ...args],
      {
        env: { ...process.env, KB_ROOT: kbRoot, ...env },
        cwd: pkgRoot,
        timeout: 30_000,
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

/**
 * Create a minimal scratch KB with a cluster of 3 notes in `ideas/` folder.
 * Seeded with an embeddings sidecar so the extractive tier can rank centroid.
 */
async function createFixture(baseDir: string): Promise<string> {
  const kbRoot = await fs.mkdtemp(path.join(baseDir, "kb-learn-"));

  // Three notes in ideas/ — enough to meet the minNotes=3 threshold.
  await writeNote(
    kbRoot,
    "ideas/note-a.md",
    { title: "Note A about ML", tags: ["ml", "ai"] },
    "Neural networks learn hierarchical representations from data. Deep learning is effective."
  );
  await writeNote(
    kbRoot,
    "ideas/note-b.md",
    { title: "Note B about Optimization", tags: ["ml", "optimization"] },
    "Gradient descent minimizes the loss function. Learning rate matters a lot."
  );
  await writeNote(
    kbRoot,
    "ideas/note-c.md",
    { title: "Note C about Data", tags: ["data", "ml"] },
    "Feature engineering transforms raw inputs. Data quality determines model quality."
  );

  // Also add a note with organize:false to test carve-outs are skipped.
  await writeNote(
    kbRoot,
    "ideas/carved-out.md",
    { title: "Carved out note", organize: false },
    "This note should be excluded from summaries."
  );

  // Seed embeddings sidecar.
  await seedIndex(kbRoot, [
    { path: "ideas/note-a.md", seed: 1 },
    { path: "ideas/note-b.md", seed: 2 },
    { path: "ideas/note-c.md", seed: 3 },
    { path: "ideas/carved-out.md", seed: 4 },
  ]);

  return kbRoot;
}

// ---------------------------------------------------------------------------
// Top-level fixture directory shared across tests (created in before())
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-cli-learn-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kb learn CLI", () => {
  test("dry-run smoke — exit 0, plan printed with header", async () => {
    const kbRoot = await createFixture(tmpDir);
    // --no-ollama ensures we never attempt a real Ollama connection.
    const { stdout, stderr, code } = await runLearn(kbRoot, ["--no-ollama"]);

    assert.equal(code, 0, `expected exit 0 but got ${code}. stderr: ${stderr}`);
    assert.match(stdout, /kb learn.*dry-run/i, "expected dry-run header");
    // Should mention cluster stats.
    assert.match(stdout, /clusters/i, "expected 'clusters' in output");
    // Should print footer hint.
    assert.match(stdout, /--apply/i, "expected --apply footer hint");
    // Must NOT have modified any files.
    const summaryExists = await fs
      .access(path.join(kbRoot, "ideas/_summary.md"))
      .then(() => true)
      .catch(() => false);
    assert.equal(summaryExists, false, "dry-run must not write _summary.md");
  });

  test("--json produces parseable JSON with LearnPlan shape", async () => {
    const kbRoot = await createFixture(tmpDir);
    const { stdout, stderr, code } = await runLearn(kbRoot, ["--json", "--no-ollama"]);

    assert.equal(code, 0, `expected exit 0. stderr: ${stderr}`);

    let plan: Record<string, unknown>;
    try {
      plan = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      assert.fail(`stdout is not valid JSON:\n${stdout}`);
    }

    assert.ok("generatedAt" in plan, "plan.generatedAt missing");
    assert.ok("mode" in plan, "plan.mode missing");
    assert.ok("generator" in plan, "plan.generator missing");
    assert.ok("clusters" in plan, "plan.clusters missing");
    assert.ok("stats" in plan, "plan.stats missing");
    assert.ok(Array.isArray(plan.clusters), "plan.clusters should be an array");
    // The ideas/ folder has 3 non-carved-out notes, so it should appear.
    const clusters = plan.clusters as Array<Record<string, unknown>>;
    const ideasCluster = clusters.find(
      (c) => typeof c.cluster === "string" && c.cluster.includes("ideas")
    );
    assert.ok(ideasCluster, "ideas/ cluster should appear in plan");
    assert.equal(ideasCluster.status, "new", "first run should have status=new");
  });

  test("--apply --no-llm writes _summary.md; subsequent dry-run reports 'fresh'", async () => {
    const kbRoot = await createFixture(tmpDir);

    // Apply with extractive tier.
    const apply = await runLearn(kbRoot, ["--apply", "--no-llm"]);
    assert.equal(apply.code, 0, `apply failed. stderr: ${apply.stderr}`);
    assert.match(apply.stdout, /wrote/i, "expected 'Wrote' in apply output");

    // _summary.md must exist.
    const summaryPath = path.join(kbRoot, "ideas/_summary.md");
    const summaryExists = await fs
      .access(summaryPath)
      .then(() => true)
      .catch(() => false);
    assert.ok(summaryExists, "_summary.md should exist after --apply");

    // Subsequent dry-run should report the cluster as "fresh".
    const dryRun2 = await runLearn(kbRoot, ["--json", "--no-ollama"]);
    assert.equal(dryRun2.code, 0);
    const plan2 = JSON.parse(dryRun2.stdout) as {
      clusters: Array<{ cluster: string; status: string }>;
      stats: { fresh: number };
    };
    const ideasCluster2 = plan2.clusters.find((c) => c.cluster.includes("ideas"));
    assert.ok(ideasCluster2, "ideas/ cluster should appear in second plan");
    assert.equal(ideasCluster2.status, "fresh", "cluster should be fresh after apply");
    assert.ok(plan2.stats.fresh >= 1, "stats.fresh should be >= 1");
  });

  test("--undo reverses a previous apply (summary moved to trash)", async () => {
    const kbRoot = await createFixture(tmpDir);

    // Apply first.
    const apply = await runLearn(kbRoot, ["--apply", "--no-llm"]);
    assert.equal(apply.code, 0, `apply failed: ${apply.stderr}`);

    const summaryPath = path.join(kbRoot, "ideas/_summary.md");
    const existsBefore = await fs
      .access(summaryPath)
      .then(() => true)
      .catch(() => false);
    assert.ok(existsBefore, "_summary.md should exist before undo");

    // Undo.
    const undo = await runLearn(kbRoot, ["--undo"]);
    assert.equal(undo.code, 0, `undo failed. stderr: ${undo.stderr}`);
    assert.match(undo.stdout, /reverted/i, "expected 'Reverted' in undo output");

    // _summary.md should be gone.
    const existsAfter = await fs
      .access(summaryPath)
      .then(() => true)
      .catch(() => false);
    assert.equal(existsAfter, false, "_summary.md should not exist after undo");

    // The .trash/ folder should contain the trashed summary.
    const trashDir = path.join(kbRoot, ".trash");
    const trashExists = await fs
      .access(trashDir)
      .then(() => true)
      .catch(() => false);
    assert.ok(trashExists, ".trash/ should exist after undo");
  });

  test("--undo with no prior apply → exit 1 with 'no learn ledger' message", async () => {
    const kbRoot = await createFixture(tmpDir);
    // No apply run — no ledger.
    const { stdout, stderr, code } = await runLearn(kbRoot, ["--undo"]);

    assert.equal(code, 1, "expected exit 1 when no ledger exists");
    assert.match(
      stderr,
      /no learn ledger|apply.*first/i,
      "stderr should mention no ledger or apply first"
    );
    // Must NOT show a stack trace.
    assert.doesNotMatch(stderr, /at [\w.]+\s+\(/, "stderr must not contain a stack trace");
    // stdout should be empty (error before any output was produced).
    // Note: may contain the "undoing" header line — that is acceptable.
  });

  test("held lock → exit 1, 'another learn is in progress' message", async () => {
    const kbRoot = await createFixture(tmpDir);

    // Pre-create the lock file with the test runner's own PID (which is alive).
    const lockDir = path.join(kbRoot, ".kb-index", "learn");
    await fs.mkdir(lockDir, { recursive: true });
    const lockFile = path.join(lockDir, ".lock");
    await fs.writeFile(lockFile, String(process.pid), "utf8");

    try {
      // Must use --apply to trigger the lock check.
      const { stderr, code } = await runLearn(kbRoot, ["--apply", "--no-llm"]);

      assert.equal(code, 1, "expected exit 1 when lock is held");
      assert.match(
        stderr,
        /another learn is in progress|learn in progress/i,
        "stderr should say lock is held"
      );
      assert.doesNotMatch(stderr, /at [\w.]+\s+\(/, "no stack trace");
    } finally {
      // Always clean up the lock file so the tmpDir cleanup succeeds.
      await fs.rm(lockFile, { force: true });
    }
  });

  test("--no-llm short-circuits to extractive (ledger model=null, generator=extractive)", async () => {
    const kbRoot = await createFixture(tmpDir);

    const apply = await runLearn(kbRoot, ["--apply", "--no-llm", "--json"]);
    assert.equal(apply.code, 0, `apply failed. stderr: ${apply.stderr}`);

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(apply.stdout) as Record<string, unknown>;
    } catch {
      assert.fail(`--json output is not valid JSON:\n${apply.stdout}`);
    }

    assert.ok(Array.isArray(result.applied), "result.applied should be array");
    const applied = result.applied as Array<Record<string, unknown>>;
    assert.ok(applied.length >= 1, "should have applied at least 1 summary");
    for (const entry of applied) {
      assert.equal(
        entry.generator,
        "extractive",
        `expected generator=extractive for --no-llm, got ${entry.generator}`
      );
    }

    // Also verify via the ledger on disk.
    const learnDir = path.join(kbRoot, ".kb-index", "learn");
    const entries = await fs.readdir(learnDir);
    const ledgers = entries.filter((e) => e.endsWith(".jsonl") && !e.endsWith(".undone.jsonl"));
    assert.ok(ledgers.length >= 1, "a ledger file should exist");

    const ledgerContent = await fs.readFile(
      path.join(learnDir, ledgers[ledgers.length - 1]),
      "utf8"
    );
    const writeRecord = ledgerContent
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((r) => r?.kind === "learning-write")[0];

    assert.ok(writeRecord, "learning-write record should exist in ledger");
    assert.equal(writeRecord.generator, "extractive", "ledger generator should be extractive");
    assert.equal(writeRecord.model, null, "ledger model should be null for extractive");
  });

  test("--json apply output is valid JSON matching ApplyLearnResult shape", async () => {
    const kbRoot = await createFixture(tmpDir);

    const { stdout, stderr, code } = await runLearn(kbRoot, ["--apply", "--no-llm", "--json"]);
    assert.equal(code, 0, `apply --json failed. stderr: ${stderr}`);

    let result: Record<string, unknown>;
    try {
      result = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      assert.fail(`--json output is not valid JSON:\n${stdout}`);
    }

    // Check required ApplyLearnResult fields.
    assert.ok("applied" in result, "result.applied missing");
    assert.ok("skipped" in result, "result.skipped missing");
    assert.ok("ledgerPath" in result, "result.ledgerPath missing");
    assert.ok(Array.isArray(result.applied), "result.applied should be array");
    assert.ok(Array.isArray(result.skipped), "result.skipped should be array");
    assert.equal(typeof result.ledgerPath, "string", "result.ledgerPath should be string");

    // Verify each applied entry has expected fields.
    const applied = result.applied as Array<Record<string, unknown>>;
    for (const entry of applied) {
      assert.ok("cluster" in entry, "applied entry should have cluster");
      assert.ok("summaryPath" in entry, "applied entry should have summaryPath");
      assert.ok("generator" in entry, "applied entry should have generator");
      assert.ok("bytesWritten" in entry, "applied entry should have bytesWritten");
      assert.ok(typeof entry.bytesWritten === "number" && entry.bytesWritten > 0,
        "bytesWritten should be a positive number");
    }
  });
});
