// Live smoke test: installed extension, actual export button, downloaded PDF.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.env.PYTHON || "python", [
  "-X", "utf8", join(root, "audits/2026-10-19/browser_fixtures.py"),
  "--live", ...process.argv.slice(2),
], { stdio: "inherit", windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
