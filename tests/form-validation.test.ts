import { describe, expect, it } from "vitest";
import { validateAccountFields } from "../src/form-validation";

const validToken = `M.C5${"a".repeat(1200)}`;

function tokenError(refreshToken: string, requireRefreshToken = true): string | undefined {
  return validateAccountFields(
    { email: "someone@outlook.com", clientId: "00000000-0000-0000-0000-000000000000", refreshToken },
    { requireRefreshToken }
  ).refreshToken;
}

describe("账号表单：refresh_token 格式预检", () => {
  // 报告 P2-19：填错了要等连接失败才知道，而且错误来自微软看不懂。
  it("接受正常长度的 token", () => {
    expect(tokenError(validToken)).toBeUndefined();
  });

  it("必填时给出获取方式", () => {
    expect(tokenError("")).toContain("如何获取");
  });

  it("编辑时留空表示不修改", () => {
    expect(tokenError("", false)).toBeUndefined();
  });

  it("粘进了网址", () => {
    expect(tokenError("https://login.live.com/oauth20_desktop.srf?code=M.C5abc")).toContain("网址");
  });

  it("拿成了 access_token", () => {
    expect(tokenError(`eyJ0eXAiOiJKV1QiLCJhbGciOi.${"b".repeat(80)}.${"c".repeat(40)}`)).toContain(
      "access_token"
    );
  });

  it("中间有换行说明粘贴被截断", () => {
    expect(tokenError(`${"a".repeat(60)}\n${"b".repeat(60)}`)).toContain("空格或换行");
  });

  it("太短说明没复制全", () => {
    expect(tokenError("M.C5abc")).toContain("太短");
  });

  it("邮箱格式错误仍然单独报", () => {
    const errors = validateAccountFields(
      { email: "someone", clientId: "", refreshToken: validToken },
      { requireRefreshToken: true }
    );
    expect(errors.email).toContain("邮箱格式");
    expect(errors.clientId).toContain("Client ID");
  });
});
