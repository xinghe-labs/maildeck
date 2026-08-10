import type { AccountView } from "./types.js";

export const ACCOUNT_VIEW_COLUMNS = `
  id,
  email,
  client_id AS "clientId",
  remark,
  group_name AS "group",
  status,
  last_checked_at AS "lastCheckedAt",
  last_error AS "lastError",
  last_refreshed_at AS "lastRefreshedAt",
  COALESCE(last_inbox_count, 0) AS "lastInboxCount",
  last_mail_at AS "lastMailAt",
  last_mail_cursor AS "lastMailCursor",
  inbox_folder_id AS "inboxFolderId",
  graph_delta_link AS "graphDeltaLink",
  refresh_cooldown_until AS "refreshCooldownUntil",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export type AccountViewRow = AccountView;
