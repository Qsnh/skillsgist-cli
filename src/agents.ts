import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CANONICAL_SKILLS_DIR = ".agents/skills";

export type Exists = (path: string) => boolean;

export interface AgentPaths {
  home: string;
  cwd: string;
  config: string;
  claude: string;
  codex: string;
  vibe: string;
  hermes: string;
  autohand: string;
  appData: string | undefined;
  flatpakConfig: string | undefined;
}

interface AgentDef {
  id: string;
  displayName: string;
  skillsDir: string;
  globalDir: (p: AgentPaths, exists: Exists) => string | null;
  detect: (p: AgentPaths, exists: Exists) => boolean;
  hiddenInPrompt?: boolean;
  unlisted?: boolean;
}

export interface Agent {
  id: string;
  displayName: string;
  skillsDir: string;
  globalDir: string | null;
  canonical: boolean;
  universal: boolean;
  hidden: boolean;
  installed: boolean;
}

export interface AgentEnvironment {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  exists?: Exists;
}

export interface RunningAgent {
  inAgent: boolean;
  id: string | null;
}

function hasDependency(packageJsonPath: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}

function openClawGlobalDir(p: AgentPaths, exists: Exists): string {
  for (const dir of [".openclaw", ".clawdbot", ".moltbot"]) {
    if (exists(join(p.home, dir))) return join(p.home, dir, "skills");
  }
  return join(p.home, ".openclaw/skills");
}

