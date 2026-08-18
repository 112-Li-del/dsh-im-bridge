# dsh-im-bridge

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）桥接到**微信**的插件：
**在电脑上跑长任务，离开后用微信远程监控、批准、追加指令。**

基于 **DSH 0.1.0-rc.6**，iLink（微信官方 Bot 协议）通道，扫码登录。

## 功能

- **DSH → 微信**：turn 完成 / 出错 / 被阻塞、批准请求（含工具名与原因）实时推送
- **微信 → DSH**：回复文本注入绑定会话；回复「批准 / 拒绝」应答 pending approval；`/bind <session>` 切换绑定会话
- **侧边栏扫码登录**：Web 界面左下角（设置旁）出现二维码图标，点击弹出实时刷新的登录二维码，不用再翻文件
- **断线自愈**：长轮询连续失败（令牌过期/连接失效）时自动重新进入扫码登录流程，无需重启 DSH
- iLink 扫码登录，单用户白名单，消息去重（持久化）、长回复分段、`..` / `!!` / 超时合并

> 本项目是 [BiBoyang/dsh-im-bridge](https://github.com/BiBoyang/dsh-im-bridge)（MIT）针对
> **DSH 0.1.0-rc.6** 的适配增强版（原版基于 0.0.1-rc.1）。新增：二维码图片自动生成、
> HTTP 路由（`/dsh-im-bridge/qr.png`、`/dsh-im-bridge/status.json`）、侧边栏二维码 UI
> （`dsh.client` 浏览器半体）、长轮询断线自动重登。

## 安装

```bash
# 1. 确保 pnpm 可用（dsh plugin 命令依赖它）
corepack enable
corepack prepare pnpm@latest --activate

# 2. 安装本插件到 web profile（也可从 npm 安装，见下）
dsh plugin --profile web add github:<你的用户名>/<本仓库名>

# 3. 重启 DSH（桌面端关窗重开 / 终端 Ctrl+C 重来 / 网页端刷新）
```

> 从 npm 安装：`dsh plugin --profile web add dsh-im-bridge`（发布后可用）。

## 使用

1. 启动 DSH Web（桌面端或浏览器）后，**点左下角设置旁的二维码图标**，浮层里就是实时刷新的登录二维码（每 5 秒自动更新并显示登录状态），用微信「扫一扫」确认登录。
   - 备用：直接打开 `$DSH_HOME/dsh-im-bridge/login-qr.png`，或查看 `login-url.txt`。
2. 扫码确认的用户自动成为白名单用户。
3. 微信里发消息 → 注入当前绑定会话；`/bind <session-id>` 切换；`/status` 查看状态；`/help` 帮助。
4. agent 请求批准时收到推送，回复「批准」或「拒绝」（默认 120s 内有效，超时转回本机批准体系）。

> 注意：
> - iLink 二维码几分钟会过期并自动刷新（`login-qr.png` / `login-url.txt` 同步更新），扫的时候以**当前**内容为准；
> - **服务重启后 token 不落盘（安全设计），需要重新扫码**——直接点侧边栏二维码图标即可；
> - 运行中掉线（令牌过期等）会自动重新生成二维码，同样点图标扫码恢复。

## 配置

在 profile 的 `cordis.patch.yml` 插件行上加 `config`（如 `$DSH_HOME/profiles/web/cordis.patch.yml`）：

```yaml
- id: dsh-im-bridge
  config:
    allowedUserId: ''        # 白名单微信用户 id；空 = 首个扫码确认的用户自动绑定
    mergeTimeoutSecs: 5      # 消息合并窗口（秒）
    chunkMaxChars: 1200      # 长回复分段长度（Unicode 码点）
    pollTimeoutSecs: 70      # iLink 长轮询超时（秒）
    approvalTimeoutSecs: 120 # 批准请求等待微信答复的超时（秒）
    statePath: ''            # 状态文件路径（默认 $DSH_HOME/dsh-im-bridge/state.json）
```

## 安全红线

- 微信通道等于绕过本机批准体系：approval 应答必须来自白名单 user_id 且对应真实的 pending approval id
- token 不落库；不打印聊天内容明文以外的任何东西
- 微信来的消息只能进会话流（`source.kind = 'plugin'`），不能直接执行任意 shell

## 开发

```bash
npm install
npm run build      # tsc，产物在 lib/（lib/ 提交入库，git 安装不跑构建）
```

改完代码必须 `npm run build` 并重启 DSH 才生效（ESM 缓存）。
`lib/client.js` 是手写的浏览器半体（`__ModuleLoader__` 格式），不在 tsc 编译范围内。

## License

MIT — 保留原作者 [BiBoyang](https://github.com/BiBoyang/dsh-im-bridge) 署名。
