import type { AccountInput } from "./types.js";

function stripBom(value: string) {
  return value.replace(/^\uFEFF/, "");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function isHeader(cells: string[]) {
  const normalized = cells.map((cell) => cell.trim().toLowerCase());
  return normalized.includes("email") && normalized.some((cell) => cell === "client_id" || cell === "clientid");
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeUuid(value: string) {
  return UUID_PATTERN.test(value.trim());
}

function parseDashedLine(cells: string[]): AccountInput {
  const secondLooksClientId = looksLikeUuid(cells[1] || "");
  const thirdLooksClientId = looksLikeUuid(cells[2] || "");

  if (cells.length >= 4 && thirdLooksClientId && !secondLooksClientId) {
    return {
      email: cells[0] || "",
      clientId: cells[2] || "",
      refreshToken: cells[3] || "",
      remark: cells[4] || "",
      group: cells[5] || ""
    };
  }

  return {
    email: cells[0] || "",
    clientId: cells[1] || "",
    refreshToken: cells[2] || "",
    remark: cells[3] || "",
    group: cells[4] || ""
  };
}

export function parseAccountImport(text: string): AccountInput[] {
  const lines = stripBom(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const firstCells = parseCsvLine(lines[0]);
  const hasHeader = isHeader(firstCells);

  if (hasHeader) {
    const header = firstCells.map((cell) => cell.trim().toLowerCase());
    const indexOf = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
    const emailIndex = indexOf("email", "mail", "account");
    const clientIdIndex = indexOf("client_id", "clientid", "client id");
    const refreshTokenIndex = indexOf("refresh_token", "refreshtoken", "refresh token", "rt");
    const remarkIndex = indexOf("remark", "note", "备注");
    const groupIndex = indexOf("group", "分组");

    return lines.slice(1).map((line) => {
      const cells = parseCsvLine(line);
      return {
        email: cells[emailIndex] || "",
        clientId: cells[clientIdIndex] || "",
        refreshToken: cells[refreshTokenIndex] || "",
        remark: remarkIndex >= 0 ? cells[remarkIndex] || "" : "",
        group: groupIndex >= 0 ? cells[groupIndex] || "" : ""
      };
    });
  }

  return lines.map((line) => {
    if (line.includes("----")) {
      return parseDashedLine(line.split("----").map((cell) => cell.trim()));
    }

    const cells = parseCsvLine(line);

    return {
      email: cells[0] || "",
      clientId: cells[1] || "",
      refreshToken: cells[2] || "",
      remark: cells[3] || "",
      group: cells[4] || ""
    };
  });
}
