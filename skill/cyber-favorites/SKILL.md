---
name: cyber-favorites
description: 操作用户的“赛博收藏夹”（CyberFavorites）：收藏链接、文字片段、截图和文件，按需求找出收藏过的 GitHub 项目 / Skill / MCP / 网站 / 文件，整理标签和分组，修改应用的 UI 主题。当用户说“收藏这个”“我之前存过一个做 X 的项目”“帮我找那张截图”“帮我整理收藏夹”“把收藏夹换成暗色”等时使用。
---

# CyberFavorites

收藏夹是一个 HTTP 服务，所有操作走 JSON API。改完之后用户开着的网页会通过 SSE 实时刷新，不用让用户手动刷新。

## 连接

服务有两种部署方式，先确定连哪个：

| 环境变量 | 含义 |
|---|---|
| `CF_URL` | 服务地址。没设置就是本机模式 `http://127.0.0.1:4170` |
| `CF_TOKEN` | API 令牌（`cft_` 开头）。连服务器时必须有；本机模式不需要 |

下面的例子都写成 `$CF_URL`，请换成实际地址。

1. `curl -s "$CF_URL/api/auth/status"` 看模式：`"mode":"local"` 是本机，`"mode":"server"` 是服务器。
2. 服务器模式的每个请求都要带 `-H "Authorization: Bearer $CF_TOKEN"`。返回 401 说明令牌没设、写错或被撤销了：告诉用户在网页 **设置 → API 令牌** 里生成一个，填进 `CF_TOKEN`。不要尝试别的登录方式。
3. 本机模式连不上时，告诉用户从开始菜单打开 CyberFavorites，或在项目目录运行 `npm start`。不要自己猜端口。
4. 写操作的请求体必须是 UTF-8 JSON，带 `-H "Content-Type: application/json"`。**Windows 终端里用 `-d` 直接写中文会被转成 GBK，服务会返回 400**：把 JSON 写进文件，用 `--data-binary @file.json` 发送；或者用 `node -e "fetch(...)"` 发请求。

## 数据结构

```json
{
  "id": "a1b2c3d4e5",
  "type": "repo | skill | mcp | site | article | tool | image | file | text",
  "title": "owner/repo",
  "url": "https://github.com/owner/repo",
  "description": "抓来的简介；文件收藏是正文开头",
  "note": "用户写的备注：为什么收藏、以后用在哪",
  "tags": ["ai", "python"],
  "pinned": false,
  "groupId": "f00ba12345 或 null（未分组）",
  "order": 0,
  "site": "github.com",
  "github": { "stars": 1234, "language": "Python", "topics": [], "license": "MIT", "archived": false },
  "file": { "id": "...", "name": "周报.docx", "ext": "docx", "size": 12345, "mime": "...", "width": 1920, "height": 1080 },
  "text": "文本片段的全文，或从 docx/pptx/xlsx/txt/md 等文件里抽出的文字",
  "createdAt": "...", "updatedAt": "..."
}
```

- 前六种 `type` 是链接；`image` 是图片和截图，`file` 是其他文件，`text` 是粘贴的文字片段。
- `github` 只有 GitHub 链接才有，`file` 只有上传的收藏才有。
- 列表和搜索接口里 `text` 只给前 600 字，带 `truncated: true` 和 `textLength`；要全文用 `GET /api/items/:id`。
- 文件本身在 `GET $CF_URL/files/<file.id>`（服务器模式同样要带令牌），加 `?download` 是下载。
- `note` 是用户自己的话，最能反映收藏意图，整理时不要覆盖它。

分组 `{id, name, order, count}`，用 `GET /api/groups` 获取。每个收藏最多属于一个分组；`order` 是收藏在分组内的位置，越小越靠前，用户在网页上拖动排序时会改它。标签描述“它是什么”，分组表示“用户打算怎么用它”。
## 找东西

用户描述需求（“之前存过一个能把网页转 markdown 的东西”“上周那张报错截图”），按这个顺序：

