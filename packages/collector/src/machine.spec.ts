import { describe, expect, it } from "vitest";
import { machineId, platformUuidFromIoreg } from "./machine";

const serverMachineId = /^[A-Za-z0-9._-]{1,64}$/;

describe("machineId", () => {
  it("reports the platform uuid alone", () => {
    expect(machineId("macbook", "3A4B5C6D-1234-5678")).toBe(
      "3A4B5C6D-1234-5678",
    );
  });

  it("answers the same identifier on every network the machine joins", () => {
    const uuid = "9DC3A7C8-9E34-5FAA-AA82-0661AD72B5FE";
    expect(machineId("MacBook-Air-de-Carlos.local", uuid)).toBe(
      machineId("pc-1333.home", uuid),
    );
  });

  it("replaces the characters the server refuses", () => {
    expect(machineId("Test MacBook Pro", null)).toBe("Test-MacBook-Pro");
  });

  it("replaces non ascii characters", () => {
    expect(machineId("caf\u00e9", null)).toBe("caf-");
  });

  it("cuts the identifier to 64 characters", () => {
    const id = machineId("h".repeat(80), null);
    expect(id).toHaveLength(64);
    expect(id).toMatch(serverMachineId);
  });

  it("falls back to the hostname without a platform uuid", () => {
    expect(machineId("Test-MacBook-Pro", null)).toBe("Test-MacBook-Pro");
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
