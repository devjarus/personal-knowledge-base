/**
 * rewriteLinks.ts — Conservative link rewriting pass for organize.
 *
 * Phase 3 of the auto-organize feature. Rewrites links that would otherwise
 * break after file moves. Only touches links whose post-move resolution would
 * differ from the current resolution. Err on the side of NOT touching anything
 * ambiguous.
 *
 * Link-kind rewrite matrix (spec risk #2):
 *
 *   wiki-path  [[old/path]]     → rewrite always (path form breaks on move)
 *   wiki-slug  [[slug]]          → NEVER rewrite (basename resolution is dynamic)
 *   md-path    [text](path.md)  → rewrite if path resolves to a moved note
 *   md-external [text](https://) → never touch
 *   md-relative [text](../f.md) → resolve relative to source dir, rewrite if target moved;
 *                                  if source itself also moves, compute relative from NEW src dir
 *
 * Conservative invariant (edge case #9):
 *   A link that currently resolves to null (broken) is left alone. We only rewrite
 *   links that resolve to a moved note path.
 *
 * Byte-offset tracking:
 *   Offsets are computed in the raw UTF-8 byte buffer of the file. Multiple rewrites
 *   in the same file are sorted by offset ascending so that the apply pass can
 *   apply them in the correct order without offset drift.
 *
 * Undo:
 *   `undoLinkRewrites` applies rewrite records in reverse order (last entry first)
 *   within each file, restoring the original byte sequences. This keeps offsets valid.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { OrganizeMove, LinkRewrite } from "../organize.js";
import type { LedgerRewriteRecord } from "./ledger.js";
import { appendRecord } from "./ledger.js";

// ---------------------------------------------------------------------------
// Regex patterns (mirrors links.ts — same patterns, not re-implemented)
// ---------------------------------------------------------------------------

/** Matches [[content]] including pipe-alias and fragment parts. */
const WIKI_RE = /\[\[([^\]]+)\]\]/g;

/** Matches [text](href) excluding image links. */
const MD_RE = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;

/** URL schemes to skip for md links. */
const SKIP_SCHEMES = ["http:", "https:", "mailto:", "tel:"];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip fragment (#heading) and pipe-alias (|alias) from a wiki slug/path.
 * Returns the clean slug for resolution.
 */
function stripWikiDecorations(content: string): string {
  let clean = content;
  const pipeIdx = clean.indexOf("|");
  if (pipeIdx !== -1) clean = clean.slice(0, pipeIdx);
  const hashIdx = clean.indexOf("#");
  if (hashIdx !== -1) clean = clean.slice(0, hashIdx);
  return clean.trim();
}

/**
 * Strip fragment from an md href.
 */
function stripMdFragment(href: string): string {
  const hashIdx = href.indexOf("#");
  if (hashIdx !== -1) return href.slice(0, hashIdx);
  return href;
}

/**
 * Given a wiki link's cleaned content (after stripping alias/fragment), determine
 * whether it contains a path separator (i.e., is a wiki-PATH, not a wiki-slug).
 */
function isWikiPath(slug: string): boolean {
  return slug.includes("/");
}

/**
 * Resolve a wiki slug (stripped of decorations) to a KB-relative path,
 * using the same 3-step ladder as links.ts:
 *   1. slug + ".md" exact path
 *   2. slug as-is (maybe already has .md)
 *   3. Unique basename match
 *
 * Returns null if unresolved.
 */
function resolveWikiSlug(
  slug: string,
  notePaths: Set<string>,
  basenameIndex: Map<string, string[]>
): string | null {
  const withExt = slug.endsWith(".md") ? slug : `${slug}.md`;
  if (notePaths.has(withExt)) return withExt;
  if (notePaths.has(slug)) return slug;

  const baseName = path.basename(slug, ".md");
  const candidates = basenameIndex.get(baseName) ?? [];
  if (candidates.length === 1) return candidates[0];
  return null;
}

/**
 * Resolve an md href to a KB-relative path.
 * Returns null (broken) or undefined (skip — external/out-of-root).
 */
function resolveMdHref(
  href: string,
  sourceRelPath: string,
  notePaths: Set<string>,
  root: string
): string | null | undefined {
  for (const scheme of SKIP_SCHEMES) {
    if (href.startsWith(scheme)) return undefined;
  }

  const sourceDir = path.dirname(sourceRelPath);
  const abs = path.normalize(path.join(root, sourceDir, href));

  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return undefined; // outside KB
  }

  const rel = path.relative(root, abs).split(path.sep).join("/");

  if (notePaths.has(rel)) return rel;
  const withExt = rel.endsWith(".md") ? rel : `${rel}.md`;
  if (notePaths.has(withExt)) return withExt;

  return null; // broken
}

