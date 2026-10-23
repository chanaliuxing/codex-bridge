import { parseArgs } from "./arg-utils.js";
import { MemoryStore } from "../core/memory-store.js";

const args = parseArgs(process.argv.slice(2));
const threadId = args.thread ?? "default";
const store = new MemoryStore("./data");
const bundle = await store.getThreadBundle(threadId);

console.log(`Thread: ${threadId}`);
console.log("");
console.log("Summary:");
console.log(bundle.summary.summaryText || "(empty)");
console.log(`\nRecent:`);
for (const message of bundle.recent) {
  console.log("");
  console.log(`[${message.from}] -> ${message.to ?? "-"}`);
  console.log(message.text);
}
