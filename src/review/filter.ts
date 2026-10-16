import type { PullFile } from "../ports";

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "npm-shrinkwrap.json",
  "cargo.lock", "go.sum", "poetry.lock", "pipfile.lock", "gemfile.lock", "composer.lock", "pubspec.lock",
  "podfile.lock", "flake.lock", "uv.lock",
]);
const IGNORED_DIRS = ["node_modules/", "vendor/", "dist/", "build/", ".next/", "__generated__/", "generated/", "__snapshots__/", "coverage/", ".yarn/"];
const IGNORED_SUFFIXES = [
  ".min.js", ".min.css", ".map", ".snap", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".zip", ".gz", ".tar", ".jar", ".mp4", ".mov", ".bin", ".pb.go", ".g.dart",
];

/** Files the model should never see: lockfiles, generated or vendored code, minified files, snapshots, binaries. */
export function isIgnoredFile(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.split("/").pop() ?? lower;
  if (LOCKFILES.has(base)) return true;
  if (IGNORED_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  return IGNORED_DIRS.some((d) => lower.startsWith(d) || lower.includes(`/${d}`));
}

export type Filtered = {
  kept: { filename: string; patch: string; additions: number; deletions: number }[];
  dropped: string[];
  /** Added plus deleted lines in the files that were kept. */
  changedLines: number;
};

export function filterFiles(files: PullFile[]): Filtered {
  const kept: Filtered["kept"] = [];
  const dropped: string[] = [];
  let changedLines = 0;
  for (const f of files) {
    // No patch means GitHub did not send a diff (binary or too large): the model cannot judge it.
    if (isIgnoredFile(f.filename) || !f.patch) {
      dropped.push(f.filename);
      continue;
    }
    kept.push({ filename: f.filename, patch: f.patch, additions: f.additions, deletions: f.deletions });
    changedLines += f.additions + f.deletions;
  }
  return { kept, dropped, changedLines };
}

/** Splits files into groups that each fit in `maxChars`. A single huge file is truncated. */
export function chunkFiles(
  files: { filename: string; patch: string }[],
  maxChars: number,
): { filename: string; patch: string }[][] {
  const chunks: { filename: string; patch: string }[][] = [];
  let current: { filename: string; patch: string }[] = [];
  let size = 0;
  for (const f of files) {
    let patch = f.patch;
    if (patch.length > maxChars) patch = patch.slice(0, maxChars) + "\n[... truncated ...]";
    const cost = patch.length + f.filename.length + 20;
    if (current.length && size + cost > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push({ filename: f.filename, patch });
    size += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
