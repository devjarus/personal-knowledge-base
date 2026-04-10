import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { kbRoot } from "./paths";

/**
 * Sync the local KB folder with an S3 bucket.
 *
 * Strategy: "newest wins" per file, comparing mtime (local) vs. LastModified (S3).
 * Uses MD5 ETag matching to skip no-op uploads. This is intentionally simple —
 * it's NOT a CRDT. If you edit the same note on two devices between syncs,
 * the older one loses. For single-user multi-device use, that's fine.
 *
 * Ref: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
 */

function getClient(): S3Client {
  return new S3Client({
    region: process.env.AWS_REGION ?? "us-east-1",
  });
}

function bucketConfig(): { Bucket: string; Prefix: string } {
  const Bucket = process.env.KB_S3_BUCKET;
  if (!Bucket) {
    throw new Error(
      "KB_S3_BUCKET is not set. Configure it in .env to enable sync.",
    );
  }
  const rawPrefix = process.env.KB_S3_PREFIX ?? "kb/";
  const Prefix = rawPrefix.endsWith("/") ? rawPrefix : `${rawPrefix}/`;
  return { Bucket, Prefix };
}

async function walkLocal(dir: string, base = dir): Promise<Array<{ rel: string; abs: string }>> {
  const out: Array<{ rel: string; abs: string }> = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkLocal(abs, base)));
    } else if (entry.isFile()) {
      const rel = path.relative(base, abs).split(path.sep).join("/");
      out.push({ rel, abs });
    }
  }
  return out;
}

async function md5(abs: string): Promise<string> {
  const buf = await fs.readFile(abs);
  return crypto.createHash("md5").update(buf).digest("hex");
}

async function listRemote(client: S3Client): Promise<Map<string, _Object>> {
  const { Bucket, Prefix } = bucketConfig();
  const map = new Map<string, _Object>();
  let token: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      const rel = obj.Key.slice(Prefix.length);
      if (!rel) continue;
      map.set(rel, obj);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return map;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  deletedLocally: string[];
  deletedRemote: string[];
  skipped: number;
}

export interface SyncOptions {
  /** "push" only uploads; "pull" only downloads; "both" (default) does a two-way sync. */
  direction?: "push" | "pull" | "both";
  /** If true, delete files on the target that don't exist on the source. */
  mirror?: boolean;
  /** Don't actually mutate anything; report what would happen. */
  dryRun?: boolean;
}

export async function sync(opts: SyncOptions = {}): Promise<SyncResult> {
  const direction = opts.direction ?? "both";
  const client = getClient();
  const { Bucket, Prefix } = bucketConfig();
  const root = kbRoot();

  const [locals, remotes] = await Promise.all([walkLocal(root), listRemote(client)]);
  const localMap = new Map(locals.map((l) => [l.rel, l]));

  const result: SyncResult = {
    uploaded: [],
    downloaded: [],
    deletedLocally: [],
    deletedRemote: [],
    skipped: 0,
  };

  // Upload phase
  if (direction === "push" || direction === "both") {
    for (const { rel, abs } of locals) {
      const remote = remotes.get(rel);
      const localStat = await fs.stat(abs);
      const localHash = await md5(abs);
      const remoteEtag = remote?.ETag?.replace(/"/g, "");

      if (remote && remoteEtag === localHash) {
        result.skipped++;
        continue;
      }

      if (remote && remote.LastModified && direction === "both") {
        // If remote is newer, let the pull phase handle it.
        if (remote.LastModified.getTime() > localStat.mtime.getTime()) {
          continue;
        }
      }

      if (!opts.dryRun) {
        const body = await fs.readFile(abs);
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: Prefix + rel,
            Body: body,
            ContentType: rel.endsWith(".md") ? "text/markdown; charset=utf-8" : undefined,
          }),
        );
      }
      result.uploaded.push(rel);
    }
  }

  // Download phase
  if (direction === "pull" || direction === "both") {
    for (const [rel, remote] of remotes) {
      const local = localMap.get(rel);
      if (local) {
        const localStat = await fs.stat(local.abs);
        const localHash = await md5(local.abs);
        const remoteEtag = remote.ETag?.replace(/"/g, "");
        if (remoteEtag === localHash) continue;
        if (remote.LastModified && remote.LastModified.getTime() <= localStat.mtime.getTime()) {
          continue;
        }
      }

      if (!opts.dryRun) {
        const res = await client.send(
          new GetObjectCommand({ Bucket, Key: Prefix + rel }),
        );
        const body = await res.Body?.transformToByteArray();
        if (!body) continue;
        const abs = path.join(root, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, body);
      }
      result.downloaded.push(rel);
    }
  }

  // Mirror deletion (opt-in)
  if (opts.mirror) {
    if (direction === "push" || direction === "both") {
      for (const rel of remotes.keys()) {
        if (!localMap.has(rel)) {
          if (!opts.dryRun) {
            await client.send(
              new DeleteObjectCommand({ Bucket, Key: Prefix + rel }),
            );
          }
          result.deletedRemote.push(rel);
        }
      }
    }
    if (direction === "pull" || direction === "both") {
      for (const { rel, abs } of locals) {
        if (!remotes.has(rel)) {
          if (!opts.dryRun) {
            await fs.unlink(abs);
          }
          result.deletedLocally.push(rel);
        }
      }
    }
  }

  return result;
}

export function isSyncConfigured(): boolean {
  return Boolean(process.env.KB_S3_BUCKET);
}
