export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
