#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piDir = join(homedir(), '.pi');
const agentDir = join(piDir, 'agent');
const settingsPath = join(agentDir, 'settings.json');
const source = 'git:github.com/leandromesq/pi-setup';

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

await mkdir(agentDir, { recursive: true });

const settings = await readJson(settingsPath, {});
settings.packages = Array.isArray(settings.packages) ? settings.packages : [];
for (const pkg of ['npm:pi-hermes-memory', 'npm:pi-extmgr', source]) {
  if (!settings.packages.includes(pkg)) settings.packages.push(pkg);
}
settings.retry = settings.retry ?? { enabled: true };
settings.theme = settings.theme ?? 'github-dark-default';
await writeJson(settingsPath, settings);

console.log(`Updated ${settingsPath}`);
console.log('Installing/updating Pi packages...');
spawnSync('pi', ['update'], { stdio: 'inherit', shell: process.platform === 'win32' });
console.log('\nDone. Restart pi or run /reload in an existing session.');
