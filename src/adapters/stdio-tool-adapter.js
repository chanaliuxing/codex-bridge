import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { BaseAdapter } from "./base-adapter.js";
import { normalizeMessage } from "../core/normalize.js";

export class StdioToolAdapter extends BaseAdapter {
  constructor(name, options = {}) {
    super(name, options);
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.child = null;
    this.rl = null;
  }

  async start() {
    if (!this.command) {
      throw new Error(`stdio tool adapter ${this.name} is missing command`);
    }

    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "inherit"]
    });

    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const payload = JSON.parse(line);
        const message = normalizeMessage(payload, { from: this.name });
        this.emitMessage(message).catch((error) => {
          console.error(`[${this.name}] failed to emit stdio message`, error);
        });
      } catch (error) {
        console.error(`[${this.name}] invalid stdout JSON`, error, line);
      }
    });

    this.child.on("exit", (code, signal) => {
      console.log(`[${this.name}] exited code=${code} signal=${signal}`);
    });
  }

  async stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  async send(message) {
    if (!this.child?.stdin) {
      throw new Error(`stdio tool adapter ${this.name} is not running`);
    }
    const payload = normalizeMessage(message, {});
    this.child.stdin.write(`${JSON.stringify(payload)}
`);
  }
}
