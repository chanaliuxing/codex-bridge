import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export function createReply(message, fields = {}) {
  return {
    threadId: fields.threadId ?? message.threadId,
    from: fields.from ?? message.to ?? "tool",
    to: fields.to ?? message.meta?.replyTo ?? "console",
    role: fields.role ?? "assistant",
    type: fields.type ?? "text",
    text: String(fields.text ?? ""),
    meta: {
      sourceMessageId: message.id,
      ...(fields.meta ?? {})
    }
  };
}

export function runStdioTool(toolName, handler) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    const result = await handler(message);
    if (!result) {
      return;
    }

    const reply = createReply(message, { from: toolName, ...result });
    process.stdout.write(`${JSON.stringify(reply)}
`);
  });
}

export async function runFolderTool({ toolName, inboxDir, outboxDir, handler, pollIntervalMs = 1000 }) {
  const processedDir = path.join(inboxDir, ".processed");
  await fs.mkdir(inboxDir, { recursive: true });
  await fs.mkdir(outboxDir, { recursive: true });
  await fs.mkdir(processedDir, { recursive: true });

  async function poll() {
    const entries = await fs.readdir(inboxDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort();

    for (const fileName of files) {
      const fullPath = path.join(inboxDir, fileName);
      let message;
      try {
        message = JSON.parse(await fs.readFile(fullPath, "utf8"));
      } catch {
        await fs.rename(fullPath, path.join(processedDir, `${fileName}.bad`));
        continue;
      }

      const result = await handler(message);
      if (result) {
        const reply = createReply(message, { from: toolName, ...result });
        const outFile = path.join(outboxDir, `${Date.now()}_${Math.random().toString(16).slice(2)}.json`);
        await fs.writeFile(outFile, JSON.stringify(reply, null, 2), "utf8");
      }

      await fs.rename(fullPath, path.join(processedDir, `${Date.now()}_${fileName}`));
    }
  }

  console.log(`${toolName} folder tool is running`);
  setInterval(() => {
    poll().catch((error) => console.error(`${toolName} poll failed`, error));
  }, pollIntervalMs);
}
