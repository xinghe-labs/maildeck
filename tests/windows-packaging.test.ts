import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const packagingScript = readFileSync(new URL("../scripts/package-windows-local.ps1", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

interface PackagingRunState {
  location: string;
  csc: string;
  failed: boolean;
}

async function createPackagingFixture(npmExitCode: number) {
  const root = await mkdtemp(path.join(tmpdir(), "outlook-manager-packaging-"));
  temporaryDirectories.push(root);
  const scriptDirectory = path.join(root, "scripts");
  const electronDirectory = path.join(root, "node_modules", "electron");
  const electronDist = path.join(electronDirectory, "dist");
  const builderDirectory = path.join(root, "node_modules", ".bin");
  const toolsDirectory = path.join(root, "fake-tools");
  const callerDirectory = path.join(root, "caller");
  await Promise.all([
    mkdir(scriptDirectory, { recursive: true }),
    mkdir(electronDist, { recursive: true }),
    mkdir(builderDirectory, { recursive: true }),
    mkdir(toolsDirectory, { recursive: true }),
    mkdir(callerDirectory, { recursive: true })
  ]);

  const scriptPath = path.join(scriptDirectory, "package-windows-local.ps1");
  await Promise.all([
    writeFile(scriptPath, packagingScript, "utf8"),
    writeFile(path.join(root, "package.json"), JSON.stringify({ devDependencies: { electron: "43.3.0" } }), "utf8"),
    writeFile(path.join(electronDirectory, "cli.js"), 'console.log("v43.3.0");\n', "utf8"),
    writeFile(path.join(electronDist, "electron.exe"), "", "utf8"),
    writeFile(path.join(builderDirectory, "electron-builder.cmd"), "@echo off\r\nexit /b 0\r\n", "utf8"),
    writeFile(path.join(toolsDirectory, "npm.cmd"), `@echo off\r\nexit /b ${npmExitCode}\r\n`, "utf8")
  ]);

  return { scriptPath, toolsDirectory, callerDirectory };
}

function quotePowerShellLiteral(value: string) {
  return `'${value.replace(/'/gu, "''")}'`;
}

async function runPackagingFixture(npmExitCode: number, cscValue: string | null) {
  const fixture = await createPackagingFixture(npmExitCode);
  const scriptPath = quotePowerShellLiteral(fixture.scriptPath);
  const command = [
    "$failed = $false",
    `try { & ${scriptPath} } catch { $failed = $true }`,
    '[pscustomobject]@{ location = (Get-Location).Path; csc = [string]$env:CSC_IDENTITY_AUTO_DISCOVERY; failed = $failed } | ConvertTo-Json -Compress'
  ].join("; ");
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const { stdout } = await execFileAsync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    {
      cwd: fixture.callerDirectory,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${fixture.toolsDirectory}${path.delimiter}${process.env.PATH || process.env.Path || ""}`,
        CSC_IDENTITY_AUTO_DISCOVERY: cscValue ?? undefined
      }
    }
  );

  return {
    fixture,
    state: JSON.parse(stdout.trim()) as PackagingRunState
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("offline-first Windows packaging", () => {
  it("pins packaging to the installed Electron distribution", () => {
    expect(packagingScript).toContain("node_modules\\electron\\dist");
    expect(packagingScript).toContain("--config.electronDist=$ElectronDist");
    expect(packagingScript).toContain("$ExpectedElectronVersion");
    expect(packagingScript).toContain("$RuntimeVersion");
  });

  it("runs every release gate and disables certificate auto-discovery", () => {
    expect(packagingScript).toContain('$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"');
    expect(packagingScript).toMatch(/npm\.cmd" @\("run", "icons"\)[\s\S]*npm\.cmd" @\("run", "build"\)/u);
    expect(packagingScript).toMatch(/Invoke-Checked \$Builder[\s\S]*npm\.cmd" @\("run", "verify:release"\)/u);
    expect(packagingScript).not.toContain('npm.cmd" @("run", "dist:win")');
  });

  it.skipIf(process.platform !== "win32")(
    "restores the caller location and an unset signing environment after success",
    async () => {
      const { fixture, state } = await runPackagingFixture(0, null);

      expect(state).toEqual({
        location: fixture.callerDirectory,
        csc: "",
        failed: false
      });
    },
    20_000
  );

  it.skipIf(process.platform !== "win32")(
    "restores the caller location and signing environment after failure",
    async () => {
      const { fixture, state } = await runPackagingFixture(7, "original-value");

      expect(state).toEqual({
        location: fixture.callerDirectory,
        csc: "original-value",
        failed: true
      });
    },
    20_000
  );

  it("documents the offline-first command", () => {
    expect(readme).toContain(".\\scripts\\package-windows-local.ps1");
    expect(readme).toContain("npm run dist:win");
  });
});
