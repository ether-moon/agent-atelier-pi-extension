/**
 * Adapted from badlogic/pi-mono packages/coding-agent/examples/extensions/subagent/agents.ts.
 * Loads bundled agent-atelier agent definitions instead of user/project agents.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { assetPath, extensionRoot } from "../lib/paths.js";
import { normalizeModelName, normalizeToolList } from "../lib/tools.js";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "bundled";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  agentsDir: string;
}

export function discoverAgents(): AgentDiscoveryResult {
  const agentsDir = assetPath("agents");
  return { agents: loadAgentsFromDir(agentsDir), agentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
  if (agents.length === 0) return { text: "none", remaining: 0 };
  const listed = agents.slice(0, maxItems);
  return {
    text: listed.map((agent) => `${agent.name}: ${agent.description}`).join("; "),
    remaining: agents.length - listed.length
  };
}

function loadAgentsFromDir(dir: string): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .flatMap((entry) => {
      const filePath = path.join(dir, entry.name);
      const content = fs.readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
      if (!frontmatter.name || !frontmatter.description) return [];
      const tools = frontmatter.tools
        ?.split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      return [
        {
          name: frontmatter.name,
          description: frontmatter.description,
          tools: normalizeToolList(tools),
          model: normalizeModelName(frontmatter.model),
          systemPrompt: resolvePromptBody(body),
          source: "bundled" as const,
          filePath
        }
      ];
    });
}

function resolvePromptBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("@")) return body;
  const [includeLine, ...rest] = trimmed.split("\n");
  const includePath = includeLine.slice(1).trim();
  const fullPath = path.isAbsolute(includePath) ? includePath : path.join(extensionRoot(), includePath);
  const included = fs.readFileSync(fullPath, "utf-8");
  return rest.length ? `${included.trimEnd()}\n\n${rest.join("\n").trimStart()}` : included;
}
