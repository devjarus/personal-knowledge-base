"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { TreeNode } from "@/core/types";

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);

  if (node.type === "file") {
    const slug = node.path.replace(/\.md$/, "");
    return (
      <Link
        href={`/notes/${slug}`}
        className="block px-2 py-0.5 text-sm rounded hover:bg-black/5 dark:hover:bg-white/5"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {node.name.replace(/\.md$/, "")}
      </Link>
    );
  }

  const children = node.children ?? [];
  return (
    <div>
      {node.name && (
        <button
          type="button"
          className="block w-full text-left px-2 py-0.5 text-sm font-semibold rounded hover:bg-black/5 dark:hover:bg-white/5"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "▾" : "▸"} {node.name}
        </button>
      )}
      {open &&
        children.map((c) => (
          <TreeItem key={c.path || c.name} node={c} depth={node.name ? depth + 1 : depth} />
        ))}
    </div>
  );
}

export function TreeNav() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tree")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setTree(data);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="text-xs text-red-500">tree error: {error}</div>;
  }
  if (!tree) {
    return <div className="text-xs opacity-60">loading…</div>;
  }
  return <TreeItem node={tree} depth={0} />;
}
