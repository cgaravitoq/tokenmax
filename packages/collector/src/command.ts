import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
) => Promise<CommandResult>;

const toText = (chunks: Buffer[]): string =>
  Buffer.concat(chunks).toString("utf8");

export function runCommand(
  command: string,
  args: string[],
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: Error) => {
      resolve({ exitCode: 1, stderr: error.message, stdout: "" });
    });
    child.on("close", (exitCode: number | null) => {
      resolve({
        exitCode: exitCode ?? 1,
        stderr: toText(stderr),
        stdout: toText(stdout),
      });
    });
  });
}
