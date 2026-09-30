# IE 网盘

一个**兼容 IE8+ 的在线文件上传 / 下载站**，功能刻意保持简单。

**默认开箱即用：不用登录、不用提取码，打开网页就能上传，复制链接就能下载。**

登录和提取码都是**可选开关**，需要时用环境变量打开即可：

| 开关 | 默认 | 打开后 | 关闭后 |
| --- | --- | --- | --- |
| `REQUIRE_LOGIN` | `false` | 需登录才能上传/删除 | 任何人打开即可上传 |
| `REQUIRE_CODE` | `false` | 每个文件生成 6 位数字提取码，凭码下载 | 下载链接直接可用（`/d/<id>`） |

- 上传时可设置**有效期**（默认 1 / 3 / 7 / 30 天，到期自动失效并清理文件）

**零第三方依赖**，只用 Node 内置模块，不需要 `npm install`。

---

## 一、目录结构

```
ieweb/
├── server.js              # HTTP 服务 + 全部路由
├── config.js              # 配置（优先读环境变量）
├── package.json
├── lib/
│   ├── util.js            # 提取码生成、格式化、路径安全
│   ├── multipart.js       # 自写的流式 multipart 解析（大文件边收边落盘）
│   ├── storage.js         # files.json 元数据 + 文件清理
│   └── view.js            # 服务端渲染 HTML（页面不依赖 JS 也能看）
├── public/
│   ├── style.css          # IE8 兼容样式（无 flex/grid/rgba/阴影）
│   └── app.js             # ES5 脚本（无 let/const/箭头函数/模板字符串）
├── test/
│   ├── e2e.js             # 主流程自检（自动识别当前开关模式）
│   ├── modes.js           # 四种开关组合测试
│   └── edge.js            # 边界测试（空文件、同名、断点续传等）
├── deploy/
│   ├── nginx.conf.example # Nginx 反向代理示例
│   └── ie-webdisk.service # systemd 托管示例
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── data/                  # 运行时生成：uploads/ 存文件，files.json 存元数据
```

---

## 二、本机快速开始

```bash
node server.js
```

浏览器打开 <http://localhost:3000> —— **直接就能上传**，无需登录。

想启用登录 / 提取码：

```bash
# Linux / macOS
REQUIRE_LOGIN=true REQUIRE_CODE=true ADMIN_PASSWORD=你的密码 node server.js

# Windows PowerShell
$env:REQUIRE_LOGIN='true'; $env:REQUIRE_CODE='true'; $env:ADMIN_PASSWORD='你的密码'; node server.js
```

跑自检（需服务已启动）：

```bash
node test/e2e.js     # 主流程，自动识别当前模式
node test/modes.js   # 四种开关组合，自行拉起服务
node test/edge.js    # 边界情况
```

---

## 三、1Panel 部署

### 方式 A：用 Dockerfile 构建镜像（推荐）

1. 把整个项目上传到服务器，例如 `/opt/1panel/docker/compose/ie-webdisk/`。
   在 1Panel 里：**容器 → 镜像 → 构建镜像**
   - 名称：`ie-webdisk`，标签：`latest`
   - 镜像来源：**Dockerfile**
   - 上传/选择包含 `Dockerfile` 的目录 → 确认构建

2. **容器 → 创建容器**
   - 镜像：`ie-webdisk:latest`
   - 名称：`ie-webdisk`
   - 端口：`3000` → 容器端口 `3000`（若要走反向代理，可只绑定 `127.0.0.1:3000`）
   - 重启策略：**总是重启**
   - 挂载卷：`/opt/1panel/docker/compose/ie-webdisk/data` → `/data`
   - 环境变量（默认免登录免提取码，按需开启）：
     ```
     REQUIRE_LOGIN=false          # 改 true 则需要登录
     REQUIRE_CODE=false           # 改 true 则启用 6 位提取码
     ADMIN_PASSWORD=你的强密码     # 仅 REQUIRE_LOGIN=true 时需要
     MAX_FILE_SIZE=524288000
     ```
   - 健康检查：`/healthz`（同时返回当前开关状态）

### 方式 B：容器编排（docker-compose）

**容器 → 编排 → 创建编排**，粘贴 `docker-compose.yml` 的内容即可。
默认免登录、无提取码；想开启就在 `environment` 里把 `REQUIRE_LOGIN` / `REQUIRE_CODE` 改成 `true`。
数据默认落在 `./data`，随编排目录持久化。

### 方式 C：非 Docker，用 1Panel 的 Node 运行环境

1. **运行环境 → Node.js → 创建运行环境**，选 Node 18/20。
2. **网站 → 创建网站 → Node 项目**：
   - 项目目录：项目所在目录（如 `/opt/ie-webdisk`）
   - 启动命令：`node server.js`
   - 端口：`3000`
   - 环境变量：按下面表格填，`DATA_DIR` 建议指到网站目录下的 `data`
