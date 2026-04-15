/**
 * Miller-column browser for the KB.
 *
 * Server page: resolves URL segments to column data, then hands off to the
 * client `<BrowseView>` which owns selection/delete UX. Keeping data-fetch
 * on the server means we get fresh `buildTree()` output per nav without a
 * client round-trip.
 *
 * URL shape: /browse                           → root column only
 *            /browse/imports                   → 2 columns
 *            /browse/imports/workspace/pi      → 4 columns
 */

import { buildTree } from "@/core/fs";
import type { TreeNode } from "@/core/types";
import { BrowseView } from "@/components/browse-view";
import type { BrowseColumn, BrowseChild } from "@/components/browse-view";

function toBrowseChild(n: TreeNode): BrowseChild {
  return { name: n.name, path: n.path, type: n.type };
}

function buildColumns(tree: TreeNode, segments: string[]): BrowseColumn[] {
  const cols: BrowseColumn[] = [];
  let node: TreeNode | undefined = tree;

  for (let i = 0; i <= segments.length; i++) {
    if (!node || node.type !== "directory") break;
    const children: TreeNode[] = node.children ?? [];
    const prefix = segments.slice(0, i).join("/");
    const activeChildName = segments[i] ?? null;
    cols.push({
      prefix,
      children: children.map(toBrowseChild),
      activeChildName,
    });

    if (activeChildName) {
      node = children.find((c: TreeNode) => c.name === activeChildName);
    } else {
      break;
    }
  }
  return cols;
}

export default async function BrowsePage({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const { path } = await params;
  const segments = (path ?? []).filter(Boolean);
  const tree = await buildTree();
  const columns = buildColumns(tree, segments);

  return <BrowseView columns={columns} segments={segments} />;
}
