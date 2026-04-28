import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export function postText(pi: ExtensionAPI, content: string, details?: Record<string, unknown>): void {
  pi.sendMessage({
    customType: "agent-atelier",
    content,
    display: true,
    details
  });
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
