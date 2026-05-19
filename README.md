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

### `obsidian`

Adds Obsidian vault note-taking tools and `/ob-*` commands for creating, searching, opening, editing, appending, templating, deleting, and capture-mode note taking. Notes are formatted in Brazilian Portuguese, preserve the user's wording as much as possible, support CS-friendly Markdown structures like code fences and LaTeX math, and require confirmation before deletion.

Config:

- `~/.pi/obsidian.json` — stores `vaultPath`, `vaultName`, `templatesDir`, `defaultNotesDir`, and `language`.

Commands:

- `/ob-config` — show or update Obsidian config.
- `/ob-new <title>` — create a general note with date/time metadata.
- `/ob-lesson <title>` — create a lesson note with matéria and professor fields.
- `/ob-open [term]` — search/select and open a note in Obsidian.
- `/ob-search <term>` — search notes by filename and contents.
- `/ob-delete [term]` — search/select/delete a note after confirmation.
- `/ob-capture-start <title>` — start plain-text capture mode into a new note.
- `/ob-capture-stop` — stop capture mode.

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
- `git:github.com/leandromesq/pi-setup`
