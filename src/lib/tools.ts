export const CLAUDE_TO_PI_TOOL: Record<string, string | null> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "find",
  Grep: "grep",
  LSP: null,
  Agent: "aa-subagent",
  SendMessage: null,
  TaskCreate: null,
  TaskUpdate: null,
  TaskGet: null,
  TaskList: null,
  EnterWorktree: null,
  ExitWorktree: null
};

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001"
};

export function normalizeToolName(name: string): string | null {
  const trimmed = name.trim();
  if (Object.hasOwn(CLAUDE_TO_PI_TOOL, trimmed)) return CLAUDE_TO_PI_TOOL[trimmed];
  return trimmed;
}

export function normalizeToolList(tools: string[] | undefined): string[] | undefined {
  if (!tools) return undefined;
  const normalized = tools.map(normalizeToolName).filter((tool): tool is string => Boolean(tool));
  return Array.from(new Set(normalized));
}

export function normalizeModelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return MODEL_ALIASES[model] ?? model;
}
