import { MemoryStore } from "../core/memory-store.js";

const store = new MemoryStore("./data");
const threads = await store.listThreads();
for (const threadId of threads) {
  console.log(threadId);
}
