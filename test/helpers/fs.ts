import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skillsgist-test-")));
  made.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function sandboxExists(...roots: string[]): (path: string) => boolean {
  return (path) => roots.some((root) => path === root || path.startsWith(`${root}/`)) && existsSync(path);
}

export function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (readlinkSync(path).includes(needle)) hits.push(path);
      } else if (stat.isDirectory()) {
        walk(path);
      } else if (readFileSync(path).includes(needle)) {
        hits.push(path);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}
