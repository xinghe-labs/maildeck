import { describe, expect, it } from "vitest";
import { parseAccountImport } from "../electron/main/import-parser.js";

const clientId = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";

describe("parseAccountImport", () => {
  it("parses header-based CSV and quoted commas", () => {
    const [account] = parseAccountImport(
      `email,client_id,refresh_token,remark,group\nuser@example.com,${clientId},M.long-token,"primary, mailbox",A`
    );
    expect(account).toEqual({
      email: "user@example.com",
      clientId,
      refreshToken: "M.long-token",
      remark: "primary, mailbox",
      group: "A"
    });
  });

  it("ignores the password field in the six-column dashed format", () => {
    const [account] = parseAccountImport(`user@example.com----password----${clientId}----M.long-token----main----A`);
    expect(account).toMatchObject({
      email: "user@example.com",
      clientId,
      refreshToken: "M.long-token",
      remark: "main",
      group: "A"
    });
  });
});