3. 或者用 systemd：参考 `deploy/ie-webdisk.service`，把路径和密码改掉后
   `cp deploy/ie-webdisk.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now ie-webdisk`。

### 反向代理 + HTTPS

在 1Panel **网站 → 反向代理**里指向 `http://127.0.0.1:3000`。

> ⚠️ **大文件上传必做**：Nginx 默认只允许 1MB 请求体，超过会返回 **413**。
> 需要在网站配置里放开（1Panel 的「配置文件」中修改）：
>
> ```nginx
> client_max_body_size 500m;   # 必须 >= 应用侧 MAX_FILE_SIZE
> client_body_timeout 600s;
> location / {
>     proxy_pass http://127.0.0.1:3000;
>     proxy_set_header Host $host;
>     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
>     proxy_set_header X-Forwarded-Proto $scheme;
>     proxy_request_buffering off;
>     proxy_read_timeout 600s;
>     proxy_send_timeout 600s;
> }
> ```
>
> 完整示例见 `deploy/nginx.conf.example`。
> 应用在收到 `X-Forwarded-Proto: https` 时会自动给 Cookie 加 `Secure`，所以 HTTPS 站点直接可用。

---

## 四、配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REQUIRE_LOGIN` | `false` | **是否需要登录**：`true` 需登录才能上传/删除，`false` 任何人可上传 |
| `REQUIRE_CODE` | `false` | **是否需要提取码**：`true` 生成 6 位数字提取码，`false` 用直链下载 |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录（上传文件 + `files.json`），**容器里务必挂载** |
| `ADMIN_USER` | `admin` | 管理员用户名（仅 `REQUIRE_LOGIN=true` 时生效） |
| `ADMIN_PASSWORD` | `admin123` | 管理员密码，**启用登录时务必修改** |
| `USERS` | 空 | 附加账号，格式 `用户名:密码,用户名:密码` |
| `MAX_FILE_SIZE` | `524288000` | 单文件上限（字节），默认 500MB |
| `EXPIRE_DAYS` | `1,3,7,30` | 有效期下拉可选值（天） |
| `DEFAULT_EXPIRE_DAYS` | `7` | 有效期默认选中值 |
| `RATE_WINDOW_MS` | `60000` | 限流窗口（毫秒） |
| `RATE_MAX` | `30` | 窗口内单 IP 最大请求次数（防提取码爆破） |

> 布尔开关写法：`1 / true / yes / on` 为开，`0 / false / no / off` 为关。

---

## 五、使用流程

### 默认模式（免登录、无提取码）

1. 打开站点 → 选择文件 → 选**有效期** → 点**上传**。
2. 上传完成后页面显示**下载地址**，点「复制链接」发给对方。
3. 对方打开 `http://你的域名/d/<文件ID>` **直接下载**，无需任何输入。

### 启用提取码（`REQUIRE_CODE=true`）

1. 上传完成后页面显示 **6 位提取码**。
2. 点「复制链接+提取码」把「链接 + 提取码」一起发给对方。
3. 对方打开链接，提取页显示文件信息，点「下载文件」。
   - 只有链接没有提取码时，在 `/s/` 页面手工输入 6 位数字。
   - 缺提取码直接访问下载地址会跳回提取页。

### 启用登录（`REQUIRE_LOGIN=true`）

1. 未登录访问首页会跳到 **登录页**，用 `ADMIN_USER` / `ADMIN_PASSWORD` 登录。
2. 登录后才能上传、删除。下载依旧**不需要登录**（拿到链接的人可直接下载）。
3. 右上角「退出」结束会话（session 有效期 8 小时）。

### 通用

- 上传通过隐藏 iframe 提交，IE8 下不会刷新页面、不用 FormData。
- 控制台「文件列表」里可以随时**打开 / 复制链接 / 删除**；删除后链接立即失效。
- 有效期到了以后：直接访问下载地址返回 **410 已过期**；服务每小时自动清理一次过期文件，启动时也会清一次。

---

## 六、IE 兼容性做法

| 项目 | 做法 |
| --- | --- |
| 文档模式 | 输出 `<meta http-equiv="X-UA-Compatible" content="IE=edge" />`，避免 IE 掉进兼容视图 |
| 页面渲染 | **全部服务端渲染**，禁用 JS 也能看到完整内容和表单 |
| 布局 | 只用 `float` + 定宽 + 表格，不用 flex / grid；CSS 里不使用 `rgba()`、`box-shadow`、`border-radius` 依赖 |
| 脚本 | 纯 ES5：`var`、`function`、字符串拼接；不出现 `let/const`、箭头函数、模板字符串、`Promise`、`fetch` |
| Ajax | 优先 `XMLHttpRequest`，兜底 `ActiveXObject('Microsoft.XMLHTTP')`；`JSON.parse` 缺失时用 `eval` 兜底 |
| 无刷新上传 | 表单 `target` 指向隐藏 `iframe`，子页面回调用 `window.parent.__uploadDone` 通知父页（IE8 原生支持） |
| 事件绑定 | `attachEvent` / `onload` 兼容分支 |
| 复制到剪贴板 | 优先 `window.clipboardData.setData('Text', ...)`，其次 `document.execCommand('copy')`，最后 `window.prompt` |
| 中文文件名下载 | `Content-Disposition` 同时给 ASCII 回退名与 RFC 5987 的 `filename*=UTF-8''...`，IE 与 Chrome/Edge 都能正确命名 |
| 下载体验 | 支持 `Range` 断点续传（`Accept-Ranges` / `206 Partial Content`），IE 下载器和下载工具都能续传 |
| 窄屏 | 用 `@media` 做响应式；IE8 忽略 media query，仍按桌面布局正常显示 |

