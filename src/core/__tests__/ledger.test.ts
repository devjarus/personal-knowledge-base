/**
 * ledger.test.ts — Unit tests for src/core/ledger.ts (shared lock + hash helpers).
 *
 * Tests:
 *  1. hashFile hashes a file correctly (SHA-256).
 *  2. acquireLock creates a lock file with our PID.
 *  3. releaseLock removes the lock file.
 *  4. releaseLock is idempotent (no error if already gone).
 *  5. acquireLock throws if a live process holds the lock.
 *  6. acquireLock auto-clears a stale lock (dead PID).
 *  7. isLockHeld returns false when no lock file.
 *  8. isLockHeld returns true when a live process holds the lock.
 *  9. isLockHeld returns false for a stale lock (dead PID).
 * 10. Cross-feature: learn can detect organize lock via isLockHeld.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

import {
  acquireLock,
  releaseLock,
  hashFile,
  isLockHeld,
} from "../ledger.js";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-ledger-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function lockFile(name: string): string {
  return path.join(tmpDir, `${name}.lock`);
}

// ---------------------------------------------------------------------------
// hashFile
// ---------------------------------------------------------------------------

describe("hashFile", () => {
  test("produces a SHA-256 hex string matching manual computation", async () => {
    const filePath = path.join(tmpDir, "hash-test.txt");
    const content = "hello world\n";
    await fs.writeFile(filePath, content, "utf8");

    const result = await hashFile(filePath);
    const expected = crypto.createHash("sha256").update(content, "utf8").digest("hex");

    assert.equal(result, expected);
    assert.equal(result.length, 64);
  });

  test("same bytes always produce same hash (deterministic)", async () => {
    const filePath = path.join(tmpDir, "hash-det.txt");
    await fs.writeFile(filePath, "deterministic content", "utf8");

    const h1 = await hashFile(filePath);
    const h2 = await hashFile(filePath);
    assert.equal(h1, h2);
  });

  test("different content produces different hash", async () => {
    const f1 = path.join(tmpDir, "hash-a.txt");
    const f2 = path.join(tmpDir, "hash-b.txt");
    await fs.writeFile(f1, "content A", "utf8");
    await fs.writeFile(f2, "content B", "utf8");

    const h1 = await hashFile(f1);
    const h2 = await hashFile(f2);
    assert.notEqual(h1, h2);
  });
});

// ---------------------------------------------------------------------------
// acquireLock + releaseLock
// ---------------------------------------------------------------------------

describe("acquireLock / releaseLock", () => {
  test("creates a lock file containing our PID", async () => {
    const lp = lockFile("acquire-create");
    await acquireLock(lp);
    try {
      const content = await fs.readFile(lp, "utf8");
      assert.equal(content.trim(), String(process.pid));
    } finally {
      await releaseLock(lp);
    }
  });

  test("releaseLock removes the lock file", async () => {
    const lp = lockFile("acquire-release");
    await acquireLock(lp);
    await releaseLock(lp);

    let exists = false;
    try {
      await fs.access(lp);
      exists = true;
    } catch {
      // ENOENT expected
    }
    assert.equal(exists, false);
  });

  test("releaseLock is idempotent when file is already gone", async () => {
    const lp = lockFile("release-idempotent");
    // Never acquired — should not throw.
    await assert.doesNotReject(() => releaseLock(lp));
  });

  test("acquireLock throws if a live process holds the lock", async () => {
    const lp = lockFile("live-lock");
    // Write our own PID (we are alive).
    await fs.mkdir(path.dirname(lp), { recursive: true });
    await fs.writeFile(lp, String(process.pid), "utf8");

    try {
      await assert.rejects(
        () => acquireLock(lp),
        (err: Error) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes(String(process.pid)));
          return true;
        }
      );
    } finally {
      await fs.rm(lp, { force: true });
    }
  });

  test("acquireLock clears a stale lock (dead PID) and acquires", async () => {
    const lp = lockFile("stale-lock");
    // Write a clearly dead PID (PID 1 on Linux is init; on macOS PID 1 is launchd — both are not ours).
    // Use a very high PID unlikely to exist.
    const deadPid = 9_999_999;
    await fs.mkdir(path.dirname(lp), { recursive: true });
    await fs.writeFile(lp, String(deadPid), "utf8");

    // If deadPid happens to be alive (extremely unlikely), skip this sub-test gracefully.
    let deadPidAlive = false;
    try {
      process.kill(deadPid, 0);
      deadPidAlive = true;
    } catch {
      deadPidAlive = false;
    }

    if (!deadPidAlive) {
      await acquireLock(lp);
      try {
        const content = await fs.readFile(lp, "utf8");
        assert.equal(content.trim(), String(process.pid));
      } finally {
        await releaseLock(lp);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// isLockHeld
// ---------------------------------------------------------------------------

describe("isLockHeld", () => {
  test("returns false when no lock file exists", async () => {
    const lp = lockFile("isLockHeld-absent");
    const held = await isLockHeld(lp);
    assert.equal(held, false);
  });

  test("returns true when our own PID holds the lock", async () => {
    const lp = lockFile("isLockHeld-alive");
    await fs.mkdir(path.dirname(lp), { recursive: true });
    await fs.writeFile(lp, String(process.pid), "utf8");
    try {
      const held = await isLockHeld(lp);
      assert.equal(held, true);
    } finally {
      await fs.rm(lp, { force: true });
    }
  });

  test("returns false for a stale lock (dead PID)", async () => {
    const lp = lockFile("isLockHeld-stale");
    const deadPid = 9_999_998;
    await fs.mkdir(path.dirname(lp), { recursive: true });
    await fs.writeFile(lp, String(deadPid), "utf8");

    let deadPidAlive = false;
    try {
      process.kill(deadPid, 0);
      deadPidAlive = true;
    } catch {
      deadPidAlive = false;
    }

    try {
      const held = await isLockHeld(lp);
      if (!deadPidAlive) {
        assert.equal(held, false);
      }
      // If deadPidAlive (very unlikely), just check it returns a boolean.
    } finally {
      await fs.rm(lp, { force: true });
    }
  });

  test("cross-feature: learn can detect organize lock via isLockHeld", async () => {
    // Simulate organize acquiring its lock, then learn checks via isLockHeld.
    const orgLock = lockFile("cross-feature-organize");
    await fs.mkdir(path.dirname(orgLock), { recursive: true });
    await fs.writeFile(orgLock, String(process.pid), "utf8");

    const learnChecksSee = await isLockHeld(orgLock);
    assert.equal(learnChecksSee, true, "learn should detect organize lock is held");

    // Clean up.
    await fs.rm(orgLock, { force: true });

    const afterRelease = await isLockHeld(orgLock);
    assert.equal(afterRelease, false, "after release, lock should not be held");
  });
});
