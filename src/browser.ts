import { spawn } from "node:child_process";

export type Opener = (url: string) => void;

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["explorer.exe", [url]];
  return ["xdg-open", [url]];
}

// Callers pass only an http(s) link on the registry's own origin. The link is
// printed as well, so a missing or failing opener is not an error.
export function openBrowser(url: string): void {
  const [command, args] = browserCommand(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // See above.
  }
}
