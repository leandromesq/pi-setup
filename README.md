# Lelezonio Pi Kit

Personal Pi kit containing global extensions, themes, and bootstrap config.

Each extension is published as its own Pi extension entry so it can be enabled, disabled, or filtered independently.

## Extensions

### `lelezonio-pi-kit`

Adds `/setup` and `/preset` for managing which extensions from this personal Pi kit are loaded. `/setup` opens a checkbox-style menu: use arrow keys to navigate, `Space` to toggle extensions, `Enter` or `s` to save and reload, `a` for all extensions, `m` for the minimal profile, and `Esc` to cancel. The kit manager keeps itself enabled so you cannot lock yourself out.

Commands:

- `/setup` — open the extension checkbox menu.
- `/setup status` — show enabled and disabled kit extensions.
- `/setup enable <extension>` — enable one extension and reload.
- `/setup disable <extension>` — disable one extension and reload.
- `/setup toggle <extension>` — toggle one extension and reload.
- `/setup full` — enable every kit extension and reload.
- `/setup minimal` — enable the minimal default set and reload.
- `/setup save <name>` — save the current extension selection as a preset.
- `/setup use <name>` — apply a preset by name and reload.
- `/setup list` — list built-in and saved presets.
- `/setup delete <name>` — delete a saved preset.
- `/preset` — choose a setup preset from a picker.
- `/preset <name>` — apply a setup preset by name.
- `/preset save <name>` — save the current extension selection as a preset.
- `/preset delete <name>` — delete a saved preset.

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

Adds `/agent` for selecting a foreground agent. Foreground agents are normal agent `.md` files with `role: foreground` or `role: both`; they can restrict callable background subagents with `background_agents`. If no agents are marked foreground, all discovered agents are selectable so names/themes can be changed freely. This replaces the older team/chain/mode workflow: foreground agents own the conversation, and background agents are invoked through the subagent tool.

Bundled foreground agents:

- `planner` — writes implementation plans under `.plans/`.
- `worker` — everyday foreground development agent.
- `plan-runner` — implements existing `.plans/` plans.
- `builder` — autonomous plan-and-implement foreground agent.

Bundled background agents:

- `explorer` — merged code explorer, docs/web researcher, and non-text asset inspector.
- `advisor` — pre-planning consultant.
- `critic` — post-plan/post-implementation reviewer.
- `coder` — focused background implementation agent.

Agent frontmatter:

```yaml
---
name: worker
role: foreground
description: Everyday foreground agent
tools: read,write,edit,bash,subagent
background_agents: explorer, advisor, critic, coder
model: openai-codex/gpt-5.5
thinking: medium
---
```

Commands:

- `/agent` — pick a foreground agent.
- `/agent <name>` — switch directly to a foreground agent.
- `/agent status` — show active foreground/background agents and tools.
- `/agent off` — disable foreground agent mode and return to normal Pi tools.

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

### `theme-cycler`

Cycles installed themes without using Ctrl+Shift shortcuts that are commonly intercepted by Zed or terminal hosts. Override the defaults with `PI_THEME_NEXT_SHORTCUT` and `PI_THEME_PREVIOUS_SHORTCUT` if needed.

Commands and shortcuts:

- `/theme` — choose a theme from a picker.
- `/theme <name>` — switch directly to a theme.
- `Alt+]` — next theme.
- `Alt+[` — previous theme.

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

Then install this kit from GitHub:

```bash
npx github:leandromesq/lelezonio-pi-kit
```

Alternatively, with Pi's package manager:

```bash
pi install git:github.com/leandromesq/lelezonio-pi-kit
```

The `npx` bootstrap also adds these packages to `~/.pi/agent/settings.json`:

- `npm:pi-hermes-memory`
- `npm:pi-extmgr`
- `npm:pi-lens` - real-time code feedback with LSP, linters, formatters, type-checking, and Dart/Flutter support via Dart LSP, `dart analyze`, and `dart format` when the Dart/Flutter SDK is on `PATH`.
- `npm:pi-simplify` - reviews recently changed code for clarity, consistency, and maintainability.
- `git:github.com/leandromesq/lelezonio-pi-kit`
