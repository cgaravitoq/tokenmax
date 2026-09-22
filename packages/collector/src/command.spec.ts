import { describe, expect, it } from "vitest";
import { runCommand } from "./command";

const hang = "setTimeout(() => {}, 8000)";

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
});