const AGENTS: AgentDef[] = [
  { id: "aider-desk", displayName: "AiderDesk", skillsDir: ".aider-desk/skills", globalDir: (p) => join(p.home, ".aider-desk/skills"), detect: (p, exists) => exists(join(p.home, ".aider-desk")) },
  { id: "amp", displayName: "Amp", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "agents/skills"), detect: (p, exists) => exists(join(p.config, "amp")) },
  { id: "antigravity", displayName: "Antigravity", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".gemini/antigravity/skills"), detect: (p, exists) => exists(join(p.home, ".gemini/antigravity")) },
  { id: "antigravity-cli", displayName: "Antigravity CLI", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".gemini/antigravity-cli/skills"), detect: (p, exists) => exists(join(p.home, ".gemini/antigravity-cli")) },
  { id: "astrbot", displayName: "AstrBot", skillsDir: "data/skills", globalDir: (p) => join(p.home, ".astrbot/data/skills"), detect: (p, exists) => exists(join(p.cwd, "data/skills")) || exists(join(p.home, ".astrbot")) },
  { id: "autohand-code", displayName: "Autohand Code CLI", skillsDir: ".autohand/skills", globalDir: (p) => join(p.autohand, "skills"), detect: (p, exists) => exists(p.autohand) },
  { id: "augment", displayName: "Augment", skillsDir: ".augment/skills", globalDir: (p) => join(p.home, ".augment/skills"), detect: (p, exists) => exists(join(p.home, ".augment")) },
  { id: "bob", displayName: "IBM Bob", skillsDir: ".bob/skills", globalDir: (p) => join(p.home, ".bob/skills"), detect: (p, exists) => exists(join(p.home, ".bob")) },
  { id: "claude-code", displayName: "Claude Code", skillsDir: ".claude/skills", globalDir: (p) => join(p.claude, "skills"), detect: (p, exists) => exists(p.claude) },
  { id: "openclaw", displayName: "OpenClaw", skillsDir: "skills", globalDir: (p, exists) => openClawGlobalDir(p, exists), detect: (p, exists) => exists(join(p.home, ".openclaw")) || exists(join(p.home, ".clawdbot")) || exists(join(p.home, ".moltbot")) },
  { id: "cline", displayName: "Cline", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".cline")) },
  { id: "codearts-agent", displayName: "CodeArts Agent", skillsDir: ".codeartsdoer/skills", globalDir: (p) => join(p.home, ".codeartsdoer/skills"), detect: (p, exists) => exists(join(p.home, ".codeartsdoer")) },
  { id: "codebuddy", displayName: "CodeBuddy", skillsDir: ".codebuddy/skills", globalDir: (p) => join(p.home, ".codebuddy/skills"), detect: (p, exists) => exists(join(p.cwd, ".codebuddy")) || exists(join(p.home, ".codebuddy")) },
  { id: "codemaker", displayName: "Codemaker", skillsDir: ".codemaker/skills", globalDir: (p) => join(p.home, ".codemaker/skills"), detect: (p, exists) => exists(join(p.home, ".codemaker")) },
  { id: "codestudio", displayName: "Code Studio", skillsDir: ".codestudio/skills", globalDir: (p) => join(p.home, ".codestudio/skills"), detect: (p, exists) => exists(join(p.home, ".codestudio")) },
  { id: "codex", displayName: "Codex", skillsDir: ".agents/skills", globalDir: (p) => join(p.codex, "skills"), detect: (p, exists) => exists(p.codex) || exists("/etc/codex") },
  { id: "command-code", displayName: "Command Code", skillsDir: ".commandcode/skills", globalDir: (p) => join(p.home, ".commandcode/skills"), detect: (p, exists) => exists(join(p.home, ".commandcode")) },
  { id: "continue", displayName: "Continue", skillsDir: ".continue/skills", globalDir: (p) => join(p.home, ".continue/skills"), detect: (p, exists) => exists(join(p.cwd, ".continue")) || exists(join(p.home, ".continue")) },
  { id: "cortex", displayName: "Cortex Code", skillsDir: ".cortex/skills", globalDir: (p) => join(p.home, ".snowflake/cortex/skills"), detect: (p, exists) => exists(join(p.home, ".snowflake/cortex")) },
  { id: "crush", displayName: "Crush", skillsDir: ".crush/skills", globalDir: (p) => join(p.home, ".config/crush/skills"), detect: (p, exists) => exists(join(p.home, ".config/crush")) },
  { id: "cursor", displayName: "Cursor", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".cursor/skills"), detect: (p, exists) => exists(join(p.home, ".cursor")) },
  { id: "deepagents", displayName: "Deep Agents", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".deepagents/agent/skills"), detect: (p, exists) => exists(join(p.home, ".deepagents")) },
  { id: "devin", displayName: "Devin for Terminal", skillsDir: ".devin/skills", globalDir: (p) => join(p.config, "devin/skills"), detect: (p, exists) => exists(join(p.config, "devin")) },
  { id: "dexto", displayName: "Dexto", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".dexto")), hiddenInPrompt: true },
  { id: "droid", displayName: "Droid", skillsDir: ".factory/skills", globalDir: (p) => join(p.home, ".factory/skills"), detect: (p, exists) => exists(join(p.home, ".factory")) },
  { id: "eve", displayName: "Eve", skillsDir: "agent/skills", globalDir: () => null, detect: (p, exists) => exists(join(p.cwd, "agent")) && hasDependency(join(p.cwd, "package.json"), "eve") },
  { id: "firebender", displayName: "Firebender", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".firebender/skills"), detect: (p, exists) => exists(join(p.home, ".firebender")), hiddenInPrompt: true },
  { id: "forgecode", displayName: "ForgeCode", skillsDir: ".forge/skills", globalDir: (p) => join(p.home, ".forge/skills"), detect: (p, exists) => exists(join(p.home, ".forge")) },
  { id: "gemini-cli", displayName: "Gemini CLI", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".gemini/skills"), detect: (p, exists) => exists(join(p.home, ".gemini")) },
  { id: "github-copilot", displayName: "GitHub Copilot", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".copilot/skills"), detect: (p, exists) => exists(join(p.home, ".copilot")) },
  { id: "goose", displayName: "Goose", skillsDir: ".goose/skills", globalDir: (p) => join(p.config, "goose/skills"), detect: (p, exists) => exists(join(p.config, "goose")) },
  { id: "hermes-agent", displayName: "Hermes Agent", skillsDir: ".hermes/skills", globalDir: (p) => join(p.hermes, "skills"), detect: (p, exists) => exists(p.hermes) },
  { id: "inference-sh", displayName: "inference.sh", skillsDir: ".inferencesh/skills", globalDir: (p) => join(p.home, ".inferencesh/skills"), detect: (p, exists) => exists(join(p.home, ".inferencesh")) },
  { id: "jazz", displayName: "Jazz", skillsDir: ".jazz/skills", globalDir: (p) => join(p.home, ".jazz/skills"), detect: (p, exists) => exists(join(p.home, ".jazz")) || exists(join(p.cwd, ".jazz")) },
  { id: "junie", displayName: "Junie", skillsDir: ".junie/skills", globalDir: (p) => join(p.home, ".junie/skills"), detect: (p, exists) => exists(join(p.home, ".junie")) },
  { id: "iflow-cli", displayName: "iFlow CLI", skillsDir: ".iflow/skills", globalDir: (p) => join(p.home, ".iflow/skills"), detect: (p, exists) => exists(join(p.home, ".iflow")) },
  { id: "kilo", displayName: "Kilo Code", skillsDir: ".kilocode/skills", globalDir: (p) => join(p.home, ".kilocode/skills"), detect: (p, exists) => exists(join(p.home, ".kilocode")) },
  { id: "kimi-code-cli", displayName: "Kimi Code CLI", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".kimi-code")) || exists(join(p.home, ".kimi")) },
  { id: "kiro-cli", displayName: "Kiro CLI", skillsDir: ".kiro/skills", globalDir: (p) => join(p.home, ".kiro/skills"), detect: (p, exists) => exists(join(p.home, ".kiro")) },
  { id: "kode", displayName: "Kode", skillsDir: ".kode/skills", globalDir: (p) => join(p.home, ".kode/skills"), detect: (p, exists) => exists(join(p.home, ".kode")) },
  { id: "lingma", displayName: "Lingma", skillsDir: ".lingma/skills", globalDir: (p) => join(p.home, ".lingma/skills"), detect: (p, exists) => exists(join(p.home, ".lingma")) },
  { id: "loaf", displayName: "Loaf", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".loaf")), hiddenInPrompt: true },
  { id: "mcpjam", displayName: "MCPJam", skillsDir: ".mcpjam/skills", globalDir: (p) => join(p.home, ".mcpjam/skills"), detect: (p, exists) => exists(join(p.home, ".mcpjam")) },
  { id: "mistral-vibe", displayName: "Mistral Vibe", skillsDir: ".vibe/skills", globalDir: (p) => join(p.vibe, "skills"), detect: (p, exists) => exists(p.vibe) },
  { id: "moxby", displayName: "Moxby", skillsDir: ".moxby/skills", globalDir: (p) => join(p.home, ".moxby/skills"), detect: (p, exists) => exists(join(p.home, ".moxby")) },
  { id: "mux", displayName: "Mux", skillsDir: ".mux/skills", globalDir: (p) => join(p.home, ".mux/skills"), detect: (p, exists) => exists(join(p.home, ".mux")) },
  { id: "opencode", displayName: "OpenCode", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "opencode/skills"), detect: (p, exists) => exists(join(p.config, "opencode")) },
  { id: "openhands", displayName: "OpenHands", skillsDir: ".openhands/skills", globalDir: (p) => join(p.home, ".openhands/skills"), detect: (p, exists) => exists(join(p.home, ".openhands")) },
  { id: "ona", displayName: "Ona", skillsDir: ".ona/skills", globalDir: (p) => join(p.home, ".ona/skills"), detect: (p, exists) => exists(join(p.home, ".ona")) },
  { id: "pi", displayName: "Pi", skillsDir: ".pi/skills", globalDir: (p) => join(p.home, ".pi/agent/skills"), detect: (p, exists) => exists(join(p.home, ".pi/agent")) },
  { id: "qoder", displayName: "Qoder", skillsDir: ".qoder/skills", globalDir: (p) => join(p.home, ".qoder/skills"), detect: (p, exists) => exists(join(p.home, ".qoder")) },
  { id: "qoder-cn", displayName: "Qoder CN", skillsDir: ".qoder/skills", globalDir: (p) => join(p.home, ".qoder-cn/skills"), detect: (p, exists) => exists(join(p.home, ".qoder-cn")) },
  { id: "qwen-code", displayName: "Qwen Code", skillsDir: ".qwen/skills", globalDir: (p) => join(p.home, ".qwen/skills"), detect: (p, exists) => exists(join(p.home, ".qwen")) },
  { id: "replit", displayName: "Replit", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "agents/skills"), detect: (p, exists) => exists(join(p.cwd, ".replit")), unlisted: true },
  { id: "reasonix", displayName: "Reasonix", skillsDir: ".reasonix/skills", globalDir: (p) => join(p.home, ".reasonix/skills"), detect: (p, exists) => exists(join(p.home, ".reasonix")) },
  { id: "rovodev", displayName: "Rovo Dev", skillsDir: ".rovodev/skills", globalDir: (p) => join(p.home, ".rovodev/skills"), detect: (p, exists) => exists(join(p.home, ".rovodev")) },
  { id: "roo", displayName: "Roo Code", skillsDir: ".roo/skills", globalDir: (p) => join(p.home, ".roo/skills"), detect: (p, exists) => exists(join(p.home, ".roo")) },
  { id: "tabnine-cli", displayName: "Tabnine CLI", skillsDir: ".tabnine/agent/skills", globalDir: (p) => join(p.home, ".tabnine/agent/skills"), detect: (p, exists) => exists(join(p.home, ".tabnine")) },
  { id: "terramind", displayName: "Terramind", skillsDir: ".terramind/skills", globalDir: (p) => join(p.home, ".terramind/skills"), detect: (p, exists) => exists(join(p.home, ".terramind")) },
  { id: "tinycloud", displayName: "Tinycloud", skillsDir: ".tinycloud/skills", globalDir: (p) => join(p.home, ".tinycloud/skills"), detect: (p, exists) => exists(join(p.home, ".tinycloud")) },
  { id: "trae", displayName: "Trae", skillsDir: ".trae/skills", globalDir: (p) => join(p.home, ".trae/skills"), detect: (p, exists) => exists(join(p.home, ".trae")) },
  { id: "trae-cn", displayName: "Trae CN", skillsDir: ".trae/skills", globalDir: (p) => join(p.home, ".trae-cn/skills"), detect: (p, exists) => exists(join(p.home, ".trae-cn")) },
  { id: "warp", displayName: "Warp", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".warp")) },
  { id: "windsurf", displayName: "Windsurf", skillsDir: ".windsurf/skills", globalDir: (p) => join(p.home, ".codeium/windsurf/skills"), detect: (p, exists) => exists(join(p.home, ".codeium/windsurf")) },
  { id: "zed", displayName: "Zed", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.config, "zed")) || (p.appData !== undefined && exists(join(p.appData, "Zed"))) || (p.flatpakConfig !== undefined && exists(join(p.flatpakConfig, "zed"))) },
  { id: "zcode", displayName: "ZCode", skillsDir: ".zcode/skills", globalDir: (p) => join(p.home, ".zcode/skills"), detect: (p, exists) => exists(join(p.home, ".zcode")) || exists("/Applications/ZCode.app") },
  { id: "zencoder", displayName: "Zencoder", skillsDir: ".zencoder/skills", globalDir: (p) => join(p.home, ".zencoder/skills"), detect: (p, exists) => exists(join(p.home, ".zencoder")) },
  { id: "zenflow", displayName: "Zenflow", skillsDir: ".zencoder/skills", globalDir: (p) => join(p.home, ".zencoder/skills"), detect: (p, exists) => exists(join(p.home, ".zencoder")) },
  { id: "neovate", displayName: "Neovate", skillsDir: ".neovate/skills", globalDir: (p) => join(p.home, ".neovate/skills"), detect: (p, exists) => exists(join(p.home, ".neovate")) },
  { id: "pochi", displayName: "Pochi", skillsDir: ".pochi/skills", globalDir: (p) => join(p.home, ".pochi/skills"), detect: (p, exists) => exists(join(p.home, ".pochi")) },
  { id: "promptscript", displayName: "PromptScript", skillsDir: ".agents/skills", globalDir: () => null, detect: (p, exists) => exists(join(p.cwd, ".promptscript")) || exists(join(p.cwd, "promptscript.yaml")), hiddenInPrompt: true },
  { id: "adal", displayName: "AdaL", skillsDir: ".adal/skills", globalDir: (p) => join(p.home, ".adal/skills"), detect: (p, exists) => exists(join(p.home, ".adal")) },
  { id: "universal", displayName: "Universal", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "agents/skills"), detect: () => false, unlisted: true },
];

