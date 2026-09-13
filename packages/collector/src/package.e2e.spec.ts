import { type ChildProcess, execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { canonicalTimezone } from "./config";

const execFileAsync = promisify(execFile);
const packageDirectory = new URL("..", import.meta.url).pathname;
const runningChildren = new Set<ChildProcess>();
const temporaryDirectories: string[] = [];

const isCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const usageDay = z
  .object({
    cache_create: z.int().min(0),
    cache_read: z.int().min(0),
    cost_usd: z.number().min(0),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isCalendarDate),
    input: z.int().min(0),
    model: z.string().min(1).max(128),
    output: z.int().min(0),
    provider: z.string().min(1).max(64),
  })
  .strict();

const usageReport = z
  .object({
    days: z.array(usageDay).min(1).max(2000),
    machine: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    timezone: z.string().transform((value, context) => {
      const zone = canonicalTimezone(value);
      if (zone === null) {
        context.addIssue({ code: "custom", message: "invalid timezone" });
        return z.NEVER;
      }
      return zone;
    }),
  })
  .strict();

interface ChildResult {
  stderr: string;
  stdout: string;
}

interface ChildFailure extends Error {
  code: number | string;
  stderr: string;
  stdout: string;
}

const isChildFailure = (error: unknown): error is ChildFailure =>
  error instanceof Error &&
  "code" in error &&
  "stderr" in error &&
  typeof error.stderr === "string" &&
  "stdout" in error &&
  typeof error.stdout === "string";

