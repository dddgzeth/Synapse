# Synapse 被动捕获 Hook(Claude Code + Codex 通用)

`synapse_sync.py` 在每轮回答结束(Stop 事件)时,把**最后一组 user↔assistant 文本**
(自动过滤工具调用原始输出)同步到 Synapse 记忆。失败静默,绝不阻塞 CLI。

## 1. 准备

把本脚本放到固定路径(例如 `~/.synapse/synapse_sync.py`),并准备好你的 token
(Synapse 网页 → 头像菜单 → 连接 AI 工具 → 生成令牌)。

在 shell 配置里(`~/.zshrc`)设环境变量:

```bash
export SYNAPSE_TOKEN="syn_xxx"
# 可选三开关:
export SYNAPSE_SYNC_DIRS="$HOME/research:$HOME/7_hackathon"  # 项目白名单(不设=全部同步)
# export SYNAPSE_SYNC=off                                    # 总开关
# export SYNAPSE_MIN_CHARS=40                                # 过短对话不同步(默认40)
```

## 2. Claude Code

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{ "type": "command", "command": "python3 ~/.synapse/synapse_sync.py", "timeout": 30 }]
    }]
  }
}
```

## 3. Codex

`~/.codex/config.toml`:

```toml
[[hooks.Stop]]

[[hooks.Stop.hooks]]
type = "command"
command = 'python3 "~/.synapse/synapse_sync.py"'
timeout = 30
```

> Codex 会对非托管 hook 做信任确认,首次运行按提示 trust 即可。

## 4. 验证

装好后随便和 CLI 聊一轮,然后打开 synapse.cjlin.com 搜索你刚说的话——
应出现在 `ext_claude-code` / `ext_codex` 会话里。

## 行为细节

- 只同步**你说的话 + 助手最终文本回答**;tool 调用参数、报错堆栈、文件 dump 不同步
- 每条消息截断 50k 字符;user+assistant 合计 < `SYNAPSE_MIN_CHARS` 的琐碎轮次跳过
- 来源自动识别(transcript 路径含 `/.claude/` → claude-code,`/.codex/` → codex)
- Codex 的 `last_assistant_message` 字段优先于 transcript 解析结果
