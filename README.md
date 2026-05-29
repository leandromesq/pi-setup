# Leandro Pi Setup

Personal Pi setup package containing global extensions, theme, and bootstrap config.

Each extension is published as its own Pi extension entry so it can be enabled, disabled, or filtered independently.

## Extensions

### `diff`

Tracks files changed during the last agent run. It records the git status baseline at agent start, watches `edit`/`write` tool results, and reports changed files when the run ends.

Commands:

- `/diff` — choose a changed file and open it in Zed.
- `/diff list` — print the tracked changed files.
- `/diff clear` — clear the tracked list and reset the git baseline.

### `favs`

Adds model favorites and keyboard shortcuts for quickly switching between commonly used provider/model/thinking-level combinations. Favorites are stored in `~/.pi/agent/model-favorites.json`; the file is created with defaults on first use.

Commands:

- `/fav` or `/fav list` — show favorites and the current favorite marker.
- `/fav <name|n>` — switch to a favorite by name or 1-based slot number.
- `/fav add <name>` — save the current model and thinking level as a favorite.
- `/fav reload` — reload favorites from disk.

Default shortcuts:

- `Alt+M` — next favorite.
- `Alt+P` or `Ctrl+Alt+M` — previous favorite.
- `Alt+1` through `Alt+4` — switch to slots 1–4.

### `git-pr`

Adds a guarded GitHub pull request workflow. `/git <target-branch>` gathers read-only git snapshots, then sends the agent a structured PR workflow prompt that requires an explicit base branch, commit planning, PR description approval, push, and `gh pr create --base <target-branch>`. It also blocks `gh pr create` tool calls that omit `--base`, and asks before allowing a base branch different from the last `/git` target for that repo.

Commands:

- `/git <target-branch>` — plan commits, push, and create a GitHub PR against the target branch.

### `orchestrator`

Adds `/mode` for selecting the active orchestration mode (`subagent`, `team`, or `chain`) from a picker, plus subagent/team/chain commands and tools. `subagent` mode gives the model subagent tools for day-to-day parallel scouting; `team` mode allows read/search plus specialist dispatch; `chain` mode runs repeatable pipelines. Team and chain agents may define optional `model` and `thinking` frontmatter fields.

Agent frontmatter:

```yaml
---
name: scout
description: Fast codebase reconnaissance
tools: read,grep,find,ls
model: openrouter/google/gemini-2.5-flash
thinking: off
---
```

Commands:

- `/mode` — pick an orchestration mode.
- `/mode status` — show current mode, active team/chain, subagents, and tools.
- `/sub <task>` — spawn a background subagent.
- `/team` — select a team and switch to team mode.
- `/team-list` — list active team agents.
- `/agents-grid <1-6>` — set team widget columns.
- `/chain` — select a chain and switch to chain mode.
- `/chain-list` — list available chains.
- `/chain-run <task>` — run the active chain directly.

### `pi-ui`

Installs a custom Pi terminal UI with a Pi header, shortcut hints, model/provider/thinking display, path and git branch status, context usage meter, custom editor border colors, fixed editor layout support, and a working-duration indicator. It also adds an editor text stash shortcut.

Commands:

- `/pi-ui` — re-enable the custom header/footer/editor UI for the current session.
- `/pi-ui-builtin` — restore Pi's built-in header/footer/editor UI for the current session.

Shortcuts:

- `Alt+S` — stash the current editor text; press again with an empty editor to restore it.

### `pi-update`

Adds an update command and startup flag. It verifies the detected Pi install method (`vp`, `bun`, `npm`, `brew`, or native), runs `pi update` so Pi and installed packages/extensions are updated together, and reports Pi plus extension version changes. If updating fails, it shows the command, detected install method, exit code, and captured stdout/stderr.

Commands and flags:

- `/update` — update Pi using the detected install method.
- `--update` — queue `/update` automatically at session start.

### `usage-bar`

Adds an interactive `/usage` overlay with AI provider quota bars, reset countdowns, plan details, and provider status indicators for Claude, GitHub Copilot, Gemini, and Codex/OpenAI where credentials are available.

Commands:

- `/usage` — show usage/quota bars and provider status. Press any key to close.

### `pwsh-user-bash`

Replaces Pi's user `!` shell backend with PowerShell 7 on Windows-oriented setups. It runs `pwsh` directly, avoids the local Git Bash wrapper, keeps startup non-interactive, and optionally sources a dedicated Pi profile before each command.

Environment variables:

- `PI_USER_BASH_PWSH` or `PI_USER_BASH_SHELL` — override the PowerShell executable path.
- `PI_USER_BASH_PWSH_PROFILE` — override the profile script sourced before commands. Defaults to `$HOME/.config/powershell/pi-profile.ps1`.

### `scratchpad`

Adds persistent pinned session notes as an above-editor widget. Notes are stored in `~/.pi/agent/scratchpad.json` and can be shown, hidden, listed, added, removed, or cleared.

Commands:

- `/note add <text>` or `/note pin <text>` — pin a note and show the scratchpad.
- `/note rm <n>` — remove note number `n`.
- `/note clear` — remove all notes.
- `/note toggle` — show or hide the widget.
- `/note list` or `/note` — list notes.

Shortcuts:

- `Alt+N` — toggle scratchpad visibility.

### `yeet`

Adds a convenience command that asks the agent to add all changes, inspect the staged diff, write a concise commit message, commit, push to the current branch's remote, and print the pushed remote or PR creation URL. If the agent is busy, the request is queued as a follow-up.

Commands:

- `/yeet` — commit and push current repository changes.
- `/yeet <instructions>` — run the same flow with extra user instructions appended.

### `zed`

Adds a command for opening the current working directory in Zed.

Commands:

- `/zed` — run `zed <cwd>` and report success or errors.

Included theme:

- `github-dark-default`

## Install on a new machine

Install Pi first:

```bash
npm install -g @earendil-works/pi-coding-agent
```

Then install this setup from GitHub:

```bash
npx github:leandromesq/pi-setup
```

Alternatively, with Pi's package manager:

```bash
pi install git:github.com/leandromesq/pi-setup
```

The `npx` bootstrap also adds these packages to `~/.pi/agent/settings.json`:

- `npm:pi-hermes-memory`
- `npm:pi-extmgr`
- `npm:pi-lens` - real-time code feedback with LSP, linters, formatters, type-checking, and Dart/Flutter support via Dart LSP, `dart analyze`, and `dart format` when the Dart/Flutter SDK is on `PATH`.
- `npm:pi-simplify` - reviews recently changed code for clarity, consistency, and maintainability.
- `git:github.com/leandromesq/pi-setup`
