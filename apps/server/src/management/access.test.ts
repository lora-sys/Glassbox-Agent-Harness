// apps/server/src/management/access.test.ts
// Focused unit tests for the deployment-configurable management network widening.

import { describe, expect, it } from "vite-plus/test";
import { addressInNetworks, parseManagementNetworks } from "./access.js";

describe("management network widening", () => {
  it("keeps the default empty and ignores blank lists", () => {
    expect(parseManagementNetworks(undefined)).toEqual([]);
    expect(parseManagementNetworks("")).toEqual([]);
    expect(parseManagementNetworks("   ")).toEqual([]);
    expect(parseManagementNetworks(" , ")).toEqual([]);
  });

  it("parses CIDR and bare-address entries", () => {
    expect(parseManagementNetworks("172.16.0.0/12, 192.168.3.7")).toEqual([
      "172.16.0.0/12",
      "192.168.3.7",
    ]);
  });

  it("rejects malformed or out-of-range entries", () => {
    expect(() => parseManagementNetworks("not-a-network")).toThrow();
    expect(() => parseManagementNetworks("192.168.0.0/33")).toThrow();
    expect(() => parseManagementNetworks("256.1.1.1/8")).toThrow();
    expect(() => parseManagementNetworks("192.168.3.0/-1")).toThrow();
  });

  it("matches mapped and plain IPv4 addresses against networks", () => {
    const networks = parseManagementNetworks("172.16.0.0/12,192.168.3.0/24");
    expect(addressInNetworks("172.17.0.1", networks)).toBe(true);
    expect(addressInNetworks("::ffff:192.168.3.44", networks)).toBe(true);
    expect(addressInNetworks("192.168.4.1", networks)).toBe(false);
    expect(addressInNetworks("172.32.0.1", networks)).toBe(false);
    expect(addressInNetworks("::1", networks)).toBe(false);
    expect(addressInNetworks(undefined, networks)).toBe(false);
    expect(addressInNetworks("172.17.0.1", [])).toBe(false);
  });

  it("treats a bare address entry as a single-host rule", () => {
    const networks = parseManagementNetworks("192.168.3.7");
    expect(addressInNetworks("192.168.3.7", networks)).toBe(true);
    expect(addressInNetworks("192.168.3.8", networks)).toBe(false);
  });
});
