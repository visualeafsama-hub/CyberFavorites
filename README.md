# CyberFavorites · 赛博收藏夹

刷到一个好用的 GitHub 项目、Skill、MCP 或者神秘网站，但现在用不上？截了一张以后可能要看的图？复制了一段以后还会用的命令？粘贴进来就收藏好了。等哪天要用，直接问 AI：“我之前存过一个能 XX 的东西”。

- **什么都能存**：链接、截图（PrtSc、QQ、微信、Snipaste 截完直接 Ctrl+V）、图片、docx / pdf 等文件、复制的文字。从桌面把文件拖进页面也行。
- **自动整理**：链接会抓取标题、简介、图标，GitHub 链接还会拉取 star、语言、许可证和 topics，并判断它是项目、Skill 还是 MCP。docx、pptx、xlsx 和文本文件会抽出文字用于搜索。
- **分组**：收藏时选“自动分组”“不分组”或指定分组。拖动卡片调整顺序或换分组，拖动分组标题调整分组顺序。
- **AI 能直接操作**：自带一个 [Skill](skill/cyber-favorites/SKILL.md)，AI 通过 HTTP API 帮你收藏、查找、整理标签和分组，甚至改界面配色和布局。改完网页会实时刷新。
- **本机或服务器都能跑**：本机用打开就行；放到服务器上，手机电脑都能用，需要登录。
- **轻量**：只用 Node 内置模块，没有任何依赖，不需要数据库。

## 本机使用

