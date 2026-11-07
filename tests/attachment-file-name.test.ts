import { describe, expect, it } from "vitest";
import { safeAttachmentFileName } from "../electron/main/attachment-file-name.js";

describe("safeAttachmentFileName", () => {
  it("keeps ordinary attachment names as-is", () => {
    expect(safeAttachmentFileName("invoice-2026.pdf")).toBe("invoice-2026.pdf");
    expect(safeAttachmentFileName("  report.docx  ")).toBe("report.docx");
    expect(safeAttachmentFileName("发票 G190112861.pdf")).toBe("发票 G190112861.pdf");
  });

  it("drops the directory part so the dialog never defaults outside the chosen folder", () => {
    expect(safeAttachmentFileName("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentFileName("C:\\Users\\a\\secret.txt")).toBe("secret.txt");
    expect(safeAttachmentFileName("/abs/path/file.pdf")).toBe("file.pdf");
  });

  it("replaces characters Windows refuses to write", () => {
    expect(safeAttachmentFileName('a<b>c:d"e|f?g*h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
  });

  it("strips trailing dots and spaces that Windows would silently remove", () => {
    expect(safeAttachmentFileName("name.")).toBe("name");
    expect(safeAttachmentFileName("name   ")).toBe("name");
  });

  it("escapes reserved device names", () => {
    expect(safeAttachmentFileName("CON")).toBe("_CON");
    expect(safeAttachmentFileName("nul.txt")).toBe("_nul.txt");
    expect(safeAttachmentFileName("lpt1")).toBe("_lpt1");
    // 只有完整匹配保留名时才需要转义
    expect(safeAttachmentFileName("console.log")).toBe("console.log");
  });

  it("falls back to a placeholder for empty or dot-only names", () => {
    expect(safeAttachmentFileName("")).toBe("attachment");
    expect(safeAttachmentFileName("   ")).toBe("attachment");
    expect(safeAttachmentFileName(".")).toBe("attachment");
    expect(safeAttachmentFileName("..")).toBe("attachment");
  });

  it("caps very long names", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const result = safeAttachmentFileName(long);
    expect(result.length).toBeLessThanOrEqual(120);
  });
});
