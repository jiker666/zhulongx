import { describe, expect, it } from "vitest";
import { inferCategory, shouldSkipTSecVpn, tsecScope } from "../src/tsec.js";
import type { AppConfig } from "../src/types.js";

function config(mode: "controlled" | "observe"): AppConfig {
  return { scope: { mode, allowedHosts: ["10.0.*.*", "10.0.*.*:*"], allowedPrograms: [] } } as unknown as AppConfig;
}

describe("TSec scope adapter", () => {
  it("uses description signals when benchmark prefixes are mixed", () => {
    expect(inferCategory("g-01", "带噪 CRC 服务使用 AES 密钥解密 flag")).toBe("Crypto");
    expect(inferCategory("g-04", "网络服务存在内存破坏漏洞，可取得 shell")).toBe("Pwn");
    expect(inferCategory("g-12", "下载 packed 二进制并逆向分析")).toBe("RE");
    expect(inferCategory("g-02", "受限 Unpickler 反序列化沙箱逃逸")).toBe("Misc");
  });

  it("allows a managed runner to opt out of the local VPN bootstrap", () => {
    expect(shouldSkipTSecVpn({ TSEC_SKIP_VPN: "1" })).toBe(true);
    expect(shouldSkipTSecVpn({ TSEC_SKIP_VPN: "0" })).toBe(false);
    expect(shouldSkipTSecVpn({})).toBe(false);
  });

  it("narrows an operator-owned VPN range to the returned host and port", () => {
    expect(tsecScope(config("controlled"), "10.0.178.80", 80, ["10.0.*.*"])).toEqual({
      mode: "controlled",
      allowedHosts: ["10.0.178.80", "10.0.178.80:80"],
    });

    expect(tsecScope(config("controlled"), "10.0.162.64", 8000, ["10.0.*.*:*"])).toEqual({
      mode: "controlled",
      allowedHosts: ["10.0.162.64:8000"],
    });
  });

  it("rejects observe mode and hosts outside the configured range", () => {
    expect(() => tsecScope(config("observe"), "10.0.178.80", 80, ["10.0.*.*"])).toThrow("controlled");
    expect(() => tsecScope(config("controlled"), "192.0.2.10", 80, ["10.0.*.*"])).toThrow("outside");
    expect(() => tsecScope(config("controlled"), "10.0.162.64", 8000, ["10.0.*.*"])).toThrow("outside");
  });
});
