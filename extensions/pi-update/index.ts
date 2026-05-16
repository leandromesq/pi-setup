import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { basename, dirname, normalize } from "node:path";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const LEGACY_PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const TRANSIENT_RE = /(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|ERR_SOCKET|network timeout|socket hang up|TLS|429|503|504|temporar(?:y|ily)|try again|rate limit)/i;

type InstallMethod = "vp" | "bun" | "npm" | "brew" | "native";
type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type Ctx = ExtensionContext | ExtensionCommandContext;

const require = createRequire(import.meta.url);

async function commandOk(pi: ExtensionAPI, command: string, args: string[] = []): Promise<boolean> {
  try {
    const result = await pi.exec(command, args, { timeout: 7000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function commandOutput(pi: ExtensionAPI, command: string, args: string[] = []): Promise<string> {
  try {
    const result = await pi.exec(command, args, { timeout: 7000 });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  } catch {
    return "";
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

async function readInstalledPackage(): Promise<{ version: string; path: string; packageName: string } | undefined> {
  for (const packageName of [PACKAGE_NAME, LEGACY_PACKAGE_NAME]) {
    try {
      const path = require.resolve(`${packageName}/package.json`);
      const json = JSON.parse(await readFile(path, "utf8")) as { version?: string; name?: string };
      if (json.version) return { version: json.version, path, packageName: json.name ?? packageName };
    } catch {
      // Try the next package name.
    }
  }
}

async function getPiVersion(pi: ExtensionAPI): Promise<string> {
  const installed = await readInstalledPackage();
  if (installed?.version) return installed.version;
  const output = firstLine(await commandOutput(pi, "pi", ["--version"]));
  return output || "unknown";
}

async function detectInstallMethod(pi: ExtensionAPI): Promise<{ method: InstallMethod; reason: string }> {
  const installed = await readInstalledPackage();
  const packagePath = normalize(installed?.path ?? "").toLowerCase();
  const piPath = firstLine(await commandOutput(pi, process.platform === "win32" ? "where" : "which", ["pi"]));
  const normalizedPiPath = normalize(piPath).toLowerCase();

  if (await commandOk(pi, "vp", ["--version"])) {
    const vpRoot = firstLine(await commandOutput(pi, "vp", ["which", "pi"]));
    if (vpRoot || normalizedPiPath.includes(`${normalize(".vp")}`) || packagePath.includes(`${normalize(".vp")}`)) {
      return { method: "vp", reason: vpRoot ? `vp owns ${vpRoot}` : "vp is available and pi appears under a vp path" };
    }
  }

  if (await commandOk(pi, "brew", ["--version"])) {
    const prefix = firstLine(await commandOutput(pi, "brew", ["--prefix"]));
    if (prefix && normalizedPiPath.startsWith(normalize(prefix).toLowerCase())) {
      return { method: "brew", reason: `pi executable is under Homebrew prefix ${prefix}` };
    }
    if (await commandOk(pi, "brew", ["list", "--versions", "pi-coding-agent"])) {
      return { method: "brew", reason: "Homebrew reports pi-coding-agent installed" };
    }
  }

  if (packagePath.includes(`${normalize("bun/install/global/node_modules")}`) || packagePath.includes(`${normalize(".bun/install/global/node_modules")}`)) {
    return { method: "bun", reason: `package path is Bun global node_modules (${installed?.path})` };
  }
  if (await commandOk(pi, "bun", ["--version"])) {
    const bunRoot = firstLine(await commandOutput(pi, "bun", ["pm", "bin", "-g"]));
    if (bunRoot && normalizedPiPath.startsWith(normalize(dirname(bunRoot)).toLowerCase())) {
      return { method: "bun", reason: `pi executable is near Bun global bin ${bunRoot}` };
    }
  }

  if (packagePath.includes(`${normalize("node_modules")}`) || /(?:pi|pi\.cmd|pi\.ps1)$/i.test(basename(piPath))) {
    return { method: "npm", reason: installed ? `resolved package in node_modules (${installed.path})` : `found shim ${piPath}` };
  }

  return { method: "native", reason: installed ? `non-node_modules package path (${installed.path})` : "could not resolve package.json; assuming native binary" };
}

function updateCommand(method: InstallMethod, packageName: string): { command: string; args: string[]; display: string } {
  switch (method) {
    case "vp":
      return { command: "vp", args: ["install", `${packageName}@latest`], display: `vp install ${packageName}@latest` };
    case "bun":
      return { command: "bun", args: ["add", "-g", `${packageName}@latest`], display: `bun add -g ${packageName}@latest` };
    case "brew":
      return { command: "brew", args: ["upgrade", "pi-coding-agent"], display: "brew upgrade pi-coding-agent" };
    case "native":
      return { command: "pi", args: ["update", "--self"], display: "pi update --self" };
    case "npm":
    default:
      return { command: "npm", args: ["install", "-g", `${packageName}@latest`], display: `npm install -g ${packageName}@latest` };
  }
}

async function execWithRegistryRetry(pi: ExtensionAPI, spec: { command: string; args: string[]; timeout?: number }, ctx: Ctx): Promise<ExecResult> {
  let last: ExecResult | undefined;
  for (let attempt = 1; attempt <= 4; attempt++) {
    last = await pi.exec(spec.command, spec.args, { timeout: spec.timeout ?? 120_000 });
    const output = `${last.stdout ?? ""}\n${last.stderr ?? ""}`;
    if (last.code === 0 || !TRANSIENT_RE.test(output) || attempt === 4) return last;
    const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
    ctx.ui.notify(`Transient registry error; retrying update (${attempt}/4) in ${delayMs / 1000}s`, "warning");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last!;
}

async function npmLatest(pi: ExtensionAPI, packageName: string, ctx: Ctx): Promise<string | undefined> {
  const result = await execWithRegistryRetry(pi, { command: "npm", args: ["view", packageName, "version", "--json"] }, ctx);
  if (result.code !== 0) return undefined;
  return `${result.stdout ?? ""}`.trim().replace(/^"|"$/g, "") || undefined;
}

async function alreadyCurrent(pi: ExtensionAPI, method: InstallMethod, packageName: string, before: string, ctx: Ctx): Promise<string | undefined> {
  if (before === "unknown") return undefined;

  if (method === "brew") {
    const result = await pi.exec("brew", ["outdated", "--quiet", "pi-coding-agent"], { timeout: 15_000 });
    return result.code === 0 && `${result.stdout ?? ""}`.trim() === "" ? before : undefined;
  }

  if (method === "npm" || method === "bun" || method === "vp") {
    const latest = await npmLatest(pi, packageName, ctx);
    return latest && latest === before ? latest : undefined;
  }

  return undefined;
}

function shorten(output: string): string {
  return output.length > 4000 ? `${output.slice(-4000)}\n[output truncated]` : output;
}

function isBenignUpToDateOutput(output: string): boolean {
  return /(?:already up to date|already current|up-to-date|nothing to update|no updates? available|updated packages)/i.test(output);
}

function formatFailure(title: string, command: string, result?: ExecResult, error?: unknown): string {
  const parts = [title, `command: ${command}`];
  if (result) {
    parts.push(`exit code: ${result.code}`);
    const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    if (output) parts.push(shorten(output));
  }
  if (error) parts.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  return parts.join("\n");
}

async function runSelfUpdate(pi: ExtensionAPI, ctx: Ctx): Promise<void> {
  const before = await getPiVersion(pi);
  const detected = await detectInstallMethod(pi);
  const installed = await readInstalledPackage();
  const packageName = installed?.packageName ?? PACKAGE_NAME;
  const spec = updateCommand(detected.method, packageName);

  ctx.ui.notify(`Detected ${detected.method}: ${detected.reason}`, "info");

  const current = await alreadyCurrent(pi, detected.method, packageName, before, ctx);
  if (current) {
    ctx.ui.notify(`pi already current at ${current}\nmethod: ${detected.method}`, "info");
    return;
  }

  ctx.ui.notify(`Updating pi via ${detected.method}: ${spec.display}`, "info");

  const result = await execWithRegistryRetry(pi, spec, ctx);
  const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  if (result.code !== 0) {
    ctx.ui.notify(formatFailure("pi self-update failed", spec.display, result), "error");
    return;
  }

  const after = await getPiVersion(pi);
  const change = before === after ? `pi unchanged at ${after}` : `pi updated ${before} -> ${after}`;
  ctx.ui.notify(`${change}\nmethod: ${detected.method}\ncommand: ${spec.display}`, before === after ? "info" : "success");
}

async function runAllUpdates(pi: ExtensionAPI, ctx: Ctx): Promise<void> {
  const before = await getPiVersion(pi);
  ctx.ui.notify("Updating pi and installed pi extensions/packages: pi update", "info");

  const result = await execWithRegistryRetry(pi, { command: "pi", args: ["update"], timeout: 600_000 }, ctx);
  const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
  if (result.code !== 0 && !isBenignUpToDateOutput(output)) {
    ctx.ui.notify(formatFailure("pi update failed", "pi update", result), "error");
    return;
  }
  if (result.code !== 0) {
    ctx.ui.notify(`pi update returned exit code ${result.code}, but output indicates everything is up to date.\n\n${shorten(output)}`, "warning");
  }

  const after = await getPiVersion(pi);
  const change = before === after ? `pi unchanged at ${after}` : `pi updated ${before} -> ${after}`;
  ctx.ui.notify(`${change}\ninstalled extensions/packages checked${output ? `\n\n${shorten(output)}` : ""}`, before === after ? "info" : "success");
}

async function runUpdate(pi: ExtensionAPI, ctx: Ctx, args?: string): Promise<void> {
  const mode = args?.trim().toLowerCase();
  if (mode === "self" || mode === "pi") {
    await runSelfUpdate(pi, ctx);
    return;
  }
  if (mode === "packages" || mode === "extensions") {
    ctx.ui.notify("Updating installed pi extensions/packages: pi update", "info");
    const result = await execWithRegistryRetry(pi, { command: "pi", args: ["update"], timeout: 600_000 }, ctx);
    const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    const ok = result.code === 0 || isBenignUpToDateOutput(output);
    if (ok) {
      if (result.code !== 0) {
        ctx.ui.notify(`pi update returned exit code ${result.code}, but output indicates packages are up to date.\n\n${shorten(output)}`, "warning");
      } else {
        ctx.ui.notify(`Installed extensions/packages checked${output ? `\n\n${shorten(output)}` : ""}`, "success");
      }
    } else {
      ctx.ui.notify(formatFailure("pi package update failed", "pi update", result), "error");
    }
    return;
  }
  await runAllUpdates(pi, ctx);
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("update", {
    description: "Update pi before starting the session",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("update", {
    description: "Update pi and installed extensions/packages. Args: self|pi, packages|extensions, or blank for both",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      try {
        await runUpdate(pi, ctx, args);
      } catch (error) {
        ctx.ui.notify(formatFailure("pi update extension crashed", "/update", undefined, error), "error");
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || !pi.getFlag("update")) return;
    try {
      await runUpdate(pi, ctx);
    } catch (error) {
      ctx.ui.notify(formatFailure("pi update extension crashed", "--update", undefined, error), "error");
    }
  });
}
