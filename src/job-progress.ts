import type { RefreshProgressEvent } from "./types";

export function shouldDisplayBulkRefreshProgress(event: Pick<RefreshProgressEvent, "kind">): boolean {
  return event.kind === "refresh";
}
