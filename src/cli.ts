#!/usr/bin/env node
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { runAdd } from "./add.js";
import { parseCommandLine, USAGE } from "./args.js";
import { CliError } from "./errors.js";
import { clackUi } from "./ui.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(argv: string[]): Promise<number> {
  const ui = clackUi();
  try {
    const command = parseCommandLine(argv);
    if (command.kind === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (command.kind === "version") {
      process.stdout.write(`${version}\n`);
      return 0;
    }
    return await runAdd(command.url, command.options, {
      ui,
      home: homedir(),
      cwd: process.cwd(),
      env: process.env,
      interactive: Boolean(process.stdin.isTTY),
    });
  } catch (err) {
    ui.error(err instanceof Error ? err.message : String(err));
    if (err instanceof CliError && err.showUsage) process.stderr.write(USAGE);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
