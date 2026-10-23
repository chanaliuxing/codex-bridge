import fs from "node:fs/promises";
import path from "node:path";
import { Bridge } from "./core/bridge.js";
import { MemoryStore } from "./core/memory-store.js";
import { Router } from "./core/router.js";
import { ConsoleAdapter } from "./adapters/console-adapter.js";
import { FolderAdapter } from "./adapters/folder-adapter.js";
import { StdioToolAdapter } from "./adapters/stdio-tool-adapter.js";
import { CodexAppServerAdapter } from "./adapters/codex-app-server-adapter.js";
import { CodexExecAdapter } from "./adapters/codex-exec-adapter.js";
import { TelegramAdapter } from "./adapters/telegram-adapter.js";
import { WebServer } from "./server/web-server.js";
import { loadEnvFile } from "./core/env.js";
import { ChatgptSupervisor } from "./supervision/chatgpt-supervisor.js";

await loadEnvFile();

const configPath = path.resolve(process.cwd(), process.env.BRIDGE_CONFIG ?? "bridge.config.json");
const rawConfig = await fs.readFile(configPath, "utf8");
const config = JSON.parse(rawConfig);

const primaryTelegramTokens = (config.adapters ?? [])
  .filter((adapter) => adapter?.type === "telegram")
  .map((adapter) => String(adapter?.token ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim())
  .filter(Boolean);
const monitorToken = String(config.supervisor?.monitorTelegramBotToken ?? process.env.MONITOR_TELEGRAM_BOT_TOKEN ?? "").trim();
if (monitorToken && primaryTelegramTokens.includes(monitorToken)) {
  throw new Error("TELEGRAM_BOT_TOKEN and MONITOR_TELEGRAM_BOT_TOKEN must be different bot tokens.");
}

const lockPath = path.resolve(config.memoryDir ?? "./data", ".bridge.lock");

let lockHandle = null;
async function ensureSingleInstance() {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    lockHandle = await fs.open(lockPath, "wx");
    await lockHandle.writeFile(String(process.pid));
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  let existingPid = null;
  try {
    existingPid = Number((await fs.readFile(lockPath, "utf8")).trim());
  } catch {
    existingPid = null;
  }

  const running =
    Number.isFinite(existingPid) &&
    (() => {
      try {
        process.kill(existingPid, 0);
        return true;
      } catch {
        return false;
      }
    })();

  if (running) {
    throw new Error(`Bridge is already running with pid=${existingPid}. Stop it first, then restart.`);
  }

  await fs.rm(lockPath, { force: true });
  lockHandle = await fs.open(lockPath, "wx");
  await lockHandle.writeFile(String(process.pid));
}

async function releaseSingleInstance() {
  try {
    if (lockHandle) {
      await lockHandle.close();
      lockHandle = null;
    }
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

await ensureSingleInstance();

let store = null;
let bridge = null;
let supervisor = null;
let server = null;

function buildAdapter(adapterConfig) {
  switch (adapterConfig.type) {
    case "console":
      return new ConsoleAdapter(adapterConfig.name, adapterConfig);
    case "folder":
      return new FolderAdapter(adapterConfig.name, adapterConfig);
    case "stdioTool":
      return new StdioToolAdapter(adapterConfig.name, adapterConfig);
    case "codexAppServer":
      return new CodexAppServerAdapter(adapterConfig.name, {
        ...(config.codex ?? {}),
        ...(adapterConfig ?? {})
      });
    case "codexExec":
      return new CodexExecAdapter(adapterConfig.name, {
        ...(config.codex ?? {}),
        ...(adapterConfig ?? {})
      });
    case "telegram":
      return new TelegramAdapter(adapterConfig.name, adapterConfig);
    default:
      throw new Error(`Unknown adapter type: ${adapterConfig.type}`);
  }
}

try {
  store = new MemoryStore(config.memoryDir ?? "./data", {
    maxRecentMessages: config.maxRecentMessages ?? 40,
    summaryTrigger: config.summaryTrigger ?? 50,
    summaryKeep: config.summaryKeep ?? 18
  });
  const router = new Router(config.routes ?? []);
  bridge = new Bridge({ store, router });

  for (const adapterConfig of config.adapters ?? []) {
    bridge.registerAdapter(buildAdapter(adapterConfig));
  }

  bridge.on("message", (message) => {
    const shortText = String(message.text ?? "").replace(/\s+/g, " ").slice(0, 120);
    console.log(`[bridge] ${message.threadId} ${message.from} -> ${message.to ?? "(route)"} | ${shortText}`);
  });

  await bridge.start();

  supervisor = new ChatgptSupervisor({
    bridge,
    options: {
      enabled: config.supervisor?.enabled === true,
      threadId: config.supervisor?.threadId ?? "",
      threadPrefix: config.supervisor?.threadPrefix ?? "",
      codexAdapterName: config.supervisor?.codexAdapterName ?? "codex",
      supervisorFrom: config.supervisor?.supervisorFrom ?? "chatgpt_supervisor",
      pythonCommand: config.supervisor?.pythonCommand ?? "python3",
      toolDir: config.supervisor?.toolDir ?? "./browser-chat-vision-tool",
      toolConfig: config.supervisor?.toolConfig ?? "config.json",
      initialPromptFile: config.supervisor?.initialPromptFile ?? "./supervisor/initial_chatgpt_prompt.txt",
      eventsFile: config.supervisor?.eventsFile ?? "./data/supervisor_events.jsonl",
      stopOnCodexFailure: config.supervisor?.stopOnCodexFailure !== false,
      stopOnUsageLimit: config.supervisor?.stopOnUsageLimit !== false,
      autoReleaseOnHalt: config.supervisor?.autoReleaseOnHalt !== false,
      autoReleaseClearRuntime: config.supervisor?.autoReleaseClearRuntime === true,
      autoTakeoverSupervisorSession: config.supervisor?.autoTakeoverSupervisorSession !== false,
      monitorIncludeChatgptEvents: config.supervisor?.monitorIncludeChatgptEvents !== false,
      promptPrefix: config.supervisor?.promptPrefix ?? "",
      maxAutoTurnsPerThread: config.supervisor?.maxAutoTurnsPerThread ?? 30,
      monitorTelegramBotToken:
        config.supervisor?.monitorTelegramBotToken ?? process.env.MONITOR_TELEGRAM_BOT_TOKEN ?? "",
      monitorTelegramChatId:
        config.supervisor?.monitorTelegramChatId ??
        process.env.MONITOR_TELEGRAM_CHAT_ID ??
        process.env.TELEGRAM_CHAT_ID ??
        "",
      monitorThreadId: config.supervisor?.monitorThreadId ?? ""
    }
  });
  await supervisor.start();

  if (config.server?.enabled) {
    server = new WebServer({
      bridge,
      store,
      host: config.server.host ?? "127.0.0.1",
      port: config.server.port ?? 3088,
      publicDir: path.resolve(process.cwd(), "src", "public")
    });
    await server.start();
  }

  console.log("Codex Bridge Complete is running.");
  if (server) {
    console.log(`Web UI: http://${config.server.host ?? "127.0.0.1"}:${config.server.port ?? 3088}`);
  }
  console.log(`Queue local messages with: npm run send -- --to stdio_upper --thread demo --text "hello"`);
} catch (error) {
  if (server) {
    await server.stop().catch(() => {});
  }
  if (supervisor) {
    await supervisor.stop().catch(() => {});
  }
  if (bridge) {
    await bridge.stop().catch(() => {});
  }
  await releaseSingleInstance();
  throw error;
}

const shutdown = async () => {
  console.log(`\nStopping bridge...`);
  if (server) {
    await server.stop();
  }
  if (supervisor) {
    await supervisor.stop();
  }
  if (bridge) {
    await bridge.stop();
  }
  await releaseSingleInstance();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
