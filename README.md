# Leandro Pi Setup

Personal Pi setup package containing global extensions and bootstrap config.

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

The `npx` bootstrap also writes `~/.pi/searxng.json` and adds these packages to `~/.pi/agent/settings.json`:

- `npm:pi-hermes-memory`
- `npm:pi-extmgr`
- `npm:pi-searxng`
- `git:github.com/leandromesq/pi-setup`

## Notes

`pi-searxng` is configured to use a public SearXNG instance for now. Replace `~/.pi/searxng.json` with your local Docker URL later:

```json
{
  "searxngUrl": "http://localhost:8080",
  "timeoutMs": 30000,
  "maxResults": 10
}
```
