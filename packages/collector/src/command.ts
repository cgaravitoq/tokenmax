import { type ChildProcess, spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<CommandResult>;

const defaultTimeoutMs = 120_000;
const maxOutputBytes = 8 * 1024 * 1024;

const toText = (chunks: Buffer[]): string =>
  Buffer.concat(chunks).toString("utf8");

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function runCommand(
  command: string,
  args: string[],
  timeoutMs = defaultTimeoutMs,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    const push = (chunks: Buffer[], chunk: Buffer): void => {
      if (settled) {
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        killGroup(child);
        finish({
          exitCode: 1,
          stderr: `output exceeded ${maxOutputBytes} bytes`,
          stdout: "",
        });
        return;
      }
      chunks.push(chunk);
    };
    timer = setTimeout(() => {
      killGroup(child);
      finish({
        exitCode: 1,
        stderr: `timed out after ${timeoutMs}ms`,
        stdout: "",
      });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => push(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => push(stderr, chunk));
    child.on("error", (error: Error) => {
      finish({ exitCode: 1, stderr: error.message, stdout: "" });
    });
    child.on("close", (exitCode: number | null) => {
      finish({
        exitCode: exitCode ?? 1,
        stderr: toText(stderr),
        stdout: toText(stdout),
      });
    });
  });
}