1. `GET /api/search?q=关键词1 关键词2&limit=20`：返回 `{results:[{score, matched, item}]}`，按分数排序。关键词用空格分隔，中英文都试，同义词分开搜（例如 `markdown 转换`、`html2md`、`scraper`）。标题、标签、分组名、备注、文件名、文件里抽出的文字都会参与搜索。
2. 搜不到就用 `GET /api/items?type=image`、`?tag=xxx`、`?group=<分组id>` 缩小范围，或者直接 `GET /api/items` 拿全部，自己读 `description`、`note`、`topics` 判断。收藏一般不会太多，全量读完全可以。
3. 截图的内容没有被识别成文字，只能靠文件名、标签、备注、收藏时间来找。找不到就按时间列出最近的几张截图，让用户自己认。
4. 回答时给出标题、链接（文件给 `$CF_URL/files/<file.id>`）、为什么匹配，有 `note` 的话引用它。不确定就列 2–3 个候选让用户选。

## 收藏

**链接**或**文字片段**：`POST /api/items`，`url` 和 `text` 二选一。

```bash
# body.json: {"url":"https://github.com/owner/repo","groupMode":"auto","note":"以后做 X 时用","tags":["ai"]}
curl -s -X POST "$CF_URL/api/items" -H "Content-Type: application/json" --data-binary @body.json
```

链接会自动抓标题、描述、图标，GitHub 链接还会拉 star、语言、topics，然后猜类型、打初始标签。文字片段用第一行做标题。

**文件**（图片、截图、docx、pdf…）：`POST /api/upload`，请求体就是文件本身，参数放在查询字符串里。

```bash
curl -s -X POST "$CF_URL/api/upload?name=周报.docx&groupMode=auto&note=季度总结" \
  -H "Content-Type: application/octet-stream" --data-binary @周报.docx
```

`Content-Type` 必须用 `application/octet-stream` 或文件的真实类型，不能用 `text/plain` 和表单类型（会返回 415）。默认上限 50 MB。

三种收藏都返回 `{duplicate, item}`。`duplicate: true` 说明已经收藏过（同一个链接、同一段文字或同一个文件），不会重复添加。

### 分组：`groupMode`

| 值 | 效果 |
|---|---|
| `none` | 不分组 |
| `pick` | 指定分组：再传 `groupId`（已有分组），或 `group`（分组名，不区分大小写，不存在会新建） |
| `auto` | 自动分组：挑最像的已有分组；都不像就按类型放进“图片”“文件”“GitHub 项目”这类分组，没有就新建。返回里的 `autoGroup` 有分组名、是否新建和理由 |

不传 `groupMode` 时：传了 `groupId` 或 `group` 就是 `pick`，否则是 `none`。

怎么选：用户说了分组就用 `pick`；用户说“帮我放好”就用 `auto`，然后把 `autoGroup.reason` 告诉用户；用户什么都没说时用 `auto` 前先看看 `GET /api/groups`，觉得放错了就改用 `pick` 并说明理由。不要为一个收藏随手新建分组。

用户在对话里提到一个想以后再看的链接、命令或文件时，可以主动问要不要收藏，并顺手把对话里的用途写进 `note`。

## 整理

先 `GET /api/groups`、`GET /api/items?sort=manual` 和 `GET /api/tags` 看全貌，**向用户说明打算怎么改，确认后再执行**，尤其是删除和大范围调整分组。

| 操作 | 接口 |
|---|---|
| 改单条 | `PATCH /api/items/:id`，可改 `title, description, note, tags, pinned, groupId`（`null` 表示移出分组）；链接还能改 `url, type`，文本片段还能改 `text` |
| 批量加/删标签、改类型、置顶、移分组 | `POST /api/items/bulk` `{"ids":[...], "addTags":[...], "removeTags":[...], "type":"mcp", "pinned":true, "groupId":"..."}` |
| 调整分组内顺序（也能跨分组移动） | `POST /api/items/reorder` `{"groupId":"..." 或 null, "ids":[按新顺序排列的 id]}` |
| 新建 / 重命名 / 删除分组 | `POST /api/groups` `{"name"}`、`PATCH /api/groups/:id` `{"name"}`、`DELETE /api/groups/:id`（里面的收藏回到未分组，不会删除） |
| 调整分组顺序 | `POST /api/groups/reorder` `{"ids":[按新顺序排列的分组 id]}` |
| 合并或重命名标签 | `POST /api/tags/rename` `{"from":"llm", "to":"ai"}` |
| 删除 | `DELETE /api/items/:id` 或 `POST /api/items/delete` `{"ids":[...]}`。**上传的文件会一起删除，无法恢复** |
| 重新抓取链接信息 | `POST /api/items/:id/refresh`（保留 note、pinned 和手动加的标签；只对链接有效） |
| 导出 | `GET /api/export`（只有收藏记录，不含上传的文件本身） |