const RUNNING_AGENT_IDS: Record<string, string> = {
  cursor: "cursor",
  "cursor-cli": "cursor",
  claude: "claude-code",
  cowork: "claude-code",
  devin: "universal",
  replit: "replit",
  gemini: "gemini-cli",
  codex: "codex",
  antigravity: "antigravity",
  "augment-cli": "augment",
  opencode: "opencode",
  "github-copilot": "github-copilot",
  "github-copilot-cli": "github-copilot",
};

export function agentPaths(home: string, cwd: string, env: NodeJS.ProcessEnv): AgentPaths {
  const dir = (value: string | undefined, fallback: string) => value?.trim() || fallback;
  return {
    home,
    cwd,
    config: dir(env.XDG_CONFIG_HOME, join(home, ".config")),
    claude: dir(env.CLAUDE_CONFIG_DIR, join(home, ".claude")),
    codex: dir(env.CODEX_HOME, join(home, ".codex")),
    vibe: dir(env.VIBE_HOME, join(home, ".vibe")),
    hermes: dir(env.HERMES_HOME, join(home, ".hermes")),
    autohand: dir(env.AUTOHAND_HOME, join(home, ".autohand")),
    appData: env.APPDATA?.trim() || undefined,
    flatpakConfig: env.FLATPAK_XDG_CONFIG_HOME?.trim() || undefined,
  };
}

