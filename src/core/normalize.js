import { makeId } from "./ids.js";

export function normalizeMessage(input = {}, fallback = {}) {
  const now = Math.floor(Date.now() / 1000);
  const tags = Array.isArray(input.tags)
    ? input.tags
    : Array.isArray(fallback.tags)
      ? fallback.tags
      : [];

  return {
    id: input.id ?? makeId("msg"),
    threadId: String(input.threadId ?? fallback.threadId ?? "default"),
    from: String(input.from ?? fallback.from ?? "unknown"),
    to: input.to ?? fallback.to ?? null,
    role: String(input.role ?? fallback.role ?? "assistant"),
    type: String(input.type ?? fallback.type ?? "text"),
    text: String(input.text ?? ""),
    ts: Number.isFinite(input.ts) ? input.ts : now,
    hops: Number.isFinite(input.hops) ? input.hops : 0,
    maxHops: Number.isFinite(input.maxHops) ? input.maxHops : 8,
    tags,
    meta: {
      ...(fallback.meta ?? {}),
      ...(input.meta ?? {})
    }
  };
}
