import { shortPath } from "./add.js";
import { loadAgents, type AgentEnvironment } from "./agents.js";
import { printable } from "./source.js";

const HEADER = [" ", "ID", "NAME", "PROJECT", "GLOBAL"];

export function listAgents(environment: AgentEnvironment): string {
  const agents = loadAgents(environment);
  const rows = [...agents]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((agent) => [
      agent.installed ? "✓" : " ",
      agent.id,
      agent.displayName,
      agent.skillsDir,
      agent.globalDir === null ? "—" : printable(shortPath(agent.globalDir, environment.home, environment.cwd)),
    ]);
  const table = [HEADER, ...rows];
  const widths = HEADER.map((_, column) => Math.max(...table.map((cells) => cells[column].length)));
  const lines = table.map((cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd());
  return `${agents.length} agents. Pass their IDs to \`skillsgist add <url> -a\`; ✓ marks the ones detected here.\n\n${lines.join("\n")}\n`;
}
