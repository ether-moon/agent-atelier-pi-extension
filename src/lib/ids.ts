import type { CandidateSet } from "./types.js";

export function nextCandidateId(existing: CandidateSet[]): string {
  const max = existing.reduce((highest, candidate) => {
    const match = /^CS-(\d+)$/.exec(candidate.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `CS-${String(max + 1).padStart(3, "0")}`;
}
