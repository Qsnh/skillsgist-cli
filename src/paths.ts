import { resolve, sep } from "node:path";

export function within(base: string, target: string): string | null {
  const root = resolve(base);
  const path = resolve(target);
  if (path === root) return "";
  const prefix = root.endsWith(sep) ? root : root + sep;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

function under(path: string, base: string, mark: string): string | null {
  const rest = within(base, path);
  if (rest === null) return null;
  return rest === "" ? mark : `${mark}${sep}${rest}`;
}

export function homePath(path: string, home: string): string {
  return under(path, home, "~") ?? path;
}

export function projectPath(path: string, cwd: string): string {
  return under(path, cwd, ".") ?? path;
}

export function shortPath(path: string, home: string, cwd: string): string {
  return under(path, home, "~") ?? under(path, cwd, ".") ?? path;
}
