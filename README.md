# skillsgist

Install Agent Skills from a [skillsgist](https://github.com/Qsnh/skillsgist) registry into Claude Code, Codex, Cursor and dozens of other coding agents, without storing the registry's install key anywhere.

```bash
npx skillsgist add https://skills.example.com/i/<install_key>
```

## Why not `npx skills`?

`npx skills add` works with a skillsgist registry. But a skillsgist install key lives in the URL, and `npx skills` 1.5 does not keep that URL to itself:

- a global install writes it to `~/.agents/.skill-lock.json`;
- its telemetry sends it to `add-skill.vercel.sh` unless `DO_NOT_TRACK` or `DISABLE_TELEMETRY` is set;
- a bare `https://host/i/<key>` is looked up on `api.github.com`;
- it prints the full URL.

`npx skillsgist add` installs into the same directories for the same agents, and:

- writes nothing but the skill files and their symlinks: no lock file, no state, no cache;
- talks to no host but the one in the URL, and never follows a redirect;
- masks the key in everything it prints (`/i/abcd…`).

## Usage

```
npx skillsgist add <url> [options]
```

| Option | Meaning |
|---|---|
| `-g, --global` | Install into your home directory instead of the project |
| `-a, --agent <ids...>` | Agents to install to; `'*'` means all |
| `-s, --skill <names...>` | Skills to install; `'*'` means all |
| `-y, --yes` | Skip all prompts |
| `--copy` | Copy into each agent directory instead of symlinking |
| `--all` | Same as `-s '*' -a '*' -y` |
| `-l, --list` | List the registry's skills without installing |

The URL is any address a skillsgist page shows:

- `https://host` for public skills;
- `https://host/p/<project>` for one project's public skills;
- `https://host/i/<key>` for every skill your key opens;
- `https://host/i/<key>/.well-known/agent-skills/<skill>` for one skill.

Each skill lands in `.agents/skills/<name>`, or in `~/.agents/skills/<name>` with `-g`. Agents that read another directory get a symlink to it. Eve, as with `npx skills`, gets its own copy in `agent/skills/<name>` instead, with the frontmatter of its `SKILL.md` cut to `description`, `license` and `metadata`.

With `-y`, or inside an agent, a project install fails for an agent rather than write through a symlink that leads out of the project, or replace a folder in `skills/` or `data/skills/` (OpenClaw, AstrBot), where a project keeps its own skills. Eve's `agent/skills/<name>` is replaced either way, as `npx skills` does, even if the project put it there. Without `-y`, the summary shows what will be replaced before you confirm.

Inside a coding agent (Claude Code, Codex, Cursor and others are detected from their environment), `-y` is implied and the agent is added to the targets. If `AI_AGENT` names an agent it does not know, `-y` is still implied, and the agents found on the machine are the targets instead. Cursor's terminal on its own does not count as an agent.

```
npx skillsgist agents
```

`agents` takes no options. It lists every agent ID `-a` accepts, with the folder `add` installs that agent's skills into in a project and with `-g`. It ticks the agents detected on this machine or in the current directory, so the ticks can change from one project to the next. Inside an agent, it also says which agents `add` installs for without `-a`. It only reads the local disk.

## What can still see the key

- **The command line.** Your shell history and the agent's transcript keep the command you ran.
- **npm's debug logs.** npm writes the full command line of every `npx` run to `_logs` in its cache directory (`npm config get cache`, usually `~/.npm`). Run `npx --logs-max=0 skillsgist add ...` to skip them, and delete old logs left by earlier `npx skills` runs.

If a key has leaked, reset it on the project's settings page in skillsgist.

## Development

```bash
npm install
npm test
npm run typecheck
```

`npm test` builds `dist/` first, because the end-to-end tests run the real binary. `npm install` and `npm pack` build it too, so the package also installs from git.

Development needs Node 22.12 or later, because vitest 5 does; the published CLI itself runs on Node 20.12 or later.

## License

[MIT](LICENSE)
