import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "./command";

const hang = "setTimeout(() => {}, 8000)";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tokenmax-command-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

describe("runCommand", () => {
  it("returns the output of a command that finishes", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('ok')",
    ]);

    expect(result).toEqual({ exitCode: 0, stderr: "", stdout: "ok" });
  });

  it("kills a child that outlives the timeout", async () => {
    const started = Date.now();

    const result = await runCommand(process.execPath, ["-e", hang], 200);

    expect(result).toEqual({
      exitCode: 1,
      stderr: "timed out after 200ms",
      stdout: "",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("kills a child that floods stdout", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(9 * 1024 * 1024))"],
      8000,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("output exceeded");
  });

  it("kills the grandchildren of a child that outlives the timeout", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const script = join(dir, "child.cjs");
    const grandchildSource =
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    await writeFile(
      script,
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        `const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], { stdio: "ignore" });`,
        "writeFileSync(process.argv[2], String(grandchild.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    let grandchildPid: number | undefined;
    try {
      const result = await runCommand(process.execPath, [script, pidFile], 500);

      expect(result).toEqual({
        exitCode: 1,
        stderr: "timed out after 500ms",
        stdout: "",
      });
      grandchildPid = Number(await readFile(pidFile, "utf8"));
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(await waitForDeath(grandchildPid)).toBe(true);
    } finally {
      if (grandchildPid !== undefined && isAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
    }
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}
