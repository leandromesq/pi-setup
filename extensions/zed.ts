import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function zedExtension(pi: ExtensionAPI) {
  pi.registerCommand("zed", {
    description: "Open Zed in the current directory",
    handler: async (_args, ctx) => {
      try {
        const result = await pi.exec("zed", [ctx.cwd], { cwd: ctx.cwd });
        if (result.code && result.code !== 0) {
          ctx.ui.notify(`zed exited with code ${result.code}: ${result.stderr || result.stdout}`, "warning");
          return;
        }
        ctx.ui.notify(`Opening Zed: ${ctx.cwd}`, "info");
      } catch (error) {
        ctx.ui.notify(`Failed to open Zed. Is the 'zed' command on PATH? ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
