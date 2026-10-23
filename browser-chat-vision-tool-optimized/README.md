# Browser Chat Vision Tool - Optimized

这是一个针对浏览器聊天页做 **OpenCV 视觉检测 + 自动发送 + 自动复制回复** 的完整项目。

它针对你这组图标做了增强：

- `ChatGPT` 顶部标志
- `Thinking` / `Extended thinking` 顶部模式标志
- 输入框 `Ask anything`
- 麦克风图标
- 发送按钮
- 工作中 `stop` 按钮
- `copy` 按钮
- 向下箭头

## 核心逻辑

### READY_TO_SEND
满足这些条件：
- 在聊天页上
- 有输入区域或底部语音/输入区域标志
- 有发送按钮
- 没有 stop 按钮

### WAITING_REPLY
满足：
- 检测到 stop 按钮（支持两种模板）

### REPLY_READY
满足：
- stop 消失
- 如果有向下箭头，先点击向下箭头
- 检测到 copy 按钮

## 窗口前台保障（新增）

为避免“找不到图片”，工具现在会在关键步骤前自动把 Chrome + ChatGPT 标签页置顶到前台（macOS）。

配置项在 `config.json`：

```json
"browser": {
  "auto_prepare": true,
  "force_foreground_before_capture": true,
  "target_url": "https://chatgpt.com/"
},
"timing": {
  "focus_min_interval_sec": 1.2
}
```

- `auto_prepare`: 是否自动激活 Chrome 并定位 ChatGPT tab
- `force_foreground_before_capture`: 每次检测前是否尝试置顶窗口
- `focus_min_interval_sec`: 置顶节流，避免过于频繁抢焦点

## 回复抓取方式

不用 OCR，流程是：

1. 发消息
2. 等 stop 出现
3. 等 stop 消失
4. 如果有向下箭头，点击向下箭头
5. 等 copy 按钮
6. 点击 copy
7. 从剪贴板直接读取回复文本

---

## 目录

- `run.py`：命令入口
- `src/chat_vision/detector.py`：模板匹配和 ROI
- `src/chat_vision/bot.py`：状态机和自动化逻辑
- `src/chat_vision/storage.py`：最近聊天记录
- `templates/`：模板图片
- `debug/`：调试输出图

---

## 安装

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp config.example.json config.json
```

Windows:
```bash
.venv\Scripts\activate
```

---

## 第一步：改截图区域

在 `config.json` 里改成你的浏览器聊天区域：

```json
"capture_region": {
  "left": 0,
  "top": 0,
  "width": 1600,
  "height": 1000
}
```

建议：
- 浏览器缩放固定
- 窗口大小固定
- 主题固定
- 只截聊天页，不要把太多无关区域带进去

---

## 命令

### 看状态
```bash
python run.py watch --config config.json
```

### 看一次状态
```bash
python run.py state --config config.json --json
```

### 发消息
```bash
python run.py send --config config.json --text "你好"
```

### 发消息并抓回复
```bash
python run.py ask --config config.json --text "帮我总结一下今天的任务"
```

### 只复制最近一次回复
```bash
python run.py copy-last --config config.json
```

### 输出调试截图
```bash
python run.py debug-shot --config config.json --out debug/last_debug.png
```

---

## 优化点

这个版本比前一个版本多了这些增强：

- **多模板分组**
  - 顶部页面标志
  - 底部输入/发送/工作中
  - 回复 copy
  - 向下箭头
- **ROI 限制**
  - 顶部模板只在顶部找
  - 底部按钮只在底部找
  - 向下箭头只在中下区域找
  - 更快，也更稳
- **双预处理**
  - 灰度匹配
  - 边缘匹配
  - 对图标轮廓更稳
- **等待状态更合理**
  - 先等 stop 开始
  - 再等 stop 消失
  - stop 消失后优先处理向下箭头
  - 最后等 copy
- **调试图**
  - 可以直接输出识别框和分数，方便你调阈值

---

## 你最先该做什么

先跑：

```bash
python run.py state --config config.json --json
python run.py debug-shot --config config.json
```

看 `debug/last_debug.png` 里框的位置对不对。

如果不稳，就改：
- `capture_region`
- `templates` 里的 `threshold`
- `rois`

---

## 注意

我已经把完整代码和你新给的图标都接进去了。  
但我这里 **没有你的真实浏览器页面**，所以最关键的还是你本地做一次 `debug-shot` 校准。

如果后面你要，我下一步可以继续给你做：

- 自动滚到最底部再复制
- 多轮会话管理
- DOM + OpenCV 双通道
- 和你前面 bridge 项目打通
- 输出标准 JSON 给其他 agent 用
