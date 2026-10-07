import { detectRunningAgent, loadAgents, skillsRoot, type AgentEnvironment, type RunningAgent } from "./agents.js";
import { compareBy, formatTable } from "./format.js";
import { homePath } from "./paths.js";
import { oneLine } from "./source.js";

const HEADER = [" ", "ID", "NAME", "PROJECT", "GLOBAL"];

function insideNote(running: RunningAgent): string {
  if (!running.inAgent) return "";
  if (running.id === null) return "Inside an agent, `skillsgist add <url>` without -a installs only for the agents that read .agents/skills, whatever is ticked.\n";
  return `Inside ${running.name ?? running.id}, \`skillsgist add <url>\` without -a installs for ${running.id} and the agents that read .agents/skills, whatever is ticked.\n`;
}

export function listAgents(environment: AgentEnvironment): string {
  const { home, cwd } = environment;
  const agents = loadAgents(environment);
  const rows = [...agents]
    .sort(compareBy((agent) => agent.id))
    .map((agent) => {
      const global = skillsRoot(agent, { global: true, home, cwd });
      return [agent.installed ? "✓" : " ", agent.id, agent.displayName, agent.skillsDir, global === null ? "—" : oneLine(homePath(global, home))];
    });
  const lines = formatTable([HEADER, ...rows]);
  const note = insideNote(detectRunningAgent(environment.env, environment.exists));
  return `${agents.length} agents. Pass their IDs to \`skillsgist add <url> -a\`; ✓ marks the ones detected on this machine or in the current directory.\n${note}\n${lines.join("\n")}\n`;
}