> 提示：IE8 上传大文件受其自身限制（单请求、无进度条），代码层面已按最保守方式实现。
> 若客户用 IE11 或 Edge，体验与 Chrome 一致。

---

## 七、接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 首页（上传 + 文件列表）。需登录模式下未登录会跳转 `/login` |
| GET/POST | `/login` | 登录页 / 提交登录（仅 `REQUIRE_LOGIN=true` 时有效） |
| GET | `/logout` | 退出登录 |
| GET | `/d/<id>` | **直链下载**（未开启提取码时使用） |
| GET | `/download/<id>` | 下载（开启提取码时需带 `?code=<code>`） |
| GET | `/s/<code>` | 提取页（仅开启提取码时有效） |
| GET | `/s/?code=123456` | 手工输入提取码 |
| POST | `/api/upload` | 上传（multipart：`file`、`expireDays`） |
| GET | `/api/files` | 文件列表 JSON |
| POST | `/api/delete` | 删除文件（`id`） |
| GET | `/healthz` | 健康检查（同时返回当前开关状态），供 1Panel / Docker 探活 |

---

## 八、常见问题

**Q：上传大文件报 413 / 传不上去？**
Nginx 的 `client_max_body_size` 太小。改成不小于 `MAX_FILE_SIZE`（例如 `500m`）后重载 Nginx。

**Q：重启容器后文件没了？**
没挂载数据卷。必须把宿主目录挂到容器的 `/data`（`DATA_DIR`）。

**Q：提取码一直提示错误？**
确认是 6 位纯数字；另外有效期已过的文件会被清理，属于预期行为。
同一 IP 每分钟超过 `RATE_MAX` 次提取请求会被限流（提示「访问过于频繁」），稍等再试。

**Q：数据怎么备份？**
整个 `data/` 目录拷走即可：`files.json` 是元数据，`uploads/` 是文件本体，两者必须一起备份。

**Q：怎么开启登录 / 提取码？**
设环境变量 `REQUIRE_LOGIN=true` / `REQUIRE_CODE=true` 后重启即可，两者独立，可只开一个。
1Panel 里在容器的「环境变量」中加，或改 `docker-compose.yml` 后重新部署。

**Q：为什么是明文密码？**
按「简单一点」的要求，账号写在环境变量里（不做数据库和用户体系）。
若要多账号，用 `USERS=zhang:密码,li:密码` 追加即可。
**启用登录时请务必**：改掉默认密码、只开放 HTTPS。

**Q：免登录模式下谁都能删文件，安全吗？**
这是**默认设置的取舍**——按需求「直接上传/下载」，所以默认完全开放，适合内网/临时分享。
要放到公网请打开 `REQUIRE_LOGIN=true`，并建议同时打开 `REQUIRE_CODE=true`。

---

## 九、已验证项

`node test/modes.js`（48 项，四种开关组合全通过）：

- 默认模式：免登录首页即上传页、不显示登录入口、上传不生成提取码、分享链接为 `/d/<id>` 直链、直链可直接下载
- 仅提取码：生成 6 位数字码、分享链接为 `/s/<code>`、缺码下载跳回提取页、`/s/` 显示输入框
- 仅登录：未登录跳转 `/login`、登录后可上传、下载仍无需登录
- 全开：登录 + 提取码同时生效
- 四种组合下：上传/下载内容一致、删除后 404

`node test/e2e.js`（自动识别当前模式，默认模式 27 项 / 全开模式 33 项全通过）：
中文文件名、有效期计算、非法有效期回落、大文件哈希一致、`Content-Disposition`、断点续传、路径穿越防护、前端资源确认为 IE 兼容写法。

`node test/edge.js`（18 项全通过）：
空文件（**回归测试**：曾经会导致进程崩溃，现已修复）、同名文件不覆盖、特殊字符文件名、断点续传与 416 越界、重复删除 404。

环境变量全链路已验证：端口、开关、账号、附加账号、`DATA_DIR`、`EXPIRE_DAYS`、`MAX_FILE_SIZE`。
畸形 URL / 非法百分号编码不会导致进程崩溃（另有 `uncaughtException` 兜底）。