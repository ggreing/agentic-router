# Agentic Router Proxy

> **草稿 — 发布前定稿。**

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

Agentic Router Proxy 是面向 Claude Code 的按难度分派的团队路由器：由一个插件和一个本地守护进程读取每个
请求、评估其难度，然后要么让主会话直接处理，要么组建规模合适的子代理团队（architect、coder、reviewer、
tester、ui-designer）。每个角色都位于一个「模型 × effort」阶梯上，任务难则上移、易则下移，力求在仍能
通过验证的前提下以最低成本完成工作。CLI 与软件包名称为 `agentic-router`。

**工作原理。** Claude Code 插件通过 `127.0.0.1` 将挂钩事件转发给本地守护进程；守护进程对每个请求进行判定，
把计划和工作账本写入单个本地 SQLite 文件，并向主会话（「主控」）注入一段简报，告知它应自行处理还是委派。
委派时，主控在插件强制的写入范围内调用子代理；守护进程运行每个子任务的构建、类型检查、lint 和测试，记录
成本，并在阶梯上调整各角色。用于记录或建议的挂钩在失败时放行：如果守护进程未运行，Claude Code 的行为与
没有插件时一致，并将该工作记为「未验证」。面向子代理的写入范围守卫依据本地文件工作，出错时阻止，因此子
代理绝不会写到自身范围之外。

## 判定

第一阶段仅用规则——没有嵌入，也没有额外的模型调用。当规则无法判断规模时，Opus 级、Sonnet 或未知主控会把
该请求作为 L2 团队承接，而 Haiku 主控则依据注入其上下文的评分表（rubric）自行判断。两种模式都不会有额外的
外部调用。基于嵌入的相似案例检索目前暂缓。

## 委派与阶梯

是否委派某个级别取决于主控（主会话）的模型：Opus 级、Sonnet 或未知主控从 **L1** 起委派，Haiku 主控从
**L2** 起委派，而 **L0** 始终直接处理。委派之所以划算，是因为昂贵的主控不再亲自编辑：在直接对团队的
测量中，主控 + 一名 Haiku coder 比主控单干便宜约 40%（见 `docs/measurements/`）。

当连续两次未达标、两次 reject，或主控提出请求时，角色会上移一档；主控的请求若不改变模型，则每个槽位有一次
无需询问，其余情况需用户确认后生效。每个槽位最多上移 3 次，之后会询问用户。当审查者或测试者判定为「easy」
的结果连续出现两次时，角色会下移一档。

## 安装（发布前, 从源码）

尚未发布到 npm。请从克隆运行：

```
git clone <repo> && cd agentic-router
npm ci
npm run build:dashboard                        # build the dashboard SPA (npm ci does not)
node packages/cli/src/index.ts <command>      # pre-release entry point
```

下文中的 `agentic-router <command>` 即指该入口。要求：**Node 24+**、**Claude Code ≥ 2.1.295**，以及在
**Windows 上使用 Git Bash**。

- `agentic-router init` — 注册 Claude Code 插件（角色、挂钩、主控技能、路由器 MCP 工具）和状态行，并设为
  订阅模式（默认）。API 密钥模式请用 `init --mode api`。
- `agentic-router start` — 在后台启动本地守护进程（判定 API、工作账本、仪表板）。
- `agentic-router doctor` — 检查配置并报告问题。
- `agentic-router status` / `stop` — 查看守护进程状态；停止它。
- `agentic-router dashboard [--no-open]` — 打开本地仪表板（见下文）。
- `agentic-router mode subscription|api|direct|proxy` — 切换模式（见「模式」）。
- `agentic-router policy show|accept|revoke` — 查看并接受项目的 `.agentic-router/policy.json`（见「路由器
  工作者的权限」）。
- `agentic-router data export|purge`、`agentic-router routing reset` — 导出或清除本地数据；重置已学习的
  路由。
- `agentic-router uninstall [--keep-key]` — 先询问，然后移除插件的配置项、项目的 `worktree.baseRef` 与
  `.gitignore` 行、配置备份和密钥库中的密钥，并停止守护进程。你的数据文件夹会保留。
- 仅 API 密钥模式：`agentic-router token rotate [--no-grace]`、`agentic-router key set`、
  `agentic-router proxy allow-upstream <https origin>`。

## 模式

- **订阅**（默认, `init`）：仅由插件和本地守护进程完成全部工作；没有代理，任何组件都不会读取或存储订阅
  凭据。流量从 Claude Code 直接发往 Anthropic。
- **API 密钥**（`init --mode api`）：可选启用的本地代理会汇总真实的令牌成本，并执行每个本地令牌每天
  $100、总计每天 $300 的预算（可配置）以及每次请求的预算。这些不是硬性上限：达到预算后新调用会被以 429
  拒绝，但已在进行中的响应可能会超出它。API 密钥仅保存在操作系统的密钥库（Windows 凭据管理器 / macOS 钥匙串 / Linux
  libsecret）中。
