# dsh-mcp-market-hub

[![npm](https://img.shields.io/npm/v/dsh-mcp-market-hub)](https://www.npmjs.com/package/dsh-mcp-market-hub) [![license](https://img.shields.io/npm/l/dsh-mcp-market-hub)](LICENSE)

把两个 MCP 市场聚合进 DSH 侧栏，**按分类挑一个就装进本机 DSH**：**MCP Market（https://mcpmarket.cn）** 与 **魔搭 ModelScope MCP 广场**。

## 界面

侧栏「MCP 市场」，与 dsh-mcp-connector 同一套路：Host 侧用 prefix 路由把 `ui/` 目录当静态面板，侧栏里是一个同源 iframe。

- **左栏分类**：`全部 MCP`、`已安装到 DSH`、`内嵌市场网页`，下面是 MCP Market 的 25 个中文分类（带条数：全部 89054、开发 55813、数据 31580、精选 139…）和魔搭的 8 个分类（中文标签 · 英文 id）。点分类即切列表。
- **卡片网格**：logo、标题、包名 · 作者、来源徽章（MCP Market 蓝 / 魔搭 绿）、★、托管、分类 chip、右侧「安装」。26 条一页，底部翻页。
- **详情抽屉**：说明、安装方式单选（stdio 的 `command/args/env`，或 streamable-http / sse 的 url）、「将写入 DSH 的配置」JSON、底部「安装到 DSH 连接器」「复制 JSON」。
- **内嵌市场网页**：mcpmarket.cn 允许被 iframe（无 X-Frame-Options/CSP），直接内嵌原站；魔搭页面带 `X-Frame-Options: SAMEORIGIN`，内嵌会被浏览器拒绝，所以那天只给「新窗口打开」+ 原生分类视图。
- 右上角「切换主题」在深/浅色间切换（存 localStorage）。

## 安装到底写到哪里（重点）

点「安装到 DSH 连接器」→ 插件 Host 侧把记录原子写入 **本机 DSH 的连接文件**：

```
C:\Users\ElecDesigner\.dsh\storages\mcp_connector.json   →   tables.connections[<key>]
```

记录 schema 与 `dsh-mcp-connector` 的 `connectionRecordSchema` 一致：`key / connectorId / kind:'json' / name / serverName / transport / url 或 command+args+env / enabled / createdAt / updatedAt`。

**写完之后必须让连接器重新读一遍**：重启 DSH，或在插件页重载 `dsh-mcp-connector`。连接器只在 apply 阶段遍历 connections 建通道，不监听文件变化。

若走预览/dry-run，可把 `DSH_HOME` 指向临时目录，写入就会落到那里，不碰真实配置。

## 已知限制

1. **公网纯 http 端点装不进去**。连接器只接受 https、回环 http（127.0.0.1/localhost/::1）或显式放行的私网地址；`http://8.217.130.241:18001/…` 这类条目会被拦下并报 `MARKET_ENDPOINT_UNUSABLE`。
2. **魔搭列表接口忽略分类/搜索参数**，恒定返回 14 条，分类与搜索都在本地过滤。
3. **mcpmarket 列表行没有连接配置**，点进详情才拉 `mcp_config` / `mcp_url`，抽屉会多一次请求。

## 工具（Agent 可调用）

| 工具 | 作用 |
| --- | --- |
| `mcp_market_search` | 跨源搜索（query / source / category / page） |
| `mcp_market_detail` | 某条目的完整详情与可用连接方式 |
| `mcp_market_install` | 写入本机连接文件；默认 `apply:false` 只预览 |
| `mcp_market_installed` | 列出本机已有连接（含文件路径） |

## 结构

```
lib/market.js    两市场列表/详情/分类适配 → {source,id,name,title,subtitle,author,description,categories,tags,stars,hosted,url,icon,formats[]}
lib/install.js   端点校验 + mcp_connector.json 读取/原子写入（dshHome: DSH_HOME 或 ~/.dsh）
lib/index.js     Host：/dsh-mcp-market-hub/api（search/categories/detail/installed/install）+ 四个工具
lib/ui.js        Host：prefix 路由 /dsh-mcp-market-hub/ui 提供下面的静态面板（含 CSP、目录穿越防护）
ui/index.html    面板骨架
ui/app.css       深/浅两套变量与卡片、抽屉样式
ui/app.js        面板逻辑：分类栏、卡片、详情抽屉、安装、内嵌网页、主题
client.js        侧栏入口 + main 槽 iframe（connector 式外壳）
_scratch/        探针、预览服务器、打包脚本
```

## 安装（profile）

```
package.json  dependencies: "dsh-mcp-market-hub": "link:<本目录>"
             dsh.profile.bundles 里加 "dsh-mcp-market-hub"
node_modules/dsh-mcp-market-hub -> 本目录（junction/symlink）
```

插件行由本包的 `cordis.patch.yml` 自动展开。也可以用插件管理器装本目录打出的 npm 布局 `.tgz`。

## 数据来源（公开只读，无需鉴权）

- MCP Market：`GET https://mcpmarket.cn/api/servers?page=&search=&category=`、`/api/servers/<id>`、`/api/categories`
- 魔搭：`GET https://modelscope.cn/api/v1/mcpServers/list?PageNumber=&PageSize=`

## 从 npm 安装

已发布到 npm（0.1.0，公开包）：

- npm：<https://www.npmjs.com/package/dsh-mcp-market-hub>
- 插件市场（dshmp.com）：包名 `dsh-mcp-market-hub` 的发布检查结果为 **QUALIFIED**（声明了 `dsh.bundle` 清单即可收录），目录每日 02:00 UTC 刷新，次日可见。

安装：

```bash
npm i dsh-mcp-market-hub --registry=https://registry.npmjs.org
```

或在 DSH 插件管理器里搜 `dsh-mcp-market-hub`，或按关键字 `dsh-plugin` 浏览。
包上带了 `dsh-plugin` 关键字，DSH 插件目录站点会自动收录（每日抓取 npm），不需要单独提交。

发布命令（需要已 `npm login`，且账号已开 2FA 或使用带 bypass 2FA 的 token）：

```bash
npm publish --access public --registry=https://registry.npmjs.org
```
