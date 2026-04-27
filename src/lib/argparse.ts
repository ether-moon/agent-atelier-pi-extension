import fs from "node:fs";
import path from "node:path";

export interface ParsedArgs {
  verb: string;
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
}

export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of input.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) out.push(current);
  return out;
}

export function parseArgs(input: string): ParsedArgs {
  const tokens = splitArgs(input);
  const verb = tokens.shift() ?? "";
  const positionals: string[] = [];
  const options: ParsedArgs["options"] = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw : raw.slice(0, eq);
    let value: string | boolean = eq === -1 ? true : raw.slice(eq + 1);
    if (eq === -1 && tokens[i + 1] && !tokens[i + 1].startsWith("--")) {
      value = tokens[++i];
    }

    const existing = options[key];
    if (existing === undefined) {
      options[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      options[key] = [String(existing), String(value)];
    }
  }

  return { verb, positionals, options };
}

export function optionString(options: ParsedArgs["options"], key: string): string | undefined {
  const value = options[key];
  if (Array.isArray(value)) return value[value.length - 1];
  if (typeof value === "string") return value;
  return undefined;
}

export function optionStrings(options: ParsedArgs["options"], key: string): string[] {
  const value = options[key];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return [value];
  return [];
}

export function optionBool(options: ParsedArgs["options"], key: string): boolean {
  return options[key] === true || options[key] === "true";
}

export function requireRequestId(options: ParsedArgs["options"]): string {
  const requestId = optionString(options, "request-id");
  if (!requestId) throw new Error("--request-id is required");
  return requestId;
}

export function parseJsonOrFields(
  positionals: string[],
  options: ParsedArgs["options"],
  cwd: string
): Record<string, unknown> {
  const json = optionString(options, "json");
  if (json) return JSON.parse(json) as Record<string, unknown>;

  const input = optionString(options, "input");
  if (input) {
    const fullPath = path.resolve(cwd, input);
    return JSON.parse(fs.readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
  }

  const joined = positionals.join(" ").trim();
  if (joined.startsWith("{")) return JSON.parse(joined) as Record<string, unknown>;

  const fields: Record<string, unknown> = {};
  for (const token of positionals) {
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    fields[token.slice(0, eq)] = parseScalar(token.slice(eq + 1));
  }
  return fields;
}

function parseScalar(value: string): unknown {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  if (value.includes(",")) return value.split(",").map((part) => part.trim()).filter(Boolean);
  return value;
}
