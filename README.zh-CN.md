# Agentic Router Proxy

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [简体中文](README.zh-CN.md)

用 Opus 或 Sonnet 跑 Claude Code 时，主会话几乎什么都自己做，连便宜得多的模型也能改对的改动也不例外。
这个项目是一个 Claude Code 插件加一个小的本地守护进程，用来改变这一点。每来一个请求，它就决定主会话是
直接处理，还是把活儿交给几个跑在便宜模型上的子代理，主会话只做计划和检查。

我们最近一次测量是：用 Sonnet 主会话、按发布状态开着路由器，每个通过任务的成本比直接用 Claude Code 少了
33%，通过的任务也一样。多数情况下是主会话把修改交给一个 Haiku 编码者。代价是更慢：每交一次就得新起一个
工作者，在较大的任务上，团队明显比主会话单干更费时间。数字和测法都在 [docs/measurements](docs/measurements/)。

CLI 和软件包都叫 `agentic-router`。

## 工作原理

插件把 Claude Code 的挂钩事件转发给 `127.0.0.1` 上的守护进程。你发出一个提示，守护进程不调用模型、只用
规则估一下请求的大小，然后告诉主会话（我们叫它「主控」）该怎么办：自己处理，还是交给一个团队。

小事情（一个拼写错误、一行的修复）由主控直接做。更大的事情，如果主控是 Opus 级或 Sonnet，或者路由器判断
不出是哪个模型，就交给团队。主控是 Haiku 时，L1 这类活儿它自己做，反正工作者也是同一个模型，交出去没
好处。规则判断不出大小的请求，会送给一个小团队，具体需要哪些角色由主控来定（Haiku 主控会拿到一份简短的
判断标准，自己决定）。

工作者从通常能行的最便宜的档开始（编码者是 Haiku、effort low），失败了就往上走：连续两次没达标、被审查者
或测试者拒绝两次，或者主控要求，都会升一档。反过来，如果审查者接连判定「有余量」，就降一档。升了三次还
不行，就问用户。

工作者做完后，守护进程在那个工作目录里跑项目自己的构建、类型检查、lint 和测试，并检查工作者只改了交给它
的文件范围。计划了什么、实际发生了什么、花了多少，全都记在一个本地 SQLite 文件里。

守护进程没在跑时，Claude Code 的表现就跟没装插件一样。唯一的例外是路由器的工作者：它们只有在守护进程开着
时才能写入，所以不会改到自己范围之外。

## 开始使用

还没发布到 npm。需要 Node 24 以上、Claude Code 2.1.295 或更新版本，Windows 上还要有 Git Bash。

```
git clone https://github.com/ggreing/agentic-router && cd agentic-router
npm ci
npm run build:dashboard
node packages/cli/src/index.ts init
node packages/cli/src/index.ts start
```

在发布软件包之前，`node packages/cli/src/index.ts` 就是 CLI，下文简写成 `agentic-router`。`init` 会注册
插件和一行状态栏，但在改动你的 Claude Code 配置前会先征求同意。要是哪里不对劲，用 `agentic-router doctor`
检查一下安装。

你大概会常用这些命令：

| 命令 | 作用 |
|---|---|
| `status`, `stop` | 查看或停止守护进程 |
| `dashboard` | 打开本地仪表板 |
| `mode subscription\|api\|direct\|proxy` | 切换模式（见下文） |
| `policy show\|accept` | 在项目的 `.agentic-router/policy.json` 生效前先查看 |
| `data export`, `data purge` | 导出或删除路由器记录的内容 |
| `uninstall` | 撤销 `init` 做的事（数据文件夹保留） |

## 用订阅还是用 API 密钥

默认用你的 Claude 订阅。这种模式下没有代理，路由器既不读取也不保存你的订阅凭据，Claude Code 照旧直接和
Anthropic 通信。

要用 API 密钥，运行 `agentic-router init --mode api`，它会在 API 前面放一个小的本地代理。代理记录每次调用
的真实令牌成本，预算用完后就不再发出新调用：默认是每个本地令牌每天 $100、总共每天 $300，另外还有按请求的
预算。已经在传输中的调用会让它跑完，所以可能会略微超出。密钥本身只放在操作系统的密钥库里。要是代理碍事，
`agentic-router mode direct` 可以绕过它，`agentic-router mode proxy` 再把它放回来。

## 工作者与权限

路由器的工作者照常用 Claude Code 的工具，只是前面隔着一道守卫。守卫会拒绝写到范围之外、碰凭据文件或路由器
自己的文件夹、以及小许可清单之外的命令。它不会替你批准 Bash：工作者的 `npm test` 仍走你平常的 Claude Code
权限规则。想让工作者构建和测试时不必每次都问，就这样允许：

```
claude --allowedTools "Bash(npm test)" "Bash(npm run *)"
```

什么会被拒绝、为什么，完整清单在 [docs/worker-permissions.md](docs/worker-permissions.md)（英文）。

## 你的数据

所有记录都留在你机器上的一个 SQLite 文件里，路由器不会自己发起任何网络调用。默认不保存你的提示，也不保存
工作者报告的文字，只留 id、大小、结果和成本。如果你想留下提示做自己的分析，打开 `recordPrompts`；再关掉时，
会在守护进程下次启动时把它们删掉。事件记录保留 30 天。

## 仪表板

运行 `agentic-router dashboard`，会打开守护进程提供的一个只读页面：最近的请求、谁做了什么、哪些检查通过了、
成本（主控对工作者），以及路由器对请求大小的第一判断有多准。支持英语、韩语、日语和简体中文。

## 确认委派是否仍然划算

本该委派的请求里，大约每十个就有一个故意交给主控直接处理，好有个对照。开箱即用时路由器只报告它看到的情况，
除非你把 `autoRelease` 设为开，否则它不会自己关掉任何东西。要是你连对照都不想要，把 `holdoutRate` 设为 0。

## 目前还做不好的地方

工作者结束后跑的检查，归根结底是项目自己的测试。以测试覆盖不到的方式出错的修复，照样会通过。出现这种情况
时主控可以把活儿往上退一档，但得先察觉到。

仪表板里的「受理」指的是，在接下来的几个提示内没人撤销这次改动、没再提一次同样的请求、也没抱怨。这是「有
多大比例的工作是好的」的上限，不是对它的测量。

自动关闭是用来抓住明显变贵的委派的，不是用来精细调节的。以涉及的样本量，它分不清 25% 的损失和噪声。

这还是发布前版本，命令和默认值可能还会变。

## 贡献与安全

见 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 所述私下报告，那里也列出了
守卫无法防护的情况。

## 许可证

Apache-2.0。见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