- **直连（direct）**：当代理出现问题时，用 `agentic-router mode direct` 以 API 密钥直接连接、绕过代理，
  再用 `agentic-router mode proxy` 切回。

可随时用 `agentic-router mode subscription|api|direct|proxy` 切换。

## 仪表板

`agentic-router dashboard` 会打开一个只读的本地网页仪表板（由守护进程在 `127.0.0.1` 上提供），展示请求
时间线、每个请求的团队/档位/验证结果、成本（主控对工作者）、各项 KPI、判定对实际的学习报告，以及自动解除
面板。支持英语、韩语、日语和简体中文，所有数据都留在本机。

## 隐私

一切都存储在单个本地 SQLite 文件中；除 Claude Code 自身的流量外，不会有任何内容离开本机，路由器在两种模式
下都不会发起自己的外部调用。学习存储保存由规则提取的特征、结果、成本以及相似度等数值，
不保存嵌入；除非你启用 `recordPrompts`，否则不保存提示词原文。关闭 `recordPrompts` 后，已保存的提示词
原文会在下次守护进程启动时删除。日志和仪表板会对 API 密钥和令牌进行脱敏。任何组件都不会读取或存储订阅
凭据。

## 自动解除留出组

为验证委派是否仍然划算，约十分之一的委派级别请求会被有意交由主控直接处理，作为留出基线。默认是
**observe**：留出组照常运行，仪表板展示对比以及解除后会发生什么，但在你开启 `autoRelease` 之前不会切换
任何内容。要停止抽取留出组，把 `holdoutRate` 设为 `0`，或关闭 `autoRelease`。

## 路由器工作者的权限

路由器的工作者（主控派发的 coder、tester 等子代理）与其他任何代理一样使用 Claude Code 的工具。路由器在
这些工具前面加了一道守卫，守卫给出三种回答之一：

| 守卫的回答 | 何时 | 结果 |
|---|---|---|
| 拒绝 | 识别为不被允许的调用：写到子任务范围之外、凭据文件、路由器自身的文件夹、不在工作者允许清单上的命令或选项。 | 调用不会运行。任何允许规则都无法覆盖它。 |
| 允许 | 读取或搜索仓库内指定名称的文件，以及编辑子任务范围内的文件。 | 无需询问即运行。 |
| 沉默 | 它未拒绝的所有 Bash 命令。 | 由 Claude Code 自身的权限规则决定，与没有路由器时一样。 |

### Bash 走你的权限规则

守卫读取命令行，但不会把它放进沙箱，所以它绝不会替你批准某个 Bash 命令。工作者的 `npm test` 或
`npm run build` 与 Claude Code 中任何其他 Bash 命令一样处理：有规则允许就运行，否则会询问你。在非交互运行
（`claude -p`）中没有人可问，因此没有允许规则的命令会被拒绝。

要让工作者无需询问即可构建和测试，请允许这些命令：

```
claude --allowedTools "Bash(npm test)" "Bash(npm run *)"
```

或在 `.claude/settings.json` 中：

```json
{ "permissions": { "allow": ["Bash(npm test)", "Bash(npm run *)"] } }
```

只允许一个脚本时，用 `"Bash(npm run build)"` 代替 `"Bash(npm run *)"`。对于其他工具链，用同样的方式允许
其测试和构建命令。

添加规则前需要了解：

- **链式命令需要每个部分都被允许。** Claude Code 会按 `&&`、`||`、`;`、`|` 拆分命令并逐段检查，所以
  `Bash(npm test)` 本身并不能覆盖 `make && npm test`。进入工作树内目录的 `cd` 属于只读、无需规则，因此
  `cd packages/web && npm test` 只需要 `npm test` 的规则。
- **规则对整个会话生效。** 它们适用于主控和每一个工作者，而不仅是路由器工作者。
- **允许一个会运行代码的命令，就等于为那段代码背书。** 测试文件或软件包脚本就是程序。一旦允许，它就以你的
  身份、以你的文件访问权限运行。当 `package.json` 中的 `scripts` 与上次提交不同时，路由器会拒绝软件包
  脚本和安装，直到你或主控确认；但它不会检查某个测试或脚本做了什么。
- **拒绝胜过允许规则。** 即使允许了 `"Bash(npm run *)"`，`npm run env`（打印环境）仍会被拒绝；即使允许了
  `"Bash(cat *)"`，`cat .env` 仍会被拒绝。

### 无论你允许什么，工作者都不能做的事

