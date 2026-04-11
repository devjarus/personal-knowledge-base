"use client";

import dynamic from "next/dynamic";

// Lazy-load CommandPalette with SSR disabled: the palette contains cmdk which
// registers window event listeners and must only run in the browser.
// The dynamic import is in a client component boundary to satisfy Next.js 15.
const CommandPaletteDynamic = dynamic(
  () =>
    import("@/components/command-palette").then((m) => ({
      default: m.CommandPalette,
    })),
  { ssr: false }
);

export function CommandPaletteLoader() {
  return <CommandPaletteDynamic />;
}
