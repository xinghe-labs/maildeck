const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/iu;
const MAX_FILE_NAME_LENGTH = 120;

/**
 * 把 Graph 返回的附件名转成可以安全交给保存对话框的默认文件名。
 *
 * 附件名来自外部邮件，可能带路径分隔符、控制字符或 Windows 保留设备名：
 * 直接当 defaultPath 用会写到意料之外的位置，或被系统拒绝。这里只做文件名
 * 规整，最终落盘位置仍然由用户在保存对话框里决定。
 */
export function safeAttachmentFileName(name: string): string {
  const trimmed = (name || "").trim();
  const base = trimmed.split(/[\\/]/u).pop() || "";
  const cleaned = base
    // 控制字符与 Windows 文件名禁用字符
    // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, "_")
    // 结尾的点和空格在 Windows 上会被静默去掉，这里显式处理避免同名冲突
    .replace(/[. ]+$/u, "")
    .slice(0, MAX_FILE_NAME_LENGTH)
    .trim();

  if (!cleaned || cleaned === "." || cleaned === "..") {
    return "attachment";
  }

  if (WINDOWS_RESERVED_NAMES.test(cleaned)) {
    return `_${cleaned}`;
  }

  return cleaned;
}
