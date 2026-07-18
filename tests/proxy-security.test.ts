import { describe, expect, it } from "vitest";
import {
  formatProxyUrl,
  formatPublicProxyUrl,
  parseProxyUrl,
  redactProxyCredentials
} from "../electron/shared/proxy-security.js";

describe("proxy URL security", () => {
  it("treats an empty value as direct mode", () => {
    expect(parseProxyUrl("   ")).toBeNull();
  });

  it.each([
    [" HTTP://Proxy.Example:8080 ", "http:", "proxy.example", "8080", "http://proxy.example:8080"],
    ["https://proxy.example", "https:", "proxy.example", "", "https://proxy.example"]
  ] as const)("normalizes supported proxy URL %s", (value, protocol, hostname, port, normalized) => {
    const parsed = parseProxyUrl(value);
    expect(parsed).toMatchObject({ protocol, hostname, port, username: "", password: "", supported: true });
    expect(formatProxyUrl(parsed!)).toBe(normalized);
  });

  it("rejects unsupported schemes and URL decorations", () => {
    expect(() => parseProxyUrl("socks5://proxy.example:1080")).toThrow("HTTP or HTTPS");
    expect(() => parseProxyUrl("ftp://proxy.example:21")).toThrow("HTTP or HTTPS");
    expect(() => parseProxyUrl("http://proxy.example:8080/path")).toThrow("path");
    expect(() => parseProxyUrl("http://proxy.example:8080?mode=1")).toThrow("query");
    expect(() => parseProxyUrl("http://proxy.example:8080#token")).toThrow("fragment");
  });

  it("accepts legacy SOCKS URLs only for migration", () => {
    const parsed = parseProxyUrl("socks5://proxy.example:1080", true);
    expect(parsed).toMatchObject({ protocol: "socks5:", hostname: "proxy.example", port: "1080", supported: false });
    expect(() => formatProxyUrl(parsed!)).toThrow("unsupported");
    expect(formatPublicProxyUrl(parsed!)).toBe("socks5://proxy.example:1080");
  });

  it("extracts decoded credentials and reconstructs through URL", () => {
    const parsed = parseProxyUrl("https://alice%40example:sec%3Aret@proxy.example:8443");
    expect(parsed).toMatchObject({ username: "alice@example", password: "sec:ret" });
    expect(formatPublicProxyUrl(parsed!)).toBe("https://proxy.example:8443");
    expect(formatProxyUrl(parsed!, parsed!.password)).toBe(
      "https://alice%40example:sec%3Aret@proxy.example:8443"
    );
  });

  it("redacts proxy passwords without returning raw or encoded secrets", () => {
    const raw = "secret:value";
    const encoded = "secret%3Avalue";
    const message = `first http://alice:${raw}@proxy.example:8080 then socks5://bob:${encoded}@127.0.0.1:1080 failed`;
    const redacted = redactProxyCredentials(message);

    expect(redacted).toContain("alice");
    expect(redacted).toContain("bob");
    expect(redacted).toContain("***");
    expect(redacted).not.toContain(raw);
    expect(redacted).not.toContain(encoded);
  });
});
