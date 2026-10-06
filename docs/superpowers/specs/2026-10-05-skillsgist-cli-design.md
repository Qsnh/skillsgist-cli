# skillsgist CLI Design

**Date:** 2026-10-05
**Repos:** `skillsgist-cli` (new CLI), `skillsgist` (server follow-up changes)
**Reference CLI:** `skills` 1.5.18 (`npx skills`), read from its published `dist/cli.mjs`

## Goal

`npx skillsgist add <url>` installs Agent Skills from a skillsgist registry into one or more coding agents. It behaves like `npx skills add` for the parts skillsgist users rely on, and it never stores or sends anywhere the install key that a skillsgist URL carries in its path (`https://host/i/<key>`).

Everything else `npx skills` does (update, remove, list, find, init, use, GitHub, GitLab and local sources) is out of scope.

## Why

A skillsgist install key lives in the URL path, because `npx skills` sends no custom headers. `npx skills` 1.5.18 leaks that URL in four ways (all confirmed in its source):

1. A global install (`-g`) writes the full artifact URL, key included, to the `sourceUrl` field of `~/.agents/.skill-lock.json` (or `$XDG_STATE_HOME/skills/.skill-lock.json`). `skills update` later prints it back.
2. Telemetry is on by default. Every install sends `skillFiles={<name>: <artifact URL>}` to `https://add-skill.vercel.sh/t` unless `DISABLE_TELEMETRY` or `DO_NOT_TRACK` is set.
3. A bare `https://host/i/<key>` matches its `owner/repo` pattern, so it calls `https://api.github.com/repos/i/<key>`.
4. It prints `Source: <full URL>` as its first line of output, which lands in agent transcripts.