需要 [Node.js](https://nodejs.org/) 20 或更高版本。

```bash
git clone https://github.com/visualeafsama-hub/CyberFavorites.git
```

```bash
cd CyberFavorites
```

```bash
npm start
```

然后打开 <http://127.0.0.1:4170>。不需要 `npm install`，不需要登录。服务只监听本机，局域网里的其他设备访问不到。

### 开机自启和快捷方式（Windows）

打开网页左下角的 **设置**，在“启动”里可以开关：

| 开关 | 效果 |
|---|---|
| 开机自启 | 登录 Windows 后在后台启动服务，不弹窗口，也不打开浏览器 |
| 开始菜单 | 能在开始菜单搜索 “CyberFavorites” 打开 |
| 桌面快捷方式 | 双击打开 |

开始菜单和桌面的快捷方式点开后，服务没在运行就先启动它，再打开网页；服务已经在运行就直接打开网页，不会重复启动。这些都是普通的 `.lnk` 快捷方式，不需要管理员权限，关掉开关就会删除对应的快捷方式。

快捷方式记录的是项目文件夹的位置。移动或删除项目文件夹前，先在设置里把开关都关掉。其他系统目前只能用 `npm start` 启动。

## 部署到服务器

设置了 `CF_PUBLIC_URL`（你的网址）就是服务器模式。和本机模式的区别：

- 所有页面、接口和文件都要登录才能访问。
- 抓取链接信息时不会访问内网地址，防止有人借收藏功能探测你的服务器内网（SSRF）。
- 开机自启这类改本机系统的功能会关掉。

### 登录

没有密码，用一次性的登录链接：

1. **第一次**：服务启动时会在日志里打印一个登录链接和二维码，60 分钟内有效。用浏览器打开它，这台设备就登录了，一年内不用再登。
2. **新设备**：在已登录的设备上打开 **设置 → 设备 → 添加设备**，用新设备扫二维码，或者把链接复制过去。链接 10 分钟内有效，只能用一次。
3. **所有设备都退出了**：在服务器上运行 `node server.js --login-link`（要带上和服务一样的环境变量），会生成一个新的登录链接。

每台设备在 **设置 → 设备** 里都能单独移除。给 AI 用的令牌在 **设置 → API 令牌** 里生成，可以随时撤销，不影响网页登录。

### 用 systemd + nginx（Ubuntu）

下面假设域名是 `fav.example.com`，服务器已经装好 nginx 和 certbot。

1. 装 Node.js 20 以上，确认 `/usr/local/bin/node` 能用（或者改 `deploy/cyber-favorites.service` 里的路径）。
2. 建一个专用用户，把程序放到 `/srv/cyber-favorites`，数据目录用 `/var/lib/cyber-favorites`：

   ```bash
   sudo useradd --system --home /var/lib/cyber-favorites --shell /usr/sbin/nologin cyberfav
   ```

   ```bash
   sudo git clone https://github.com/visualeafsama-hub/CyberFavorites.git /srv/cyber-favorites
   ```

   ```bash
   sudo install -d -o cyberfav -g cyberfav -m 700 /var/lib/cyber-favorites
   ```

3. 复制 `deploy/env.example` 到 `/etc/cyber-favorites/env`，把 `CF_PUBLIC_URL` 改成你的网址。
4. 复制 `deploy/cyber-favorites.service` 到 `/etc/systemd/system/`，然后启动：

   ```bash
   sudo systemctl enable --now cyber-favorites
   ```

5. 参照 `deploy/nginx.conf` 配好反向代理和 HTTPS 证书。注意上传文件需要 `client_max_body_size`，实时刷新需要 `proxy_buffering off`。
6. 看日志拿第一次的登录链接：

   ```bash
   sudo journalctl -u cyber-favorites -n 30
   ```

更新版本：`git pull` 之后 `sudo systemctl restart cyber-favorites`。

### 用 Docker

改好 `docker-compose.yml` 里的 `CF_PUBLIC_URL`，然后：

```bash
docker compose up -d
```

```bash
docker compose logs
```

日志里有第一次的登录链接。容器只映射到本机的 4170 端口，前面还是要用 nginx 或 Caddy 做 HTTPS。

## 让 AI 使用

把 `skill/cyber-favorites` 文件夹复制到 Claude Code 的 skills 目录（`~/.claude/skills/`）。连服务器的话，再设置两个环境变量：

| 变量 | 值 |
|---|---|
| `CF_URL` | 服务器网址，例如 `https://fav.example.com`。不设置就连本机 |
| `CF_TOKEN` | 在 **设置 → API 令牌** 里生成的令牌 |

之后就可以这样说：

- “收藏这个：https://github.com/xxx/yyy，放到 AI 工具分组，以后做爬虫用”
- “我之前存过一个能把网页转 markdown 的 MCP，帮我找找”
- “把这个文件存进收藏夹：D:\资料\周报.docx”
- “帮我整理一下收藏夹的标签，把意思重复的合并掉”
- “把收藏夹换成暗色，卡片改成列表”

其他能发 HTTP 请求的 AI 工具也可以用，接口说明见 [SKILL.md](skill/cyber-favorites/SKILL.md)，或者打开 `/api`。

## 配置

都是环境变量，都可以不设：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CF_PUBLIC_URL` | 空 | 设置后就是服务器模式。写完整网址，例如 `https://fav.example.com` |
| `CF_PORT` | `4170` | 端口 |
| `CF_HOST` | `127.0.0.1` | 监听地址。本机模式只能是本机地址；服务器模式在 nginx 后面也建议保持 `127.0.0.1` |
| `CF_DATA` | `~/.cyber-favorites/data.json` | 数据文件位置。上传的文件放在同目录的 `files/` 里，登录信息在 `auth.json` |
| `CF_MAX_UPLOAD_MB` | `50` | 单个上传文件的上限 |
| `CF_TOKEN` | 空 | 服务器模式的主令牌，至少 24 个字符。设置后可以在登录页直接输入它登录，AI 也能用它。一般不需要，用设置里生成的令牌更好管理 |
| `CF_ALLOWED_HOSTS` | 空 | 除了 `CF_PUBLIC_URL` 和本机地址以外，还允许哪些 Host 访问，逗号分隔 |
| `GITHUB_TOKEN` | 空 | 抓取 GitHub 信息时使用。不设置的话 GitHub 限制每小时 60 次请求 |

## 安全

- 只接受自己的域名（`CF_PUBLIC_URL`）和本机地址作为 Host，挡住 DNS 重绑定：恶意网页没法把自己的域名指向你的收藏夹再来读写它。
- 拒绝来自其他网站的跨站请求。上传接口不接受表单类型，网页表单没法替你上传文件。
- 上传的文件只有图片会在页面里显示，其他类型（包括 html、svg）一律作为下载返回，不会在你的域名下执行。
- 页面带内容安全策略（CSP），只加载自己的脚本。
- 服务器模式的登录凭证在服务器上只存哈希；登录 Cookie 是 HttpOnly 的，网页脚本读不到。猜登录码连续错 10 次会被限制 15 分钟。

## 数据

所有数据都在 `CF_DATA` 所在的目录里：`data.json` 是收藏记录，`files/` 是上传的文件，`auth.json` 是登录信息（只有服务器模式有）。备份时把整个目录复制走就行。写入时先写临时文件再改名，程序中途崩溃不会把文件写坏。

## 开发

```bash
npm run dev
```

修改代码后会自动重启。

```bash
npm test
```

会在临时目录分别启动本机模式和服务器模式，把主要功能和安全检查跑一遍，不访问外网。

| 位置 | 内容 |
|---|---|
| `server.js` | HTTP 服务、路由、登录、文件下载、启动 |
| `lib/config.js` | 环境变量和两种模式 |
| `lib/api.js` | 数据接口 |
| `lib/items.js` | 新建收藏：链接、文字、文件，以及三种分组方式 |
| `lib/auth.js` | 登录链接、设备会话、API 令牌 |
| `lib/store.js` | 数据读写、分组、排序 |
| `lib/files.js` | 上传文件的保存、格式识别、图片尺寸 |
| `lib/extract.js` | 从 docx / pptx / xlsx / 文本文件里抽文字 |
| `lib/meta.js` | 抓取网页和 GitHub 信息、自动分类、自动标签 |
| `lib/net.js` | 抓取网页用的请求，服务器模式下屏蔽内网地址 |
| `lib/autogroup.js` | 自动分组 |
| `lib/search.js` | 关键词打分搜索 |
| `lib/theme.js` | 主题预设和主题修改的校验 |
| `lib/launcher.js` | Windows 快捷方式和开机自启 |
| `launch.vbs` | 快捷方式用的启动器，在后台启动服务，不弹命令行窗口 |
| `public/` | 网页；`qr.js` 是二维码生成，网页和命令行共用 |
| `deploy/` | systemd、nginx 配置示例 |
| `skill/` | 给 AI 用的 Skill |
| `test/` | `npm test` |
| `scripts/make-icon.mjs` | 生成快捷方式图标 `public/icon.ico` |

## 许可证

MIT。`public/fonts/cinzel-latin.woff2` 是 Cinzel 字体，使用 SIL Open Font License 1.1，见 `public/fonts/OFL.txt`。
