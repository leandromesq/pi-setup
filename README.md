# Leandro Pi Setup

Personal Pi setup package containing global extensions, theme, and bootstrap config.

Each extension is published as its own Pi extension entry so it can be enabled, disabled, or filtered independently:

- `favs`
- `pi-ui`
- `pi-update`
- `pwsh-user-bash`
- `scratchpad`
- `yeet`
- `zed`

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
