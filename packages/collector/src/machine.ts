import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { runCommand } from "./command";

export interface MachineIdentity {
  hostname: string;
  platformUuid: string | null;
}

const disallowed = /[^A-Za-z0-9._-]/g;

const platformUuidPattern = /"IOPlatformUUID"\s*=\s*"([^"]+)"/;

export function machineId(
  hostnameValue: string,
  platformUuid: string | null,
): string {
  const raw =
    platformUuid === null ? hostnameValue : `${hostnameValue}-${platformUuid}`;
  return raw.replace(disallowed, "-").slice(0, 64);
}

export function platformUuidFromIoreg(source: string): string | null {
  return platformUuidPattern.exec(source)?.[1] ?? null;
}

async function readDarwinPlatformUuid(): Promise<string | null> {
  const result = await runCommand("ioreg", [
    "-rd1",
    "-c",
    "IOPlatformExpertDevice",
  ]);
  return result.exitCode === 0 ? platformUuidFromIoreg(result.stdout) : null;
}

async function readLinuxPlatformUuid(): Promise<string | null> {
  try {
    const value = (await readFile("/etc/machine-id", "utf8")).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

export async function readMachineIdentity(
  platform: NodeJS.Platform = process.platform,
): Promise<MachineIdentity> {
  const platformUuid =
    platform === "darwin"
      ? await readDarwinPlatformUuid()
      : platform === "linux"
        ? await readLinuxPlatformUuid()
        : null;
  return { hostname: hostname(), platformUuid };
}
