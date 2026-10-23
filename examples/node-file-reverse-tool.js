import path from "node:path";
import { runFolderTool } from "../sdk/node/bridge-tool-sdk.js";

const baseDir = path.resolve(process.cwd(), "mailboxes", "file_reverse");
await runFolderTool({
  toolName: "file_reverse",
  inboxDir: path.join(baseDir, "inbox"),
  outboxDir: path.join(baseDir, "outbox"),
  pollIntervalMs: 600,
  handler: async (message) => ({
    text: String(message.text ?? "").split("").reverse().join("")
  })
});
