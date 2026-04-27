export interface DestructiveCheck {
  block: boolean;
  reason?: string;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\//i, reason: "refuses rm -rf /" },
  { pattern: /\bgit\s+push\s+--force\b/i, reason: "refuses git push --force" },
  { pattern: /\bgit\s+push\s+-f\b/i, reason: "refuses git push -f" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "refuses git reset --hard" },
  { pattern: /\bgit\s+clean\s+-fd\b/i, reason: "refuses git clean -fd" },
  { pattern: /\bDROP\s+TABLE\b/i, reason: "refuses DROP TABLE" },
  { pattern: /\bDROP\s+DATABASE\b/i, reason: "refuses DROP DATABASE" },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*;/i, reason: "refuses broad DELETE FROM statement" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, reason: "refuses TRUNCATE TABLE" },
  { pattern: /\bmigrate\b.*--destructive/i, reason: "refuses destructive migration" },
  { pattern: /\bmigrate\b.*down\s+all/i, reason: "refuses migrate down all" },
  { pattern: /\bchmod\s+777\b/i, reason: "refuses chmod 777" },
  { pattern: /\b(curl|wget)\b.*\|\s*(sh|bash)\b/i, reason: "refuses curl/wget piped to shell" }
];

export function isDestructive(command: string): DestructiveCheck {
  for (const entry of DESTRUCTIVE_PATTERNS) {
    if (entry.pattern.test(command)) return { block: true, reason: entry.reason };
  }
  return { block: false };
}
