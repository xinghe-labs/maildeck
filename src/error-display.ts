/** 错误文案拆成「一行主文案 + 可折叠的原始报错」。 */
export interface ErrorDisplay {
  /** 一行可读的主文案，用于横幅/面板标题区。 */
  title: string;
  /** 原始报错（Trace ID、Correlation ID、多 provider 尝试等），只应折叠展示。 */
  detail: string;
}

const RAW_MARKER = "原始错误：";
const LONG_MESSAGE_THRESHOLD = 120;

/**
 * 把底层错误拆成「人话」和「原始报错」两部分。
 *
 * 邮箱侧的错误消息形如
 * `Token 无效或已过期，请重新获取 refresh_token。原始错误：live(400): ... Trace ID: ...`，
 * 直接整段铺在界面上用户读不懂，也不该把 Trace ID 当成主要信息。
 */
export function splitErrorMessage(raw: string): ErrorDisplay {
  const text = (raw ?? "").trim();
  if (!text) {
    return { title: "", detail: "" };
  }

  const markerIndex = text.indexOf(RAW_MARKER);
  if (markerIndex >= 0) {
    const title = text.slice(0, markerIndex).trim().replace(/[，,。;；]$/u, "");
    const detail = text.slice(markerIndex + RAW_MARKER.length).trim();
    return { title: title || "操作失败", detail };
  }

  if (text.length <= LONG_MESSAGE_THRESHOLD) {
    return { title: text, detail: "" };
  }

  const sentenceEnd = text.search(/[。！？\n]/u);
  if (sentenceEnd > 0 && sentenceEnd < LONG_MESSAGE_THRESHOLD) {
    return {
      title: text.slice(0, sentenceEnd + 1).trim(),
      detail: text.slice(sentenceEnd + 1).trim()
    };
  }

  return { title: `${text.slice(0, LONG_MESSAGE_THRESHOLD)}…`, detail: text };
}