const childEnvironment = (temporaryDirectory: string): NodeJS.ProcessEnv => {
  const home = join(temporaryDirectory, "home");
  return {
    ...process.env,
    BUN_INSTALL: join(temporaryDirectory, "bun"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    HOME: home,
    TOKENMAX_HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
};

const runChild = async (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildResult> => {
  const execution = execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  runningChildren.add(execution.child);
  try {
    const result = await execution;
    return { stderr: result.stderr, stdout: result.stdout };
  } finally {
    runningChildren.delete(execution.child);
  }
};

const listen = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });

const nativePackageName = (): string => {
  const platform = process.platform;
  const arch = process.arch;
  if (
    (platform === "darwin" || platform === "linux") &&
    (arch === "arm64" || arch === "x64")
  ) {
    return `@ccusage/ccusage-${platform}-${arch}`;
  }
  throw new Error(`unsupported test platform: ${platform}-${arch}`);
};

afterAll(async () => {
  for (const child of runningChildren) {
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
  for (const temporaryDirectory of temporaryDirectories) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

it("installs and runs the packed package", async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "tokenmax-package-"));
  temporaryDirectories.push(temporaryDirectory);
  const env = childEnvironment(temporaryDirectory);
  const bunInstall = env.BUN_INSTALL;
  if (bunInstall === undefined) {
    throw new Error("BUN_INSTALL is required");
  }
  const globalModules = join(bunInstall, "install", "global", "node_modules");
  const tokenmax = join(bunInstall, "bin", "tokenmax");
  const tarball = join(temporaryDirectory, "tokenmax-collector-0.1.0.tgz");
  let server: Server | undefined;
  let nativeBinary = "";
  let disabledNativeBinary = "";

  try {
    const packed = await runChild(
      "bun",
      ["pm", "pack", "--destination", temporaryDirectory],
      packageDirectory,
      env,
    );
    const packListing = `${packed.stdout}\n${packed.stderr}`;
    expect(packListing).toContain("tokenmax-collector-0.1.0.tgz");
    expect(packListing).toContain("LICENSE");
    expect(packListing).toContain("src/cli.ts");
    expect(packListing).toContain("src/install.ts");
    expect(packListing).toContain("src/antigravity.ts");
    expect(packListing).not.toContain(".spec.ts");
    expect(packListing).not.toContain("src/test/");
    expect(packListing).toContain("Total files: 16");

    await runChild("bun", ["add", "-g", tarball], temporaryDirectory, env);
    expect(await realpath(tokenmax)).toContain(
      join("install", "global", "node_modules", "tokenmax-collector"),
    );

    const dryRun = await runChild(
      tokenmax,
      [
        "install",
        "--url",
        "http://127.0.0.1:1",
        "--key",
        "tmx_test",
        "--dry-run",
      ],
      temporaryDirectory,
      env,
    );
    expect(dryRun.stdout).toContain(
      join(bunInstall, "install", "global", "node_modules"),
    );
    expect(dryRun.stdout).not.toContain(packageDirectory);
    if (process.platform === "darwin") {
      expect(dryRun.stdout).toContain("dev.tokenmax.collector");
      expect(dryRun.stdout).toContain("Library/LaunchAgents");
    } else {
      expect(dryRun.stdout).toContain("tokenmax.service");
      expect(dryRun.stdout).toContain("tokenmax.timer");
      expect(dryRun.stdout).toContain("ExecStart");
      expect(dryRun.stdout).toContain(
        "systemctl --user enable --now tokenmax.timer",
      );
    }

    const claudeDirectory = join(env.CLAUDE_CONFIG_DIR ?? "", "projects", "p");
    await mkdir(claudeDirectory, { recursive: true });
    const timestamp = new Date().toISOString();
    await writeFile(
      join(claudeDirectory, "s.jsonl"),
      `${JSON.stringify({
        message: {
          model: "claude-sonnet-4-20250514",
          usage: {
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 11,
            input_tokens: 101,
            output_tokens: 23,
          },
        },
        timestamp,
        type: "assistant",
      })}\n`,
    );

    const reports: z.infer<typeof usageReport>[] = [];
    let requests = 0;
    server = createServer(async (request, response) => {
      requests += 1;
      if (request.headers.authorization !== "Bearer tmx_test") {
        response
          .writeHead(401, { "WWW-Authenticate": "Bearer" })
          .end('{"error":"unauthorized"}');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end('{"error":"invalid json"}');
        return;
      }
      const parsed = usageReport.safeParse(payload);
      if (
        request.method !== "POST" ||
        request.url !== "/api/report" ||
        request.headers["content-type"] !== "application/json" ||
        !parsed.success
      ) {
        response.writeHead(400).end('{"error":"invalid report"}');
        return;
      }
      reports.push(parsed.data);
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ accepted: parsed.data.days.length }));
    });
    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("stub did not bind a TCP port");
    }
    const configFile = join(
      env.XDG_CONFIG_HOME ?? "",
      "tokenmax",
      "config.json",
    );
    await mkdir(dirname(configFile), { recursive: true });
    await writeFile(
      configFile,
      `${JSON.stringify({
        key: "tmx_test",
        url: `http://127.0.0.1:${address.port}`,
      })}\n`,
    );

    const collected = await runChild(
      tokenmax,
      ["collect"],
      temporaryDirectory,
      env,
    );
    expect(collected.stdout).toMatch(/accepted 1 days for /);
    expect(requests).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.days).toHaveLength(1);
    expect(reports[0]?.days[0]).toMatchObject({
      cache_create: 7,
      cache_read: 11,
      input: 101,
      model: "claude-sonnet-4-20250514",
      output: 23,
      provider: "claude",
    });

    const ccusageCli = await realpath(
      join(globalModules, "ccusage", "src", "cli.js"),
    );
    const realGlobalModules = await realpath(globalModules);
    const require = createRequire(ccusageCli);
    nativeBinary = await realpath(
      require.resolve(`${nativePackageName()}/bin/ccusage`),
    );
    expect(ccusageCli.startsWith(realGlobalModules)).toBe(true);
    expect(nativeBinary.startsWith(realGlobalModules)).toBe(true);

    disabledNativeBinary = `${nativeBinary}.disabled`;
    await rename(nativeBinary, disabledNativeBinary);
    let failure: ChildFailure | undefined;
    try {
      await runChild(tokenmax, ["collect"], temporaryDirectory, env);
    } catch (error) {
      if (!isChildFailure(error)) {
        throw error;
      }
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(`${failure?.stdout}\n${failure?.stderr}`).toContain(
      "ccusage exited with",
    );
    await rename(disabledNativeBinary, nativeBinary);
    disabledNativeBinary = "";

    const restored = await runChild(
      tokenmax,
      ["collect"],
      temporaryDirectory,
      env,
    );
    expect(restored.stdout).toMatch(/accepted 1 days for /);
    expect(requests).toBe(2);
  } finally {
    if (disabledNativeBinary !== "") {
      await rename(disabledNativeBinary, nativeBinary);
    }
    if (server?.listening === true) {
      await close(server);
    }
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}, 180_000);
