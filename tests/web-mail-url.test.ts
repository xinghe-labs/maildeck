import { describe, expect, it } from "vitest";
import { safeAccountUrl, safeWebMailUrl } from "../electron/shared/web-mail-url.js";

describe("safeWebMailUrl", () => {
  it("allows the Outlook web links Graph returns", () => {
    expect(safeWebMailUrl("https://outlook.office365.com/owa/?ItemID=abc")).toBe(
      "https://outlook.office365.com/owa/?ItemID=abc"
    );
    expect(safeWebMailUrl("https://outlook.live.com/mail/0/inbox/id/xyz")).not.toBeNull();
    expect(safeWebMailUrl("https://outlook.cn/owa/?ItemID=abc")).not.toBeNull();
  });

  it("rejects anything that is not an https Outlook link", () => {
    expect(safeWebMailUrl("http://outlook.office365.com/owa/")).toBeNull();
    expect(safeWebMailUrl("javascript:alert(1)")).toBeNull();
    expect(safeWebMailUrl("https://evil.example/owa/?ItemID=abc")).toBeNull();
    // 不能靠子串匹配绕过：域名必须是 allowed host 本身或其子域。
    expect(safeWebMailUrl("https://outlook.office365.com.evil.example/x")).toBeNull();
    expect(safeWebMailUrl("https://eviloutlook.com/x")).toBeNull();
  });

  it("treats empty input as no link", () => {
    expect(safeWebMailUrl(null)).toBeNull();
    expect(safeWebMailUrl(undefined)).toBeNull();
    expect(safeWebMailUrl("   ")).toBeNull();
    expect(safeWebMailUrl("not a url")).toBeNull();
  });
});

describe("safeAccountUrl", () => {
  it("allows device-code login and signup pages", () => {
    expect(safeAccountUrl("https://microsoft.com/devicelogin")).not.toBeNull();
    expect(safeAccountUrl("https://login.microsoftonline.com/common/oauth2/v2.0/devicecode")).not.toBeNull();
    expect(safeAccountUrl("https://signup.live.com/signup?lic=1")).not.toBeNull();
    // 世纪互联（主权云）登录页
    expect(safeAccountUrl("https://login.chinacloudapi.cn/common/oauth2/v2.0/devicecode")).not.toBeNull();
  });

  it("rejects non-https, unknown hosts and suffix-lookalikes", () => {
    expect(safeAccountUrl("http://microsoft.com/devicelogin")).toBeNull();
    expect(safeAccountUrl("https://evil.example/signup")).toBeNull();
    // 子串仍不能绕过
    expect(safeAccountUrl("https://microsoft.com.evil.example/signup")).toBeNull();
    expect(safeAccountUrl("https://evilmicrosoft.com/signup")).toBeNull();
    expect(safeAccountUrl(null)).toBeNull();
  });
});
