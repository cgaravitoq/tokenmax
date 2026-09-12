import { describe, expect, it } from "vitest";
import { machineId, platformUuidFromIoreg } from "./machine";

const serverMachineId = /^[A-Za-z0-9._-]{1,64}$/;

describe("machineId", () => {
  it("joins the hostname and the platform uuid", () => {
    expect(machineId("macbook", "3A4B5C6D-1234-5678")).toBe(
      "macbook-3A4B5C6D-1234-5678",
    );
  });

  it("replaces the characters the server refuses", () => {
    expect(machineId("Test MacBook Pro", "0:0")).toBe("Test-MacBook-Pro-0-0");
  });

  it("replaces non ascii characters", () => {
    expect(machineId("caf\u00e9", "\u00fc")).toBe("caf---");
  });

  it("cuts the identifier to 64 characters", () => {
    const id = machineId("h".repeat(80), "u".repeat(10));
    expect(id).toHaveLength(64);
    expect(id).toMatch(serverMachineId);
  });

  it("falls back to the hostname alone without a platform uuid", () => {
    expect(machineId("Test MacBook Pro", null)).toBe("Test-MacBook-Pro");
  });
});

describe("platformUuidFromIoreg", () => {
  it("reads the platform uuid out of an ioreg dump", () => {
    const dump = [
      '    "IOPlatformUUID" = "AAAA-BBBB"',
      '    "IOPlatformSerialNumber" = "C02X"',
    ].join("\n");
    expect(platformUuidFromIoreg(dump)).toBe("AAAA-BBBB");
  });

  it("returns nothing when ioreg has no platform uuid", () => {
    expect(platformUuidFromIoreg("no uuid here")).toBeNull();
  });
});