- 写到其子任务范围（`[scope: ...]`）之外，或写入 CI 配置、`.claude/`、`.git/`、`.mcp.json`、`.husky/`、
  `CLAUDE.md` 等会改变仓库或代理运行方式的文件。
- 读取、搜索或列出凭据文件（`.env`、`.npmrc`、`~/.ssh`、`~/.aws` 等）或路由器文件夹
  （`~/.agentic-router`）。`.env.example` 等模板可读。
- 运行工作者允许清单之外的命令（网络工具、shell、执行内联代码的解释器）、打印环境，或引用看起来像密钥的
  变量。
- 使用守卫无法解析的 shell 语法：`$'…'` 字符串、`${VAR}` 展开、命令替换、注释、重定向输出到文件。
- 从注册表以外的任何地方安装软件包（不允许 URL、git 规格或 `user/repo` 简写）。
- 使用 PowerShell。工作者只用 Bash。

即便是诚实工作的工作者也可能对某些拒绝感到意外。消息会说明改用什么：

| 被拒绝 | 改用 |
|---|---|
| `rg --hidden`、`rg --no-ignore` | 不带这些选项的 `rg`，或指明文件 |
| `git diff --no-index` | 对被跟踪文件的 `git diff`，或 `diff` |
| `printf -v`、`echo ${VAR}` | 普通的 `printf` / `echo $VAR`（非密钥名称） |
| 命令中的注释 | 去掉注释 |
| `npm install user/repo` | 注册表名称；其他情况请向主控请求 |
| 命令行上没有提交信息的 `git commit` | `git commit -m "…"`（或 `-F <file>`、`-C <commit>`） |
| `git commit --amend`、`-e`、`--reset-author` | 新建一次提交；由主控或用户修订 |
| `git add -p`、`-i`、`-e` | `git add <文件>` |
| `git add -A`、`git add .`，或其下有未被忽略凭据文件的 `git add <目录>` | 按名称添加文件，或把该文件加入 `.gitignore` |
| 除 `--show-current` 外的 `git branch`；`git stash list` 的写入/执行选项（`--output`、`--ext-diff`） | 向主控请求 |
| `tail -f`、`tail --follow` | `tail -n <N>` |
| `npm install -g`、`--prefix`、`--location`；`pnpm add -g`；`pip install --user`、`--target`、`--prefix` | 安装到项目内 |
| 写入 `.git`、CI 配置、`.claude` 或路由器策略的构建/测试/安装命令（例如 `npx tsc --outDir .git/hooks`） | 改变输出位置；这些文件的更改经由主控 |
| `/proc` 或 `/dev` 下的路径（`/dev/null`、stdin、stdout、stderr 除外） | 文件的常规路径 |
| 结果超过 64 个的花括号展开，或超过 20,000 字符的命令行 | 拆分命令 |
| 对含有未被忽略凭据文件的目录的递归 grep（`grep -r`/`-d recurse`） | `rg`、Grep 工具，或按名称指明文件 |
| 模式恰好是凭据文件名的 Bash 搜索（`grep ".env" …`、`rg '[.]env' …`） | Grep 工具（其模式不会被当作路径），或更长的模式如 `process.env` |

以下两点不是拒绝，但值得了解：单词内的引号和反斜杠会按 Bash 的方式解析，所以 `cat .en""v` 会被当作
`cat .env`，把名字拆开写也不会改变什么；另外，附加在短选项上的值会被当作路径，所以 `grep -f.env` 会像
`grep -f .env` 一样被拒绝。

### 项目策略

仓库可以在 `.agentic-router/policy.json` 中扩展工作者允许清单（`bashAllow`），并指定传递给验证的环境变量
（`verifyEnv`）。该文件只有在你接受之后才生效：

```
agentic-router policy show
agentic-router policy accept
```

接受与文件内容绑定。如果文件发生变化（例如在 `git pull` 之后），它会再次被忽略，直到你接受新内容。
`agentic-router doctor` 会显示当前状态。

### 工作者需要守护进程

只有当路由器为工作者保存了范围记录时，工作者才能写入；而该记录是在主控派发工作者时由守护进程写入的。
如果守护进程未运行，路由器工作者无法编辑文件，但仍可读取。`agentic-router status` 会显示它是否在运行。

## 局限

- verify 运行的是相关的构建/类型检查/lint/测试，因此以这些检查未覆盖的方式出错的修复仍可能通过。
- 「受理」指未观测到异议（没有回退、重复请求或投诉），因此成功/受理率是**上限值**，而非实测的认可率。
- 自动解除是防止重大损失的制动器，而非精细优化器：当团队明显不再更便宜时，它会在较宽的区间内把该级别
  退回直接处理。

## 状态

发布前（pre-release）。接口与默认值仍可能变化。

## 许可证

Apache-2.0。