/**
 * Build a map of all note paths and the basename index needed for resolution.
 * Takes the pre-move set of paths (the current on-disk state before apply).
 */
function buildResolutionMaps(
  paths: string[]
): { notePaths: Set<string>; basenameIndex: Map<string, string[]> } {
  const notePaths = new Set<string>(paths);
  const basenameIndex = new Map<string, string[]>();
  for (const p of paths) {
    const base = path.basename(p, ".md");
    const existing = basenameIndex.get(base) ?? [];
    existing.push(p);
    basenameIndex.set(base, existing);
  }
  return { notePaths, basenameIndex };
}

/**
 * Rewrite a wiki-path link's inner content to use the new path.
 *
 * If the original content had a fragment/alias, they are preserved.
 * e.g. [[old/a#heading|My Note]] → [[new/a#heading|My Note]]
 */
function rewriteWikiContent(originalContent: string, oldSlug: string, newSlug: string): string {
  // originalContent is everything inside [[ ]].
  // oldSlug is the resolved portion (stripped of fragment/alias).
  // We need to replace only the path part, preserving decorations.
  //
  // Find where the slug ends in the original content: it ends at the first | or #.
  // Replace from 0 to that boundary with newSlug.
  let endIdx = originalContent.length;
  const pipeIdx = originalContent.indexOf("|");
  const hashIdx = originalContent.indexOf("#");
  if (pipeIdx !== -1 && (hashIdx === -1 || pipeIdx < hashIdx)) endIdx = pipeIdx;
  else if (hashIdx !== -1) endIdx = hashIdx;

  const decorations = originalContent.slice(endIdx); // "#heading" or "|alias" or ""
  return newSlug + decorations;
}

/**
 * For a wiki-path link `[[old/x]]` or `[[old/x.md]]`, compute the new path
 * after the move. Strip .md if the original didn't have it; preserve if it did.
 */
function computeWikiNewSlug(originalSlug: string, move: OrganizeMove): string {
  const hadExt = originalSlug.endsWith(".md");
  // move.to is always a KB-relative path like "new/a.md"
  const newPath = hadExt ? move.to : move.to.replace(/\.md$/, "");
  return newPath;
}

/**
 * For an md href `(old/a.md)`, compute the new href after the move.
 * Handles both absolute-relative (from KB root) and relative paths.
 *
 * @param originalHref - the raw href from the link (may be relative)
 * @param notePath     - KB-relative path of the FILE CONTAINING the link (pre-move)
 * @param move         - the move record for the TARGET of the link
 * @param allMoves     - all moves in the plan (to handle the case where the containing file also moves)
 */
function computeMdNewHref(
  originalHref: string,
  notePath: string,   // file that contains the link (pre-move path)
  move: OrganizeMove, // move for the link target
  allMoves: OrganizeMove[]
): string {
  // Determine the effective source directory:
  // If the containing file is ALSO being moved, use the POST-MOVE directory,
  // since the link will be in the file at its new location.
  const containingFileMove = allMoves.find((m) => m.from === notePath);
  const effectiveSourceFile = containingFileMove ? containingFileMove.to : notePath;
  const effectiveSourceDir = path.dirname(effectiveSourceFile);

  // The new target is move.to (KB-relative).
  // Compute relative from effectiveSourceDir to move.to.
  let rel = path.relative(effectiveSourceDir, move.to).split(path.sep).join("/");

  // Determine whether to add a "./" prefix:
  // - Add it only if the original href was explicitly relative (started with "./" or "../").
  // - If the original href was root-relative (e.g. "old/a.md" without "./"), keep it root-relative.
  // path.relative returns e.g. "a.md" (same dir), "../bar/a.md", etc.
  const originalIsExplicitlyRelative =
    originalHref.startsWith("./") || originalHref.startsWith("../");

  if (originalIsExplicitlyRelative && !rel.startsWith("..") && !rel.startsWith("/")) {
    rel = "./" + rel;
  }

  return rel;
}

