import { existsSync } from "node:fs";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent";

function getPwshPath() {
  if (process.env.PI_USER_BASH_PWSH) return process.env.PI_USER_BASH_PWSH;
  if (process.env.PI_USER_BASH_SHELL) return process.env.PI_USER_BASH_SHELL;
  if (process.env.SHELL && ["pwsh", "pwsh.exe"].includes(basename(process.env.SHELL).toLowerCase())) {
    return process.env.SHELL;
  }
  return "pwsh";
}

function getPiProfileCommand() {
  const profilePath = process.env.PI_USER_BASH_PWSH_PROFILE ?? "$HOME/.config/powershell/pi-profile.ps1";
  return `$piProfile = ${JSON.stringify(profilePath)}; if (Test-Path -LiteralPath $piProfile) { . $piProfile }`;
}

function createPwshOperations(): BashOperations {
  return {
    exec(command, cwd, options) {
      return new Promise((resolve, reject) => {
        if (!existsSync(cwd)) {
          reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`));
          return;
        }

        // Run PowerShell 7 directly instead of wrapping through pi's local bash
        // backend. On Windows, createLocalBashOperations() still needs Git Bash,
        // which defeats the purpose of using pwsh for user `!` commands.
        // Keep -NoProfile, then source a dedicated non-interactive Pi profile.
        const wrappedCommand = `${getPiProfileCommand()}; & { ${command} }`;
        const child = spawn(
          getPwshPath(),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            wrappedCommand,
          ],
          {
            cwd,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              ...options.env,
              // Keep PowerShell startup quiet/non-interactive and avoid profile or
              // terminal prompt integration warnings.
              POWERSHELL_TELEMETRY_OPTOUT: "1",
              NO_COLOR: process.env.NO_COLOR ?? "1",
              TERM: process.env.TERM ?? "dumb",
            },
          },
        );

        let settled = false;
        let timedOut = false;
        let timeout: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timeout) clearTimeout(timeout);
          options.signal?.removeEventListener("abort", abort);
        };

        const abort = () => {
          if (child.exitCode === null) child.kill("SIGTERM");
        };

        child.stdout?.on("data", options.onData);
        child.stderr?.on("data", options.onData);

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });

        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (options.signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${options.timeout}`));
          else resolve({ exitCode });
        });

        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });

        if (options.timeout && options.timeout > 0) {
          timeout = setTimeout(() => {
            timedOut = true;
            abort();
          }, options.timeout * 1000);
        }
      });
    },
  };
}

export default function (pi: ExtensionAPI) {
  const operations = createPwshOperations();

  pi.on("user_bash", () => ({ operations }));
}
