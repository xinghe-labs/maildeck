import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Electron release target", () => {
  it("pins the audited stable Electron release", async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8")) as {
      devDependencies?: { electron?: string };
      engines?: { node?: string };
      scripts?: Record<string, string>;
    };

    expect(packageJson.devDependencies?.electron).toBe("43.3.0");
    expect(packageJson.engines?.node).toBe(">=22.12.0");
    expect(packageJson.scripts?.["electron:install"]).toBe(
      "node node_modules/electron/install.js && node node_modules/electron/cli.js --version"
    );
    expect(packageJson.scripts?.postinstall).toBe("npm run electron:install");
    expect(packageJson.scripts?.["dist:win"]).toMatch(/^npm run electron:install && /);
  });
});
