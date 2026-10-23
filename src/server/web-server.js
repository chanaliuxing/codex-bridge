import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { normalizeMessage } from "../core/normalize.js";

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function text(res, status, payload, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(payload);
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export class WebServer {
  constructor({ bridge, store, host = "127.0.0.1", port = 3088, publicDir }) {
    this.bridge = bridge;
    this.store = store;
    this.host = host;
    this.port = port;
    this.publicDir = publicDir;
    this.server = null;
    this.clients = new Set();
    this.boundOnMessage = (message) => {
      const payload = `data: ${JSON.stringify(message)}

`;
      for (const res of this.clients) {
        res.write(payload);
      }
    };
  }

  async start() {
    this.bridge.on("message", this.boundOnMessage);
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        console.error("[web] request failed", error);
        json(res, 500, { error: error.message });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
  }

  async stop() {
    this.bridge.off("message", this.boundOnMessage);
    for (const res of this.clients) {
      res.end();
    }
    this.clients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? `${this.host}:${this.port}`}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/adapters") {
      return json(res, 200, { adapters: this.bridge.listAdapters() });
    }

    if (req.method === "GET" && url.pathname === "/api/threads") {
      const threads = await this.store.listThreads();
      return json(res, 200, { threads });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/thread/")) {
      const threadId = decodeURIComponent(url.pathname.slice("/api/thread/".length));
      const bundle = await this.store.getThreadBundle(threadId);
      return json(res, 200, bundle);
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      const body = await readRequestBody(req);
      const payload = normalizeMessage(body, { from: body.from ?? "user", role: body.role ?? "user" });
      await this.bridge.send(payload);
      return json(res, 202, { ok: true, messageId: payload.id });
    }

    if (req.method === "POST" && url.pathname === "/api/codex/bind-thread") {
      const body = await readRequestBody(req);
      const adapterName = String(body.adapter ?? "codex").trim();
      const bridgeThreadId = String(body.bridgeThreadId ?? body.threadId ?? "default").trim();
      const codexThreadId = String(body.codexThreadId ?? body.sessionId ?? "").trim();

      if (!codexThreadId) {
        return json(res, 400, {
          error: "codexThreadId (or sessionId) is required"
        });
      }

      if (!bridgeThreadId) {
        return json(res, 400, { error: "bridgeThreadId (or threadId) is required" });
      }

      const adapter = this.bridge.getAdapter(adapterName);
      if (!adapter) {
        return json(res, 404, { error: `adapter not found: ${adapterName}` });
      }

      let codexCwd = null;
      if (typeof adapter.call === "function") {
        try {
          const read = await adapter.call("thread/read", {
            threadId: codexThreadId,
            includeItems: false
          });
          codexCwd = String(read?.thread?.cwd ?? read?.cwd ?? "").trim() || null;
        } catch {
          codexCwd = null;
        }
      }

      await this.store.setAdapterState(bridgeThreadId, adapterName, { codexThreadId, codexCwd });
      return json(res, 200, {
        ok: true,
        adapter: adapterName,
        bridgeThreadId,
        codexThreadId,
        codexCwd
      });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      res.write(`event: hello
data: ${JSON.stringify({ ok: true })}

`);
      this.clients.add(res);
      req.on("close", () => {
        this.clients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) {
      const relativePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
      const filePath = path.join(this.publicDir, relativePath);
      try {
        const content = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const type =
          ext === ".html"
            ? "text/html; charset=utf-8"
            : ext === ".js"
              ? "text/javascript; charset=utf-8"
              : ext === ".css"
                ? "text/css; charset=utf-8"
                : "application/octet-stream";
        return text(res, 200, content, type);
      } catch {
        return text(res, 404, "Not found");
      }
    }

    return json(res, 404, { error: "Not found" });
  }
}
