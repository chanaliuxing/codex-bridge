import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { BaseAdapter } from "./base-adapter.js";

export class CodexExecAdapter extends BaseAdapter {
  constructor(name, options = {}) {
    super(name, options);
    this.command = options.command ?? "codex";
    this.baseArgs = options.args ?? ["exec", "--json"];
    this.cwd = path.resolve(options.cwd ?? process.cwd());
  }

  async send(message) {
    const args = [...this.baseArgs, message.text];
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "inherit"]
    });

    const rl = readline.createInterface({ input: child.stdout });
    let finalText = "";

    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line);
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalText = event.item.text ?? finalText;
        }
      } catch (error) {
        console.error(`[${this.name}] invalid Codex exec JSON`, error);
      }
    });

    await new Promise((resolve, reject) => {
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Codex exec exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });

    if (finalText) {
      await this.emitMessage({
        threadId: message.threadId,
        from: this.name,
        to: message.meta?.replyTo ?? null,
        role: "assistant",
        text: finalText,
        meta: {
          source: "codex-exec"
        }
      });
    }
  }
}
