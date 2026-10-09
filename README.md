# skillsgist-cli

Install Agent Skills from a [skillsgist](https://github.com/Qsnh/skillsgist) registry into Claude Code, Codex, Cursor and dozens of other coding agents.

```bash
npx skillsgist add https://skills.example.com/p/<project>
```

Public skills install without an account. For a project's private skills, sign in once with `npx skillsgist login <url>`, or give CI an install key in an environment variable. Neither ever goes in the URL.

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
- `https://host/p/<project>` for one project's skills;
- `https://host/p/<project>/.well-known/agent-skills/<skill>` for one skill.

Each skill lands in `.agents/skills/<name>`, or in `~/.agents/skills/<name>` with `-g`. Agents that read another directory get a symlink to it.

With `-y`, or inside an agent, a project install fails for an agent rather than write through a symlink that leads out of the project, or replace a folder in `skills/` or `data/skills/` (OpenClaw, AstrBot), where a project keeps its own skills. Without `-y`, the summary shows what will be replaced before you confirm.

Inside a coding agent (Claude Code, Codex, Cursor and others are detected from their environment), `-y` is implied and the agent is added to the targets. If `AI_AGENT` names an agent it does not know, `-y` is still implied, and the skill goes only into `.agents/skills`. Cursor's terminal on its own does not count as an agent.

## Signing in

```bash
npx skillsgist login https://skills.example.com/p/<project>
```

`login` prints a link and a code, and opens the link in your browser. Check that the page shows the same code, sign in, tick the projects this computer may install from, and approve. From then on, `add` sends the sign-in with its requests to that registry, and to no other. Add `--no-browser` to only print the link.

- Run `login` again to change the projects. The new sign-in replaces the old one, which is revoked.
- `npx skillsgist whoami` shows who you are signed in as, and for which projects.
- `npx skillsgist logout` revokes this computer's sign-in and deletes it; if you are signed in to several registries, name the one to sign out of (`npx skillsgist logout <url>`). Your account page in skillsgist lists every computer you signed in from, and can revoke any of them.
- Inside a coding agent, or without a terminal, `login` still waits for your approval in the browser before it returns. Have the agent run it in the background and pass the link and code on to you, or run `login` yourself in your own terminal.

The sign-in is kept in `~/.config/skillsgist/credentials.json` (under `$XDG_CONFIG_HOME` if set, `%APPDATA%\skillsgist` on Windows, or `$SKILLSGIST_CONFIG_DIR`), readable only by you (on Windows, the file's permissions are not changed). It lapses after 90 days without use.

## CI and containers

Generate an install key on the project's settings page, keep it in your CI's secret store, and set both variables:

```bash
SKILLSGIST_HOST=https://skills.example.com \
SKILLSGIST_INSTALL_KEY=<install key> \
npx skillsgist add https://skills.example.com/p/<project> -y
```

The key is sent in a request header, and only to the registry that `SKILLSGIST_HOST` names. It opens that one project. Nothing is written to disk.

## What can see your credentials

- **The credentials file.** Every program that runs as you can read it, coding agents included. Sign out on computers you stop using.
- **CI logs.** skillsgist never prints the key; keeping it in the secret store lets your CI mask it too.

If a sign-in leaks, revoke it on your account page. If an install key leaks, reset it on the project's settings page.

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
