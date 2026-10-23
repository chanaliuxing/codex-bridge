import fs from "node:fs/promises";
import path from "node:path";
import { BaseAdapter } from "./base-adapter.js";
import { normalizeMessage } from "../core/normalize.js";
import { makeId } from "../core/ids.js";
import { ensureDir } from "../core/file-utils.js";

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

export class FolderAdapter extends BaseAdapter {
  constructor(name, options = {}) {
    super(name, options);
    this.inDir = path.resolve(options.inDir ?? ".");
    this.outDir = options.outDir ? path.resolve(options.outDir) : null;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.timer = null;
    this.processedDir = path.join(this.inDir, ".processed");
    this.isPolling = false;
  }

  async start() {
    await ensureDir(this.inDir);
    await ensureDir(this.processedDir);
    if (this.outDir) {
      await ensureDir(this.outDir);
    }

    this.timer = setInterval(() => {
      this.poll().catch((error) => {
        console.error(`[${this.name}] poll failed`, error);
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll() {
    if (this.isPolling) {
      return;
    }
    this.isPolling = true;
    try {
    const entries = await fs.readdir(this.inDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();

    for (const fileName of files) {
      const fullPath = path.join(this.inDir, fileName);
      let payload;
      try {
        payload = await readJson(fullPath);
      } catch (error) {
        console.error(`[${this.name}] bad JSON file: ${fileName}`, error);
        await fs.rename(fullPath, path.join(this.processedDir, `${fileName}.bad`));
        continue;
      }

      const message = normalizeMessage(payload, { from: this.name });
      await this.emitMessage(message);
      await fs.rename(fullPath, path.join(this.processedDir, `${Date.now()}_${fileName}`));
    }
    } finally {
      this.isPolling = false;
    }
  }

  async send(message) {
    if (!this.outDir) {
      throw new Error(`Folder adapter ${this.name} has no outDir configured`);
    }

    const payload = normalizeMessage(message, {});
    const fileName = `${Date.now()}_${makeId("msg")}.json`;
    await fs.writeFile(path.join(this.outDir, fileName), JSON.stringify(payload, null, 2), "utf8");
  }
}
