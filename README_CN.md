# Codex Bridge Complete

[English](README.md) | [简体中文](README_CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg?logo=node.js)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-14%20passed-success.svg)]()
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0%20external-brightgreen.svg)]()

---

> [!IMPORTANT]
> **版本与商业化说明**
>
> - **开源基线版本**：本仓库公开的代码为约 **12 个月前的基线版本（Baseline Release from ~12 months ago）**，主要供开源社区进行技术研究、架构参考与交流学习。
> - **商业/企业专有版**：具备更高稳定性、工业级高可用与持续演化的**最新版本已作为商业化/企业版交付**。如需了解最新企业版架构或洽谈商业合作，请联系项目维护团队。

---

> **零外部数据库、零消息队列依赖的本地轻量级 Agent 进程消息总线与桥接器，无缝连接 Codex CLI、外部工具、Telegram 与 Web UI。**

### 快速启动：
```bash
npm start
```

### 核心功能：

- 通过 `codex app-server` 与 Codex CLI 进行消息双向收发
- 通过标准化极简协议连接任何外部工具（Folder 工具或 STDIO 工具）
- 各工具无需互相感知，由统一的桥接总线进行消息路由
- 仅保留近期上下文及精简的本地压缩摘要
- 提供开箱即用的轻量 Web UI 交互面板
- 配备极简的 Node.js 与 Python SDK，任何外部新工具 5 分钟即可完成接入

## 架构理念

**保持极简。**

无需外部数据库（如 PostgreSQL/Redis）。
无需复杂消息队列（如 Kafka/RabbitMQ）。
无需臃肿的重型 Agent 框架。

核心设计基于：
- 原生 Node.js 标准库
- 本地文件状态持久化
- 标准化单一消息格式（Message Envelope）
- 单进程中央总线 + 插件化 Adapter

## 消息协议标准

所有 Adapter 之间传递的标准消息体结构：

```json
{
  "id": "msg_123",
  "threadId": "demo",
  "from": "user",
  "to": "codex",
  "role": "user",
  "type": "text",
  "text": "hello",
  "ts": 1770000000,
  "hops": 0,
  "maxHops": 8,
  "tags": [],
  "meta": {
    "replyTo": "console"
  }
}
```

## 测试运行

```bash
bash scripts/test.sh
# 14 passed in 122ms
```

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