export function loadAgents(environment: AgentEnvironment): Agent[] {
  const exists = environment.exists ?? existsSync;
  const paths = agentPaths(environment.home, environment.cwd, environment.env);
  return AGENTS.map((def) => {
    const canonical = def.skillsDir === CANONICAL_SKILLS_DIR;
    return {
      id: def.id,
      displayName: def.displayName,
      skillsDir: def.skillsDir,
      globalDir: def.globalDir(paths, exists),
      canonical,
      universal: canonical && def.unlisted !== true,
      hidden: def.hiddenInPrompt === true,
      installed: def.detect(paths, exists),
    };
  });
}

function declaredAgentName(env: NodeJS.ProcessEnv): string | null {
  const value = env.AI_AGENT?.trim();
  return value ? value.split(/[_/]/)[0] : null;
}

function runningAgentId(name: string): string | null {
  return RUNNING_AGENT_IDS[name] ?? (AGENTS.some((agent) => agent.id === name) ? name : null);
}

function runningAgentName(env: NodeJS.ProcessEnv, exists: Exists): string | null {
  const declared = declaredAgentName(env);
  if (declared !== null && runningAgentId(declared) !== null) return declared;
  if (env.CURSOR_TRACE_ID) return "cursor";
  if (env.CURSOR_AGENT || env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec") return "cursor-cli";
  if (env.GEMINI_CLI) return "gemini";
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_THREAD_ID) return "codex";
  if (env.ANTIGRAVITY_AGENT) return "antigravity";
  if (env.AUGMENT_AGENT) return "augment-cli";
  if (env.OPENCODE_CLIENT) return "opencode";
  if (env.CLAUDECODE || env.CLAUDE_CODE) return env.CLAUDE_CODE_IS_COWORK ? "cowork" : "claude";
  if (env.REPL_ID) return "replit";
  if (env.COPILOT_MODEL || env.COPILOT_ALLOW_ALL || env.COPILOT_GITHUB_TOKEN) return "github-copilot";
  if (exists("/opt/.devin")) return "devin";
  return null;
}

export function detectRunningAgent(env: NodeJS.ProcessEnv, exists: Exists = existsSync): RunningAgent {
  const name = runningAgentName(env, exists);
  const strongCursor = Boolean(env.CURSOR_AGENT?.trim()) || env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec";
  const weakCursor = (name === "cursor" || name === "cursor-cli") && !strongCursor;
  if (name !== null && !weakCursor) return { inAgent: true, id: runningAgentId(name) };
  const declared = declaredAgentName(env);
  return { inAgent: declared !== null && runningAgentId(declared) === null, id: null };
}