// ---------------------------------------------------------------------------
// Internal: mask inline code (same as links.ts) to avoid false positives
// ---------------------------------------------------------------------------

function maskInlineCode(line: string): string {
  let result = line;
  result = result.replace(/``.+?``/g, (m) => " ".repeat(m.length));
  result = result.replace(/`[^`\n]*?`/g, (m) => " ".repeat(m.length));
  return result;
}

// ---------------------------------------------------------------------------
// Main export: computeLinkRewrites
// ---------------------------------------------------------------------------

/**
 * Compute all link rewrites needed after a set of moves.
 *
 * Pure function modulo filesystem reads (reads note bodies to find links).
 * Does NOT write anything — just returns the `LinkRewrite[]` list.
 *
 * Only produces rewrites for links that would otherwise break:
 *   - wiki-path links whose resolved path is one of the moved files.
 *   - md-path links whose resolved target is one of the moved files.
 *   - wiki-slug links are NEVER rewritten (dynamic resolution).
 *   - Already-broken links are NEVER rewritten (edge case #9).
 *
 * For files being moved themselves: the `file` field in LinkRewrite uses the
 * PRE-MOVE path (the path at which the file currently exists on disk). The
 * apply pass writes the rewrite to that file before/during the move.
 * LOAD-BEARING: We apply link rewrites AFTER all moves succeed in applyOrganizePlan,
 * so by the time we apply rewrites, the containing file is ALREADY at its new path.
 * The LinkRewrite.file must therefore be the POST-MOVE path for files that are moved,
 * OR the original path for files that stay put. See applyOrganizePlan integration note.
 *
 * Actually — we write rewrites to files at their CURRENT location because the rewrite
 * pass runs after moves in applyOrganizePlan. Files that also move use their POST-move
 * path. But since we call computeLinkRewrites BEFORE apply (during buildOrganizePlan),
 * we track both and set file to the post-move path when applicable.
 */
export async function computeLinkRewrites(
  moves: OrganizeMove[],
  kbRoot: string
): Promise<LinkRewrite[]> {
  if (moves.length === 0) return [];

  // Build a move lookup: from → move record.
  const moveByFrom = new Map<string, OrganizeMove>();
  for (const move of moves) {
    if (move.from !== move.to) {
      moveByFrom.set(move.from, move);
    }
  }

  if (moveByFrom.size === 0) return [];

  // Collect all current note paths by reading the KB directory.
  const allPaths = await collectNotePaths(kbRoot);
  const { notePaths, basenameIndex } = buildResolutionMaps(allPaths);

  // Collect rewrites from all files.
  // LOAD-BEARING: We scan every file (moved or not) because ANY file might contain
  // links to the moved notes. For files that are themselves being moved, the rewrite
  // record uses the POST-move path as the file key (since apply runs rewrites after moves).
  const rewrites: LinkRewrite[] = [];

  await Promise.all(
    allPaths.map(async (notePath) => {
      const fileRewrites = await computeFileRewrites(
        notePath,
        kbRoot,
        moveByFrom,
        notePaths,
        basenameIndex,
        moves
      );
      rewrites.push(...fileRewrites);
    })
  );

  // Sort for determinism: by file path, then by byteOffset ascending.
  rewrites.sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.byteOffset - b.byteOffset;
  });

  return rewrites;
}

/**
 * Collect all KB-relative note paths under kbRoot.
 * Skips dotfiles and .kb-index.
 */
async function collectNotePaths(kbRoot: string): Promise<string[]> {
  const paths: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        const rel = path.relative(kbRoot, abs).split(path.sep).join("/");
        paths.push(rel);
      }
    }
  }

  await walk(kbRoot);
  paths.sort(); // determinism
  return paths;
}

/**
 * Scan a single file for links that need rewriting.
 *
 * @param notePath     - KB-relative path of the file to scan (pre-move)
 * @param kbRoot       - KB root absolute path
 * @param moveByFrom   - map from → move
 * @param notePaths    - set of all current KB note paths
 * @param basenameIndex - basename → paths[] index
 * @param allMoves     - all planned moves (for relative-link source-dir calculation)
 */
async function computeFileRewrites(
  notePath: string,
  kbRoot: string,
  moveByFrom: Map<string, OrganizeMove>,
  notePaths: Set<string>,
  basenameIndex: Map<string, string[]>,
  allMoves: OrganizeMove[]
): Promise<LinkRewrite[]> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(path.join(kbRoot, notePath));
  } catch {
    return []; // file disappeared — skip silently
  }

  const content = raw.toString("utf8");
  const lines = content.split("\n");
  const rewrites: LinkRewrite[] = [];

  // The file field in LinkRewrite uses the POST-move path if this file is being moved.
  // LOAD-BEARING: apply runs rewrites AFTER moves; so the file lives at its new path.
  const containingFileMove = allMoves.find((m) => m.from === notePath);
  const fileKeyForLedger = containingFileMove ? containingFileMove.to : notePath;

  let inCode = false;
  // Track byte offset of the start of each line in the raw UTF-8 buffer.
  // We compute this incrementally so multi-byte chars are handled correctly.
  let lineByteOffset = 0;

  for (const line of lines) {
    // Toggle code-fence state.
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      lineByteOffset += Buffer.byteLength(line, "utf8") + 1; // +1 for \n
      continue;
    }
    if (inCode) {
      lineByteOffset += Buffer.byteLength(line, "utf8") + 1;
      continue;
    }

    const maskedLine = maskInlineCode(line);

    // --- Wiki links ---
    WIKI_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_RE.exec(maskedLine)) !== null) {
      const rawInLine = line.slice(m.index, m.index + m[0].length);
      const content = m[1]; // inner part (from masked — same for non-code regions)
      const slug = stripWikiDecorations(content);

      if (!isWikiPath(slug)) {
        // wiki-slug: NEVER rewrite. Dynamic resolution is fine.
        continue;
      }

      // wiki-path: resolve to see if it points at a moved note.
      const resolved = resolveWikiSlug(slug, notePaths, basenameIndex);
      if (resolved === null) {
        // Already broken (edge case #9) — leave alone.
        continue;
      }

      const move = moveByFrom.get(resolved);
      if (!move) {
        // This link resolves to a non-moved note — no rewrite needed.
        continue;
      }

      // Compute new slug: the path portion of move.to, matching original extension style.
      const newSlug = computeWikiNewSlug(slug, move);
      const newContent = rewriteWikiContent(content, slug, newSlug);
      const after = `[[${newContent}]]`;
      const before = rawInLine;

      if (before === after) continue; // no change

      // Byte offset of the match start in the file's raw bytes.
      const byteOffset =
        lineByteOffset + Buffer.byteLength(line.slice(0, m.index), "utf8");

      rewrites.push({
        file: fileKeyForLedger,
        before,
        after,
        byteOffset,
        kind: "wiki-path",
      });
    }

    // --- Markdown links ---
    MD_RE.lastIndex = 0;
    while ((m = MD_RE.exec(maskedLine)) !== null) {
      const rawInLine = line.slice(m.index, m.index + m[0].length);
      const linkText = m[1];
      const rawHref = m[2];
      const href = stripMdFragment(rawHref).trim();

      // Skip external URLs.
      let isExternal = false;
      for (const scheme of SKIP_SCHEMES) {
        if (href.startsWith(scheme)) { isExternal = true; break; }
      }
      if (isExternal) continue;

      // Resolve href relative to this file's directory.
      const resolved = resolveMdHref(href, notePath, notePaths, kbRoot);
      if (resolved === undefined || resolved === null) {
        // External / broken — leave alone.
        continue;
      }

      const move = moveByFrom.get(resolved);
      if (!move) {
        // Resolves to a non-moved note — no rewrite needed.
        continue;
      }

      // Compute new href.
      const newHref = computeMdNewHref(rawHref, notePath, move, allMoves);
      // Preserve any fragment that was in the original href.
      const fragIdx = rawHref.indexOf("#");
      const fragment = fragIdx !== -1 ? rawHref.slice(fragIdx) : "";
      const newHrefWithFrag = newHref + fragment;

      const after = `[${linkText}](${newHrefWithFrag})`;
      const before = rawInLine;

      if (before === after) continue;

      const byteOffset =
        lineByteOffset + Buffer.byteLength(line.slice(0, m.index), "utf8");

      rewrites.push({
        file: fileKeyForLedger,
        before,
        after,
        byteOffset,
        kind: "md-path",
      });
    }

    lineByteOffset += Buffer.byteLength(line, "utf8") + 1; // +1 for the \n separator
  }

  return rewrites;
}

// ---------------------------------------------------------------------------
// applyLinkRewrites — execute rewrites file-by-file, write ledger records
// ---------------------------------------------------------------------------

/**
 * Apply all link rewrites to their respective files.
 *
 * Rewrites for each file are applied in REVERSE byte-offset order so that
 * applying one replacement doesn't shift the offsets of earlier ones in the same file.
 *
 * LOAD-BEARING: This must be called AFTER all moves have succeeded in applyOrganizePlan.
 * By this point, files that were moved are already at their new paths (move.to),
 * and `rewrite.file` uses the post-move path (set by computeFileRewrites).
 *
 * Writes one `LedgerRewriteRecord` per applied rewrite (in application order — ascending
 * byte offset within the file). Undo will replay them in reverse order (descending offset)
 * to keep byte positions valid.
 *
 * @param rewrites     - sorted ascending by (file, byteOffset)
 * @param ledgerPath   - absolute path to the active ledger (for appending records)
 * @param kbRoot       - KB root absolute path
 * @returns count of rewrite records applied
 */
export async function applyLinkRewrites(
  rewrites: LinkRewrite[],
  ledgerPath: string,
  kbRoot: string
): Promise<number> {
  if (rewrites.length === 0) return 0;

  // Group rewrites by file.
  const byFile = new Map<string, LinkRewrite[]>();
  for (const rw of rewrites) {
    const existing = byFile.get(rw.file) ?? [];
    existing.push(rw);
    byFile.set(rw.file, existing);
  }

  let applied = 0;

  for (const [fileRel, fileRewrites] of byFile) {
    const absPath = path.join(kbRoot, fileRel);

    let rawBuf: Buffer;
    try {
      rawBuf = await fs.readFile(absPath);
    } catch (err) {
      // File missing at new path — log and skip (non-fatal; the move succeeded).
      process.stderr.write(`[organize/rewriteLinks] could not read ${fileRel} for rewriting: ${err}\n`);
      continue;
    }

    // Sort rewrites for this file in DESCENDING byte-offset order so we can
    // apply replacements back-to-front without shifting earlier offsets.
    const sorted = [...fileRewrites].sort((a, b) => b.byteOffset - a.byteOffset);

    let buf = rawBuf;
    // Track which rewrites we successfully applied (in ascending order for ledger).
    const appliedRewrites: LinkRewrite[] = [];

    for (const rw of sorted) {
      const beforeBuf = Buffer.from(rw.before, "utf8");
      const afterBuf = Buffer.from(rw.after, "utf8");
      const offset = rw.byteOffset;

      // Verify the expected bytes are at the expected offset.
      // If not, the file was modified after plan computation — skip this rewrite.
      const slice = buf.slice(offset, offset + beforeBuf.length);
      if (!slice.equals(beforeBuf)) {
        process.stderr.write(
          `[organize/rewriteLinks] byte mismatch at offset ${offset} in ${fileRel}; ` +
            `expected ${JSON.stringify(rw.before)}, got ${JSON.stringify(slice.toString("utf8"))}. Skipping.\n`
        );
        continue;
      }

      // Replace in the buffer (back-to-front, so offsets of earlier rewrites are stable).
      buf = Buffer.concat([
        buf.slice(0, offset),
        afterBuf,
        buf.slice(offset + beforeBuf.length),
      ]);

      appliedRewrites.push(rw);
    }

    if (appliedRewrites.length === 0) continue;

    // Write updated file.
    await fs.writeFile(absPath, buf);

    // Write ledger records in ASCENDING offset order (the order they appear in the file),
    // so undo can walk them in reverse to restore correctly.
    const ascendingRewrites = [...appliedRewrites].sort((a, b) => a.byteOffset - b.byteOffset);
    for (const rw of ascendingRewrites) {
      const record: LedgerRewriteRecord = {
        kind: "rewrite",
        file: rw.file,
        before: rw.before,
        after: rw.after,
        byteOffset: rw.byteOffset,
        linkKind: rw.kind,
      };
      await appendRecord(ledgerPath, record);
      applied++;
    }
  }

  return applied;
}

// ---------------------------------------------------------------------------
// undoLinkRewrites — reverse ledger rewrite records
// ---------------------------------------------------------------------------

/**
 * Undo link rewrites recorded in the ledger.
 *
 * LOAD-BEARING ordering: records must be replayed in REVERSE order (last ledger entry
 * first) so that back-to-front substitution keeps byte offsets valid.
 *
 * This is called in undoLastOrganize BEFORE undoing moves, because at undo time:
 * - Files that were moved are still at their new paths (move.to).
 * - Rewrite records reference the post-move paths (rewrite.file = move.to).
 * - We need to un-rewrite the files while they're still at the moved location,
 *   THEN undo the moves to restore the original file positions.
 *
 * @param rewriteRecords - all LedgerRewriteRecords from the ledger, in ledger order
 * @param kbRoot         - KB root absolute path
 * @returns count of rewrite records reversed
 */
export async function undoLinkRewrites(
  rewriteRecords: LedgerRewriteRecord[],
  kbRoot: string
): Promise<number> {
  if (rewriteRecords.length === 0) return 0;

  // Group by file, preserving ledger order within each file.
  const byFile = new Map<string, LedgerRewriteRecord[]>();
  for (const rec of rewriteRecords) {
    const existing = byFile.get(rec.file) ?? [];
    existing.push(rec);
    byFile.set(rec.file, existing);
  }

  let reverted = 0;

  for (const [fileRel, fileRecords] of byFile) {
    const absPath = path.join(kbRoot, fileRel);

    let rawBuf: Buffer;
    try {
      rawBuf = await fs.readFile(absPath);
    } catch (err) {
      process.stderr.write(
        `[organize/rewriteLinks] could not read ${fileRel} during undo: ${err}\n`
      );
      continue;
    }

    // LOAD-BEARING: undo in DESCENDING original-offset order with pre-computed position adjustment.
    //
    // Background:
    //   Apply runs rewrites in DESCENDING original-offset order so that each replacement
    //   doesn't shift the positions of records at lower offsets. The stored `byteOffset`
    //   values are in original-file coordinates.
    //
    //   After apply, the post-apply buffer has: each rewrite's content at a position
    //   that may differ from the original offset because of other rewrites at lower offsets
    //   that were applied AFTER it (in descending order, lower offsets apply later).
    //
    //   For a record R with original offset Y, its post-apply position is:
    //     Y + sum_over_records_with_offset_less_than_Y_of(len_after - len_before)
    //   (Each lower-offset record, applied after R, shifted R's content by its delta.)
    //
    //   We undo in DESCENDING order (same as apply), adjusting each offset using this formula.
    //   After undoing R, records at lower offsets retain their pre-apply positions (not shifted
    //   by R's undo, since R was at a higher offset).
    //
    // Ledger records are in ascending original-offset order (written that way by applyLinkRewrites).
    const ascending = [...fileRecords]; // ascending original-offset order from ledger
    const descending = [...ascending].reverse();

    let buf = rawBuf;

    for (const rec of descending) {
      // During undo, we swap after → before: replace `after` with `before`.
      const afterBuf = Buffer.from(rec.after, "utf8");
      const beforeBuf = Buffer.from(rec.before, "utf8");

      // Compute the actual position of this record's content in the current post-apply buffer.
      // It equals the original offset plus the net delta from all lower-offset records
      // (which were applied AFTER this one in the apply phase, shifting our content).
      let positionAdjustment = 0;
      for (const other of ascending) {
        if (other.byteOffset < rec.byteOffset) {
          // This lower-offset record was applied after `rec` (descending apply order).
          // Its apply delta (after.length - before.length) shifted `rec`'s position.
          positionAdjustment += Buffer.byteLength(other.after, "utf8") - Buffer.byteLength(other.before, "utf8");
        }
      }
      const adjustedOffset = rec.byteOffset + positionAdjustment;

      // Verify expected bytes at adjusted position.
      const slice = buf.slice(adjustedOffset, adjustedOffset + afterBuf.length);
      if (!slice.equals(afterBuf)) {
        process.stderr.write(
          `[organize/rewriteLinks] undo byte mismatch at offset ${adjustedOffset} in ${fileRel}; ` +
            `expected ${JSON.stringify(rec.after)}, got ${JSON.stringify(slice.toString("utf8"))}. Skipping.\n`
        );
        continue;
      }

      buf = Buffer.concat([
        buf.slice(0, adjustedOffset),
        beforeBuf,
        buf.slice(adjustedOffset + afterBuf.length),
      ]);

      reverted++;
    }

    await fs.writeFile(absPath, buf);
  }

  return reverted;
}
