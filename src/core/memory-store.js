import path from "node:path";
import { ensureDir, listDirs, readJson, writeJson } from "./file-utils.js";

function cleanSnippet(value, max = 140) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildCompactSummary(messages = [], previous = null) {
  const participants = {};
  const items = [];
  for (const message of messages) {
    participants[message.from] = (participants[message.from] ?? 0) + 1;
    items.push(`${message.from}: ${cleanSnippet(message.text)}`);
  }

  const priorCount = previous?.compactedMessageCount ?? 0;
  const priorTurns = previous?.summaryLines ?? [];
  const nextLines = [...priorTurns, ...items].slice(-16);

  return {
    updatedAt: new Date().toISOString(),
    compactedMessageCount: priorCount + messages.length,
    participants: {
      ...(previous?.participants ?? {}),
      ...Object.fromEntries(
        Object.entries(participants).map(([key, count]) => [
          key,
          (previous?.participants?.[key] ?? 0) + count
        ])
      )
    },
    summaryLines: nextLines,
    summaryText: nextLines.join("\n")
  };
}

export class MemoryStore {
  constructor(baseDir, options = {}) {
    this.baseDir = path.resolve(baseDir);
    this.maxRecentMessages = options.maxRecentMessages ?? 40;
    this.summaryTrigger = options.summaryTrigger ?? Math.max(50, this.maxRecentMessages + 10);
    this.summaryKeep = options.summaryKeep ?? Math.min(20, this.maxRecentMessages);
  }

  threadDir(threadId) {
    return path.join(this.baseDir, "threads", threadId);
  }

  recentPath(threadId) {
    return path.join(this.threadDir(threadId), "recent.json");
  }

  summaryPath(threadId) {
    return path.join(this.threadDir(threadId), "summary.json");
  }

  statePath(threadId) {
    return path.join(this.threadDir(threadId), "state.json");
  }

  async init() {
    await ensureDir(path.join(this.baseDir, "threads"));
  }

  async appendRecent(threadId, message) {
    const list = await readJson(this.recentPath(threadId), []);
    list.push(message);
    let next = list;

    if (next.length > this.summaryTrigger) {
      const compactCount = Math.max(1, next.length - this.summaryKeep);
      const compacted = next.slice(0, compactCount);
      const kept = next.slice(compactCount);
      const previousSummary = await readJson(this.summaryPath(threadId), null);
      const nextSummary = buildCompactSummary(compacted, previousSummary);
      await writeJson(this.summaryPath(threadId), nextSummary);
      next = kept;
    } else if (next.length > this.maxRecentMessages) {
      next = next.slice(-this.maxRecentMessages);
    }

    await writeJson(this.recentPath(threadId), next);
    return next;
  }

  async getRecent(threadId) {
    return readJson(this.recentPath(threadId), []);
  }

  async getSummary(threadId) {
    return readJson(this.summaryPath(threadId), {
      updatedAt: null,
      compactedMessageCount: 0,
      participants: {},
      summaryLines: [],
      summaryText: ""
    });
  }

  async getState(threadId) {
    return readJson(this.statePath(threadId), { adapterStates: {} });
  }

  async setState(threadId, nextState) {
    await writeJson(this.statePath(threadId), nextState);
  }

  async getAdapterState(threadId, adapterName) {
    const state = await this.getState(threadId);
    return state.adapterStates?.[adapterName] ?? {};
  }

  async setAdapterState(threadId, adapterName, partialState) {
    const state = await this.getState(threadId);
    state.adapterStates ??= {};
    state.adapterStates[adapterName] = {
      ...(state.adapterStates[adapterName] ?? {}),
      ...(partialState ?? {})
    };
    await this.setState(threadId, state);
    return state.adapterStates[adapterName];
  }

  async listThreads() {
    return listDirs(path.join(this.baseDir, "threads"));
  }

  async getThreadBundle(threadId) {
    const [recent, summary, state] = await Promise.all([
      this.getRecent(threadId),
      this.getSummary(threadId),
      this.getState(threadId)
    ]);

    return { threadId, recent, summary, state };
  }
}
