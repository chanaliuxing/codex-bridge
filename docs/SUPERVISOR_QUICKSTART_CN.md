# Supervisor 使用说明（简版）

本文只覆盖你最关心的 4 件事：

1. session id 在哪里改  
2. pwd（cwd）如何自动正确  
3. 发给 ChatGPT 的前置 prompt 在哪里改  
4. 怎么启动/停止 supervisor（命令）

---

## 1) session id 在哪里改

推荐通过接口绑定（不手改代码）：

```bash
curl -sS -X POST http://127.0.0.1:43188/api/codex/bind-thread \
  -H "Content-Type: application/json" \
  -d '{
    "adapter": "codex",
    "bridgeThreadId": "sup_demo",
    "sessionId": "019d4790-1c2e-7cf3-aef3-af5396a127f7"
  }'
```

说明：
- `bridgeThreadId`：supervisor 监听的 bridge 线程（建议以 `sup_` 前缀命名）
- `sessionId`：你在 Codex App 里的 session id

---

## 2) pwd（cwd）自动对齐，不手工干预

现在 `bind-thread` 会自动调用 `thread/read` 读取该 session 的 `cwd`，并写入 bridge state。

效果：
- 绑定 session 后，后续给 Codex 的 `turn/start` 会自动用该 session 的 `cwd`
- 不需要你手工改 `pwd`

如果读取失败，会回退到 bridge 默认 `cwd`（`bridge.config.json` 里的 `codex.cwd`）。

---

## 3) 发给 ChatGPT 的前置 prompt 在哪里改

优先改这里（推荐）：
- `bridge.config.json` -> `supervisor.promptPrefix`

也可以用环境变量：
- `.env` -> `SUPERVISOR_PROMPT_PREFIX`

示例（`bridge.config.json`）：

```json
"supervisor": {
  "enabled": true,
  "threadPrefix": "sup_",
  "promptPrefix": "你是项目监督者，请给出下一步可直接执行的最小闭环指令。"
}
```

---

## 4) 怎么启动 / 停止

### 启动（含 supervisor）

```bash
cd .
npm start
```

只要 `bridge.config.json` 里：

```json
"supervisor": { "enabled": true }
```

就会自动启用 supervisor。

### 停止

方式 1（前台运行时推荐）：
- 在启动终端里按 `Ctrl+C`

方式 2（后台残留时）：

```bash
pkill -f "node src/index.js"
```

---

## 监控 Telegram（第二个 bot）

在 `.env` 设置：

- `MONITOR_TELEGRAM_BOT_TOKEN=...`
- `MONITOR_TELEGRAM_CHAT_ID=...`（可不填，默认复用 `TELEGRAM_CHAT_ID`）

监控 bot 只做监控，唯一命令：
- `/stop`：全局停止 supervisor 自动注入

推送顺序与可靠性：
- 严格串行（带 `seq`）
- 自动重试
- 失败写入 `data/monitor_undelivered.jsonl`
- 下次启动自动重放未送达消息
