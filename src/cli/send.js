import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./arg-utils.js";

function ensureText(value) {
  return String(value ?? "").trim();
}

function buildThreadIdFromSession(sessionId) {
  const raw = ensureText(sessionId);
  if (!raw) {
    return "default";
  }
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `sup_session_${safe}`;
}

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(raw)) {
    return false;
  }
  return defaultValue;
}

function buildUniqueThreadIdFromSession(sessionId) {
  return `${buildThreadIdFromSession(sessionId)}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

const args = parseArgs(process.argv.slice(2));
const inboxDir = path.resolve(process.cwd(), "data", "bridge_inbox");
await fs.mkdir(inboxDir, { recursive: true });

const sessionId = ensureText(args.session ?? args["session-id"]);
const explicitThreadId = ensureText(args.thread);
const reuseSessionThread = parseBool(args["reuse-session-thread"], false);
const requestedModel = ensureText(args.model);
const requestedEffort = ensureText(args.effort ?? args["reasoning-effort"]);
const stopAfterCodexFinals = Number(args["stop-after-codex-finals"] ?? args["max-codex-finals"] ?? 0);
const threadId =
  explicitThreadId ||
  (sessionId
    ? reuseSessionThread
      ? buildThreadIdFromSession(sessionId)
      : buildUniqueThreadIdFromSession(sessionId)
    : "default");

const payload = {
  threadId,
  from: args.from ?? "user",
  to: args.to ?? null,
  role: args.role ?? "user",
  type: "text",
  text: args.text ?? "",
  tags: args.tags ? String(args.tags).split(",").map((item) => item.trim()).filter(Boolean) : [],
  hops: 0,
  maxHops: Number(args["max-hops"] ?? 8),
  meta: {}
};

if (sessionId) {
  const runtimeModel = requestedModel || "gpt-5.3-codex";
  const runtimeEffort = requestedEffort || "medium";
  payload.meta.codexThreadId = sessionId;
  payload.meta.sessionId = sessionId;
  payload.meta.sessionBind = true;
  payload.meta.sessionThreadReuse = reuseSessionThread;
  payload.meta.runtimeModel = runtimeModel;
  payload.meta.runtimeEffort = runtimeEffort;
}

if (args["reply-to"]) {
  payload.meta.replyTo = args["reply-to"];
}

if (Number.isInteger(stopAfterCodexFinals) && stopAfterCodexFinals > 0) {
  payload.meta.stopAfterCodexFinals = stopAfterCodexFinals;
}

if (args.meta) {
  try {
    Object.assign(payload.meta, JSON.parse(args.meta));
  } catch {
    console.error("Invalid --meta JSON");
    process.exit(1);
  }
}

const fileName = `${Date.now()}_${Math.random().toString(16).slice(2)}.json`;
const fullPath = path.join(inboxDir, fileName);
await fs.writeFile(fullPath, JSON.stringify(payload, null, 2), "utf8");
console.log(`Queued message file: ${fullPath}`);
console.log(`Resolved threadId: ${payload.threadId}`);