(The project-level `skills-lock.json` of 1.5.18 records only the hostname. Older versions recorded the URL, which is what skillsgist's current warning text describes.)

## Threat model and guarantees

The key is still passed on the command line, so existing commands and agent prompts change only from `skills` to `skillsgist`. Within that, the CLI guarantees:

- **Nothing on disk but the skills.** It writes the installed skill files and the symlinks to them, and nothing else: no lock file, no state file, no cache, no temp files. Archives are unpacked in memory.
- **No requests but to the given origin.** The only requests are the index and the artifacts, and both must share the input URL's origin (scheme, host and port). No telemetry, no GitHub probe, no update check.
- **No key in its output.** Every line it prints, including error messages, masks the key.

Accepted limits, documented in the README and not handled by the CLI:

- The command line itself ends up in shell history and agent transcripts.
- npm writes the full command line of every `npx` run (success or failure) to `<npm cache>/_logs/*-debug-0.log`, keeping the last 10. `npx --logs-max=0 skillsgist add ...` prevents this (verified with npm 11.12). Existing `_logs` from earlier `npx skills` runs may already hold keys.

## Architecture

```
package.json      name: skillsgist, type: module, bin: { skillsgist: dist/cli.js }
                  dependencies (exact versions): @clack/prompts, fflate
                  engines: node >= 20.12 (the floor @clack/prompts sets)
src/
  cli.ts          argv parsing, `add` dispatch (aliases a, install, i), --help, --version
  source.ts       input URL validation and normalization, key extraction, redact()
  registry.ts     index fetch and validation, artifact download, sha256 check
  archive.ts      in-memory zip extraction with path and size checks, SKILL.md check
  agents.ts       agent table, installed-agent detection, running-agent detection
  installer.ts    canonical directory write, symlink or copy into agent directories
  add.ts          the add flow: selection, confirmation, install, output
test/             vitest unit tests and end-to-end tests against a local HTTP server
```

Each module has one job. `registry`, `archive` and `installer` never touch the terminal. `add.ts` receives its prompts through an interface (`select skills`, `select agents`, `select scope`, `confirm`) so tests can script every branch; `cli.ts` wires in the `@clack/prompts` implementation. The package has no install scripts.

## Command

```
npx skillsgist add <url> [options]      (aliases: a, install, i)
```

| Option | Meaning |
|---|---|
| `-g, --global` | Install into the home directory instead of the project |
| `-a, --agent <id...>` | Target agents; `'*'` means all |
| `-s, --skill <name...>` | Skills to install; `'*'` means all |
| `-y, --yes` | Skip every prompt |
| `--copy` | Copy into each agent directory instead of symlinking |
| `--all` | Same as `-s '*' -a '*' -y` |
| `-l, --list` | List the index's skills and exit |
| `-h, --help`, `-v, --version` | Usage and version (same letters as `npx skills`) |

`-a` and `-s` take values until the next argument starting with `-`, as in `npx skills`. Dropped options: `--full-depth`, `--subagent` (git sources only), `--metadata` (telemetry only). Any unknown option is an error.

## Sources

### Accepted URLs

- `https://host` — public skills
- `https://host/p/<project>` — a project's public skills
- `https://host/i/<key>` — every skill of the key's project
- `https://host/i/<key>/.well-known/agent-skills/<skill>` — one skill (the skillsgist server answers the nested index for this path)

Rules:

- The scheme must be `https:`. `http:` is accepted only when the host is `localhost`, `127.0.0.1` or `[::1]`.
- A URL with a username or password is refused.
- Query string and fragment are dropped. The base path is the pathname without a trailing `/`.

### Index lookup

Try, in order, stopping at the first that is not a 404:

1. `<origin><base>/.well-known/agent-skills/index.json`
2. `<origin><base>/.well-known/skills/index.json`

Unlike `npx skills`, the CLI never falls back to the origin's root index, so it cannot install skills from a scope other than the one asked for. Both candidates returning 404 is the error `No skills found at <masked url>`. Any other non-2xx status is an error.

### Index format

Only discovery schema 0.2.0 is supported: `$schema` must equal `https://schemas.agentskills.io/discovery/0.2.0/schema.json`, otherwise the index is rejected as unsupported. Each entry is kept only if:

- `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and is 1–64 characters
- `description` is a string of at most 1024 characters that is not empty once control characters are removed (the kept description has its control and bidi-override characters removed and its whitespace collapsed to single spaces, so it prints as one line)
- `type` is `"archive"`
- `digest` matches `^sha256:[a-f0-9]{64}$`
- `url`, resolved against the index URL, has the same origin as the input URL

An entry failing any check is skipped with a warning naming the entry (never its URL). An index with no valid entries is `No skills found at <masked url>`.

### Requests

All requests use `fetch` with `redirect: "error"` and send no credentials or custom headers. A request fails with `timed out` if the response headers take more than 30 seconds, or if the body then goes 30 seconds without a new chunk; a slow but steady download is never cut off. The index body is capped at 10 MiB and an artifact at 50 MiB, checked against `Content-Length` first and again while streaming. A connection lost while reading the index is reported as a network failure, not as invalid JSON.

## Add flow

1. Parse and validate the URL. Print `Source: <masked url>`.
2. Fetch the index. Print `Found N skill(s)`. With `--list`, print each name and description and exit 0.
3. **Skills.**
   - With `-s`, keep the entries whose name matches case-insensitively; a name with no match is an error listing the available names.
   - Otherwise, a single entry is selected automatically.
   - Otherwise, `-y` selects all.
   - Otherwise, a multiselect prompt.
4. **Agents.**
   - If the CLI runs inside a known agent (see Running-agent detection), `-y` is implied, and when `-a` is absent the targets are that agent plus the universal agents.
   - If it runs inside an agent it cannot name (an `AI_AGENT` value that maps to no agent, and no other signal matches), `-y` is implied too, and when `-a` is absent the targets are the detected installed agents plus the universal agents.
   - `-a '*'` targets every agent. `-a <ids>` targets those agents; an unknown id is an error listing the valid ids.
   - Otherwise, detect installed agents:
     - None found: with `-y`, the universal agents only (`npx skills` would target all agents here). Without `-y`, a multiselect over all agents except `eve`, with `claude-code`, `opencode` and `codex` preselected.
     - One found, or `-y`: that agent (or those agents) plus the universal agents.
     - Two or more found, interactive: a multiselect where the universal agents form a locked, always-included group and the detected agents are preselected.
   - No choice is remembered between runs.
5. **Scope.** `-g` means global. Otherwise `-y` means project. Otherwise a select prompt: Project (first), Global.
   - In global scope, agents without a global directory (`eve`, `promptscript`) are dropped from the targets if they were selected automatically, and are an error if named with `-a`.
6. **Confirm.** Without `-y`, show a summary (skills, agents, scope, method, and which existing directories will be overwritten: the canonical directory, plus any agent directory that holds something other than a link to it; a link already pointing at the canonical directory is kept and not listed) and ask to proceed. Cancelling at any prompt prints `Installation cancelled` and exits 0.
7. **Download.** For each selected skill, download the artifact, check its sha256 against `digest`, and unpack it in memory. Any failure aborts the whole run before anything is written.
8. **Install.** See Installation. Then print the result.

Without a TTY on stdin, without `-y`, not inside an agent, and without `--list`, the run fails with a message to add `-y` before it sends any request.

Artifacts are downloaded up to 4 at a time. The first failure aborts the other downloads.

## Installation

- **Directory name:** the index entry name, passed through the same sanitization as `npx skills`: lowercase, runs of characters outside `[a-z0-9._]` become `-`, leading and trailing `.` and `-` are stripped, cut to 255 characters, `unnamed-skill` if empty.
- **Canonical directory:** `<cwd>/.agents/skills/<name>` (project) or `<home>/.agents/skills/<name>` (global), where `<home>` is `os.homedir()`.
- **Agent directory:**
  - Universal agents use the canonical directory.
  - Other agents use `<cwd>/<projectDir>/<name>` (project) or `<globalDir>/<name>` (global).
- **Path safety:** every resolved directory must lie strictly inside its base; otherwise the run fails.
- **Symlink mode** (default):
  1. Remove the canonical directory if present and write the files there.
  2. For each non-universal agent, link its directory to the canonical directory with a relative symlink (a junction with an absolute target on Windows).
     - An existing symlink already pointing at the target is kept; anything else at that path is removed first.
     - If creating the link fails, fall back to copying into that agent directory and print a warning.
- **Copy mode** (`--copy`): for each distinct target directory, remove it if present and write the files.
- **Partial failure:** all downloads have passed by the time writing starts. If writing fails for some skill and agent, the remaining writes continue. The result lists the successes and the failures, and the exit code is 1. There is no rollback.

## Output

Built with `@clack/prompts` so it looks like `npx skills`. Paths are shortened by replacing the home directory prefix with `~`, then a cwd prefix with `.` (the same order as `npx skills`). The result note in symlink mode:

```
◇  Installed 1 skill
│  ✓ ~/.agents/skills/demo-skill
│    universal: Amp, Antigravity, Antigravity CLI, Cline, Codex +8 more
│    symlinked: Claude Code
└  Done!
```

In copy mode: `✓ demo-skill (copied)` followed by one `→ <path>` line per target directory. The skillsgist agent prompt tells the agent to open the `SKILL.md` in the directory this output reports, so the `✓ <canonical path>` line must keep this shape.

## Key masking

`source.ts` records the key of an `/i/<key>` URL at parse time. `redact(text)` replaces every occurrence of that key with its first 4 characters followed by `…`, and also masks any other `/i/<segment>` that directly follows a host (`scheme://host`, a dotted host name, `localhost` or a bracketed IPv6 address, each with an optional port), so a filesystem path such as `/srv/i/project` is printed unchanged. Every string the CLI prints, including error messages and causes from `fetch`, has its control characters (other than newline and tab) and bidi overrides removed and then goes through `redact()`. Stack traces are never printed, and there is no debug switch.

## Archive handling

Unpacked in memory with `fflate`. The rules:

- **Paths:** reject an absolute path, a drive letter, a backslash, and an empty, `.` or `..` segment.
- **Entries:** every entry is written as a regular file. A symlink entry is never turned into a link; its bytes land as an ordinary file. The digest check already guarantees the bytes are the ones the registry published.
- **Limits:** at most 1000 files and 50 MiB unpacked, the same as `npx skills`.
- **Root:** the archive must contain `SKILL.md` at its root, with YAML frontmatter holding a string `name` and a string `description`.
- **Writing:** every file's resolved target must lie inside the skill directory.

Directory entries are ignored. Files are written with default permissions, as `npx skills` does.

## Errors

| Situation | Result |
|---|---|
| Unknown option, missing URL | Error plus usage, exit 1 |
| Unknown `-a` id | Error listing valid ids, exit 1 |
| `-s` name not in index | Error listing available names, exit 1 |
| `-g` with an explicitly named agent that has no global directory | Error, exit 1 |
| Bad scheme, plain http to a non-loopback host, credentials in URL | Error, exit 1 |
| Network failure or timeout | Error with masked URL, exit 1 |
| Both index candidates 404, or no valid entries | `No skills found at <masked url>`, exit 1 |
| Other non-2xx, unparseable JSON, unsupported `$schema` | Error, exit 1 |
| Invalid single index entry | Warning, entry skipped |
| Artifact non-2xx, digest mismatch, invalid archive | Error, nothing written, exit 1 |
| Write failure | Successes and failures listed, exit 1 |
| No TTY, no `-y`, not in an agent | Error asking for `-y`, exit 1 |
| User cancels | `Installation cancelled`, exit 0 |

## Agents

`agents.ts` mirrors the agent table of `skills` 1.5.18 (`dist/cli.mjs`, the agents section): 73 entries, each with an id, display name, project skills directory, global skills directory (or none), a detection function, and whether it is shown in the universal group.

- **Universal agents:** the agents whose project directory is `.agents/skills`, excluding `replit` and `universal` (17 in 1.5.18). In 1.5.18, 13 of them are shown in the locked group; `dexto`, `firebender`, `loaf` and `promptscript` are hidden but still installed.
- **Environment overrides:** `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `VIBE_HOME`, `HERMES_HOME`, `AUTOHAND_HOME` and `XDG_CONFIG_HOME` change paths as in 1.5.18. Empty or whitespace-only values mean the default.
- **Installed-agent detection:** the same `existsSync` checks as 1.5.18.

### Running-agent detection

Checked in this order, as in `@vercel/detect-agent`, which 1.5.18 bundles:

| Signal | Agent |
|---|---|
| `AI_AGENT` | its value up to the first `_` or `/` (`claude-code_2-1-280_harness` → claude-code), if that names an agent |
| `CURSOR_TRACE_ID` | cursor |
| `CURSOR_AGENT`, or `CURSOR_EXTENSION_HOST_ROLE=agent-exec` | cursor |
| `GEMINI_CLI` | gemini-cli |
| `CODEX_SANDBOX`, `CODEX_CI`, `CODEX_THREAD_ID` | codex |
| `ANTIGRAVITY_AGENT` | antigravity |
| `AUGMENT_AGENT` | augment |
| `OPENCODE_CLIENT` | opencode |
| `CLAUDECODE`, `CLAUDE_CODE` | claude-code |
| `REPL_ID` | replit |
| `COPILOT_MODEL`, `COPILOT_ALLOW_ALL`, `COPILOT_GITHUB_TOKEN` | github-copilot |
| file `/opt/.devin` | universal agents only |

Notes:

- A plain `CURSOR_TRACE_ID` without the strong Cursor signal is treated as "not in an agent", as 1.5.18 does.
- `AI_AGENT` names an agent when its normalised value is a known agent id or one of the names `@vercel/detect-agent` reports (`claude`, `cowork`, `cursor-cli`, `gemini`, `augment-cli`, `github-copilot-cli`, ...). A value that names no agent does not stop the checks: the remaining signals are checked in order, so `AI_AGENT=v0` with `CLAUDECODE=1` resolves to claude-code.
- If no signal names an agent but `AI_AGENT` is set, the CLI is still treated as being in an agent, and the targets are the detected installed agents plus the universal agents.

## Testing

All with vitest, written test-first.

### Unit tests

- **source:** every accepted URL form; rejection of bad schemes, plain http to non-loopback hosts and credentials; `redact()` on the key, on other `/i/` segments and on error messages.
- **registry:** the index candidate order and the 404 fallthrough; schema rejection; each entry rule, including cross-origin URLs; digest match and mismatch; `redirect: "error"`.
- **archive:** zips built in the test with `fflate`. Path traversal, absolute paths, backslashes, drive letters, the file-count and size limits, and a missing or invalid `SKILL.md`.
- **agents:** detection against a fake home directory and environment; the environment overrides; running-agent detection order.
- **installer:** in temporary directories. Symlink and copy modes, overwrite of an existing directory, keeping a correct existing symlink, the copy fallback when symlinking fails, and the path safety check.
- **add:** with a scripted prompts implementation, every branch of the skill, agent, scope and confirm steps, cancellation, and the non-TTY error.

### End-to-end tests

A local HTTP server serves an index and zip artifacts and records every request. The built CLI runs as `node dist/cli.js add ...` with a temporary `HOME` and a temporary working directory.

Scenarios:

- `-g -y` with `CLAUDECODE=1` and `AI_AGENT=claude-code_2-1-280_harness`, as Claude Code sets them
- project `-y`
- `--copy`
- `-s` filtering
- `--list`
- a digest mismatch, which writes nothing
- a cross-origin index entry, which is skipped

Every scenario asserts that:

- the expected files and symlinks exist;
- no file under the temporary `HOME` or working directory contains the key;
- stdout and stderr do not contain the key;
- the server saw only same-origin requests, and nothing else was contacted.

## skillsgist server changes

Done in the `skillsgist` repo as part of this work. The registry protocol does not change, so `npx skills add` keeps working.

1. `src/views/skills.tsx`:
   - The command becomes `npx skillsgist add <url>`.
   - The agent prompt command becomes `npx -y skillsgist add <url> --skill <slug> -g -y`.
   - The anonymous hero names `npx skillsgist`.
2. `src/views/projects.tsx`: both install commands become `npx skillsgist add ...`.
3. `src/i18n/en.ts`, `zh-CN.ts`, `zh-TW.ts`, `ja.ts`: rewrite `commandKeyNote`. It should say that the command carries your install key for the project; that skillsgist does not store it, but shell history, npm's logs and agent transcripts may (with a pointer that `npx --logs-max=0` skips npm's logs); to keep it out of shared chats; and to reset the key in the settings if it leaks. English first, then the three translations (Taiwan wording for zh-TW).
4. `test/`: update the assertions in `projects.test.ts`, `skills.test.ts`, `i18n.test.ts` and `users.test.ts`.
5. `scripts/verify-cli.mjs`:
   - The protocol contract checks keep running the real `npx skills`.
   - The agent-prompt checks run the skillsgist CLI. Until the package is on npm, `SKILLSGIST_CLI=<path to a skillsgist-cli checkout>` replaces `npx -y skillsgist` with `node <path>/dist/cli.js`.
   - A new check asserts that no file under the isolated `HOME` contains the install key after the install.
6. `README.md`:
   - The features bullet about the agent prompt.
   - The How it works diagram (`npx skillsgist add`).
   - A short section on why `npx skillsgist`, including the npm `_logs` note and `--logs-max=0`.
7. `PRODUCT.md`: rewrite principle 2 and the related lines.
   - The server speaks only the published discovery protocol, so any compatible client works, and it never breaks `npx skills add`.
   - The UI recommends `npx skillsgist` because it does not store the install key.
8. `.github/ISSUE_TEMPLATE/bug_report.yml` and `scripts/social-preview.html`: `npx skills` becomes `npx skillsgist`.
9. `docs/images/*.png`: regenerate with the repo's screenshot and social-preview scripts. If they cannot run here, keep the old images and report it.

## Out of scope

- Other commands: `update`, `remove`, `list`, `find`, `init`, `check`, `use`.
- Other sources: GitHub, GitLab, git and local paths.
- Other formats: discovery schema 0.1 indexes, `skill-md` entries, and tar.gz archives (skillsgist serves only zip artifacts).
- Lock files of any kind, remembered agent selection, and telemetry.
- Preserving executable bits from archives.
- Scrubbing npm's debug logs.
- Reading the key from an environment variable or stdin.