整理建议：
- 标签用小写短词，同义词合并（`llm` / `large-language-model` → `ai`），一个收藏 2–6 个标签。
- 链接的类型是按关键词自动猜的，会误判。判断标准：独立的 MCP 服务器是 `mcp`；Claude Code / Agent skill（含 SKILL.md）是 `skill`；其他代码仓库是 `repo`；在线可用的产品是 `tool`；博客、教程是 `article`；其余 `site`。`image`、`file`、`text` 由收藏方式决定，不要把链接改成这三种。
- 截图默认叫“截图 2026-11-01 13-32-40”。用户说了截图内容时，帮忙把 `title` 改成有意义的名字，再加上标签。
- `github.archived: true` 或很久没更新的项目，可以提醒用户，不要擅自删除。
- 大批量删除之前先 `GET /api/export` 存一份，并提醒用户文件删了就没了。

## 改 UI

```bash
curl -s "$CF_URL/api/theme/schema"   # 可改字段、预设、取值范围
curl -s "$CF_URL/api/theme"          # 当前主题
curl -s -X PATCH "$CF_URL/api/theme" -H "Content-Type: application/json" -d '{"preset":"abyss","layout":"list"}'
curl -s -X POST  "$CF_URL/api/theme/undo"   # 撤销上一步
curl -s -X POST  "$CF_URL/api/theme/reset"  # 恢复默认
```

`PATCH /api/theme` 只改传入的字段：

| 字段 | 取值 |
|---|---|
| `preset` | `laterano`（天青，默认）、`laterano-gold`（白金）、`abyss`（暗色）。会覆盖 colors 和 dark |
| `colors` | 部分颜色覆盖：`bg, paper, card, accent, accentHi, accentSoft, accentPale, accentInk, ink, muted, line, danger`，值用 `#rrggbb` / `rgb()` / `hsl()` / `oklch()` |
| `dark` | 布尔值，只影响浏览器原生控件配色；暗色要同时给深色 colors |
| `font` | `serif` / `sans` / `mono` |
| `layout` | `grid`（卡片）/ `list`（列表）/ `compact`（紧凑） |
| `cardWidth` | 220–520，卡片最小宽度 px |
| `radius` | 0–28，圆角 px |
| `decor` | `{"rose": bool, "rays": bool}`，背景玫瑰窗和天光 |
| `title` / `subtitle` | 顶栏标题 |
| `customCss` | 任意 CSS，追加在样式表最后，整段替换，不是追加 |

参数不合法会返回 400 和说明，按说明修正即可。每次修改都会存历史，可以 undo 30 步。

### 写 customCss

先 `GET /api/theme` 读当前 `customCss`，在它的基础上改，否则会把用户之前的样式冲掉。颜色尽量用变量（`var(--c-accent)` 等），这样用户换预设时也能跟着变。页面有内容安全策略（CSP），CSS 里引用外部字体和图片会被拦截，只能用页面自带的资源。

页面结构：

```
body.layout-grid|list|compact [.no-rose] [.no-rays] [.dark]
├ svg#rose  div#rays                      背景装饰
├ header
│  ├ .halo  .brand>strong#title+small#subtitle
│  ├ form#add>input#url+button.file-btn+select#add-group+button   收藏输入框、选文件、分组下拉
│  └ #counter
├ main
│  ├ aside>section>h4+nav#groups|nav#types|nav#tags  侧栏，nav a.on 是选中项
│  └ section#content
│     ├ #toolbar>#q  #sort  #layout-switch
│     ├ p#drag-tip                            不能拖动时的提示
│     └ #items>section.group[.folded][data-section=<分组id>|none]
│          .group-head>button.fold+h2+span.count+span.line+.gacts
│          .group-body>article.card.kind-<type>[.pinned][.dragging]
│             .top>.grip+img.fav+.site+.type.<type>
│             .acts  button.thumb>img（图片）  h3>a  p.desc[.snippet]  .file-row>.file-icon（文件）
│             p.note  .gh  .chips>span  .bottom
└ dialog#editor  dialog#name-dlg  dialog#settings  dialog#viewer  #drop-mask  #toast
```

`.group-body` 是每个分组自己的卡片网格；要改卡片间距、列数，选它而不是 `#items`。

CSS 变量：`--c-<颜色键>`、`--font`、`--serif`、`--sans`、`--mono`、`--card-w`、`--radius`。

改完告诉用户改了什么，提醒不满意可以说“撤销”。
