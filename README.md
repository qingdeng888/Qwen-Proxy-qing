# Qwen-Proxy

<p align="center">
  <strong>通义千问 OpenAI / Anthropic / Gemini 三协议兼容代理</strong><br>
  支持 Vercel / Docker / Northflank / Render 一键部署，零持久化存储
</p>

<p align="center">
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FGit-think%2FQwen-Proxy&env=API_KEY,ACCOUNTS&envDescription=API_KEY%3A%20API%E5%AF%86%E9%92%A5%EF%BC%8CACCOUNTS%3A%20%E8%B4%A6%E5%8F%B7(email%3Apassword)&project-name=qwen-proxy&repository-name=Qwen-Proxy"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>
  &nbsp;
  <a href="https://app.netlify.com/start/deploy?repository=https://github.com/Git-think/Qwen-Proxy"><img src="https://www.netlify.com/img/deploy/button.svg" alt="Deploy to Netlify" /></a>
</p>

<p align="center">
  <a href="#功能特性">功能</a> •
  <a href="#快速开始">快速开始</a> •
  <a href="#部署指南">部署</a> •
  <a href="#技术架构">架构</a> •
  <a href="#api-接口文档">API 文档</a>
</p>

---

## 功能特性

| 功能 | 说明 |
|------|------|
| **三协议兼容** | 同一后端同时暴露 OpenAI / Anthropic Messages / Google Gemini 三种 API 格式 |
| **Tool Calling** | Qwen3.x 模型原生支持 Function Calling，工具调用通过上下文传递，模型自动识别并生成结构化调用 |
| **多账号轮询** | 最近最少使用 (LRU) 调度 + 失败冷却机制 + 自动故障转移 |
| **自动刷新** | 用户名密码登录，每 6 小时自动重新登录刷新 JWT Token |
| **流式输出** | 完整 SSE 流式响应，兼容 `stream: true` |
| **思维链** | 推理模型通过 OpenAI 标准 `reasoning_content` 字段输出，模型名加 `-thinking` 后缀启用 |
| **联网搜索** | 搜索增强生成，模型名加 `-search` 后缀，返回来源引用 |
| **图片生成** | 文生图 `/v1/images/generations`，支持多种尺寸 |
| **图片编辑** | `/v1/images/edits`，支持 multipart 上传 |
| **视频生成** | 文生视频 `/v1/videos` |
| **反爬绕过** | 内置 ssxmod 浏览器指纹 Cookie 自动生成，每 15 分钟刷新 |
| **代理支持** | HTTP / HTTPS / SOCKS5 代理 |
| **Vercel 部署** | 部署即同时构建前端 + Serverless 后端 |
| **Docker 部署** | 多阶段 Alpine 镜像构建 |
| **Northflank 部署** | 一键 GitHub + 持久卷，长期运行容器，免自建 VPS |
| **管理面板** | React 暗色主题面板 + 内置聊天（支持版本化重试） + 交互式 API 文档 |

---

## 快速开始

### 1. 安装

```bash
git clone https://github.com/Git-think/Qwen-Proxy.git
cd Qwen-Proxy
npm install
cd webui && npm install && cd ..
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```bash
# 必填
API_KEY=sk-your-key-here
ACCOUNTS=your-email@example.com:your-password

# 可选
SERVICE_PORT=3000
DATA_SAVE_MODE=none
LOG_LEVEL=INFO
```

### 3. 构建前端 + 启动

```bash
npm run build:webui   # 构建前端到 webui/dist/
npm start             # 生产模式（同时托管前端 + 后端）
npm run dev           # 开发模式（自动重启后端）
```

前端开发模式：`cd webui && npm run dev`（默认 5173，已配置代理转发到 3000）。

访问 `http://localhost:3000` 查看管理面板。

### 4. 测试

OpenAI 格式：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-plus","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

Anthropic 格式：

```bash
curl http://localhost:3000/v1/messages \
  -H "x-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-plus","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

Gemini 格式：

```bash
curl "http://localhost:3000/v1beta/models/qwen3.6-plus:generateContent" \
  -H "x-goog-api-key: sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```

---

## 部署指南

### Vercel 一键部署（推荐）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FGit-think%2FQwen-Proxy&env=API_KEY,ACCOUNTS&envDescription=API_KEY%3A%20API%E5%AF%86%E9%92%A5%EF%BC%8CACCOUNTS%3A%20%E8%B4%A6%E5%8F%B7(email%3Apassword)&envLink=https%3A%2F%2Fgithub.com%2FGit-think%2FQwen-Proxy%23%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F&project-name=qwen-proxy&repository-name=Qwen-Proxy)

点击按钮后：
1. Vercel 会自动 fork 仓库到你的 GitHub
2. 填写环境变量：
   - `API_KEY` — 你的 API 密钥（如 `sk-xxx`）
   - `ACCOUNTS` — 通义千问账号（如 `email@example.com:password`，多个用逗号分隔）
3. 点击 Deploy，等待部署完成

`vercel.json` 自动执行：
- `cd webui && npm install && npm run build` 构建前端到 `webui/dist`
- `api/index.js` 作为 Serverless Function 处理所有 API 请求
- SPA 路由 fallback 到 `index.html`

`DATA_SAVE_MODE` 默认为 `none`，所有状态保存在内存中，冷启动时自动登录获取 Token。

#### 启用 Vercel 同步面板（可选）

部署后可在 Web 面板里直接管理 Vercel 环境变量并一键重新部署，需要再添加 2 个环境变量：

| 变量 | 必需 | 获取方式 |
|---|---|---|
| `VERCEL_TOKEN` | 是 | [vercel.com/account/tokens](https://vercel.com/account/tokens) 创建 Personal Token |
| `VERCEL_PROJECT_ID` | 是 | 项目 Settings → General → Project ID |
| `VERCEL_TEAM_ID` | 否 | 仅团队账户需要；个人账户留空 |

> Vercel 在 runtime 不会自动注入 `VERCEL_PROJECT_ID`（不同于 `VERCEL` / `VERCEL_ENV` / `VERCEL_URL`），必须手动在 Settings → Environment Variables 里添加。

配置完成后重新部署一次，左侧导航会出现 **Vercel 同步** 入口。

> 💡 **Vercel 同步是可选的**：它的主要用途是把 `ACCOUNTS` 写回 Vercel env 让重部署后保留。如果你已经用了 `DATA_SAVE_MODE=redis`，账号和代理状态直接持久化在 Redis，通过管理面板（`/admin`）就能增删账号——**不需要再配 Vercel 同步**。Redis 模式更通用，跨平台一致。两种方式二选一。

### Docker 部署（推荐自部署方式）

镜像采用三阶段构建：① 装后端生产依赖 → ② 构建 webui 前端 → ③ 拼装运行时镜像。最终镜像里同时包含后端服务和已构建的管理面板（`webui/dist`），开箱即用。

#### 一键启动（compose）

```bash
# 1. 准备环境变量
cp .env.example .env
# 编辑 .env，至少填好 API_KEY 和 ACCOUNTS

# 2. 启动
docker compose up -d

# 3. 查看日志
docker compose logs -f

# 4. 访问管理面板
# 浏览器打开 http://localhost:3000
# 用 .env 里的 API_KEY 登录
```

`docker-compose.yml` 默认配置：
- `DATA_SAVE_MODE=file`，账号 token、代理池状态、运行时 API Key、用量统计全部持久化到 `./data/data.json`
- `./data` 与 `./logs` 已挂为本机卷，容器重启或镜像重建数据都不丢
- 透传所有可选环境变量（`PROXIES`、`PROXY_MAX_RETRIES`、`DISABLED_ACCOUNTS`、`OUTPUT_THINK`、`SEARCH_INFO_MODE`、`QWEN_CHAT_PROXY_URL` 等），有就用，没有就走默认值
- 内置 `/health` 健康检查

#### 数据持久化（JSON 文件，无需 Redis）

`data/data.json` 单文件存储以下五块数据：

| 字段 | 内容 |
|---|---|
| `accounts` | 账号列表（含刷新后的 token、过期时间、`disabled` 标记、每账号代理模式） |
| `proxyBindings` | 账号 ↔ 代理 的绑定关系 |
| `proxyStatuses` | 每个代理的最新健康状态（untested / available / failed） |
| `apiKeys` | Web 面板里运行时增删的 API Key（admin key 除外） |
| `usage` | 每个 API Key / 每个 Qwen 账号的累计请求数、token 用量、最近使用时间 |

> 自部署/Docker 场景下推荐 `DATA_SAVE_MODE=file`，**不需要 Redis**。Redis 模式只对 Vercel / Netlify 这种无持久磁盘的 serverless 平台有意义。

#### 手动 docker run（不用 compose）

```bash
docker build -t qwen-proxy .
docker run -d --name qwen2api \
  -p 3000:3000 \
  -e API_KEY=sk-your-key \
  -e ACCOUNTS=email:password \
  -e DATA_SAVE_MODE=file \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  qwen-proxy
```

#### 升级

```bash
git pull
docker compose build --no-cache   # 强制重新构建前端
docker compose up -d
```

仓库已配置 GitHub Actions 自动构建并发布镜像到 GHCR / Release，详见 [.github/workflows](.github/workflows/)。

### Northflank 部署（推荐：白嫖友好 + 长期运行 + 持久卷）

Northflank 是一个支持原生 Docker 构建 + 持久卷的 PaaS，注册即送试用额度，**适合需要长期运行 + 数据持久化但又不想自己买 VPS 的场景**。和 Vercel/Netlify 不同，它跑的是真正的容器（不是 serverless 冷启动），所以可以直接用本仓库默认的 `DATA_SAVE_MODE=file` + `data.json`，不需要额外配 Redis。

两种部署路径，按需选一种：

- **路径 A — 用 Docker Hub 预构建镜像**（30 秒部署，不用 fork、不用源码、不用本地构建）
- **路径 B — 从 GitHub 源码构建**（自己改了代码或想跟踪某个 fork 的 main）

#### 前置准备

- [northflank.com](https://northflank.com) 注册账号并完成邮箱验证
- 路径 B 还需要：把本仓库 fork 到你的 GitHub，并在 Northflank 顶栏 **Account → Connected accounts** 授权 GitHub

#### 步骤 1 — 创建 Project

进入 Northflank dashboard → 左上角 **Create new** → **Project** →
- Name: `qwen-proxy`（或任意）
- Region: 选最靠近你客户端的（亚太用户推荐 `asia-southeast1` / `asia-northeast1`）
- 创建

---

#### 路径 A — 用 Docker Hub 预构建镜像（推荐）

镜像：[`qingdeng/qwen-proxy:2026518`](https://hub.docker.com/r/qingdeng/qwen-proxy)（webui 已经构建进去，开箱即用）。

进 Project → **Create new** → **Service** → **Deployment service**（部署服务，只跑现成镜像，不构建），不要选 Combined。

**Deployment source（部署源）：**
- 选 **External image**
- Image path: `qingdeng/qwen-proxy:2026518`
- 公共镜像，**不需要** Registry credentials；如果以后改用自己的 Docker Hub 私有镜像，去 Northflank 顶栏 **Account → Registries → Add registry** 先添加凭据，再回这里选

> 💡 想跟最新版？把 tag 换成 `qingdeng/qwen-proxy:latest`。但**生产环境推荐用具体的日期 tag**（如 `2026518`），避免哪天 latest 出问题。

**Resources（资源）：**
- 选 **nf-compute-20**（0.5 vCPU / 512 MB）就够用；账号多 / 并发高可以选 nf-compute-50
- Instances: `1`

**Networking（端口）：**
- Add port `3000`，protocol **HTTP**，**勾选 "Publicly expose this port to the internet"**
- 自动分配的 HTTPS 域名形如 `https://<service>--<project>--<team>.code.run`

**Environment variables（环境变量，⚠ 关键）：**

| Key | Value | 说明 |
|---|---|---|
| `API_KEY` | `sk-your-api-key-here` | **必填**，登录管理面板和调用 API 都用它 |
| `ACCOUNTS` | `email@example.com:password` | **必填**，多个用英文逗号分隔 |
| `SERVICE_PORT` | `3000` | 必填且必须等于上面 Networking 里加的端口号 |
| `DATA_SAVE_MODE` | `file` | **必填**，启用 JSON 持久化（配合下面的 volume） |
| `LOG_LEVEL` | `INFO` | 可选，调试时改 `DEBUG` |

可选项（按需添加，全量字段见下文 [环境变量](#环境变量)）：

| Key | 示例值 | 说明 |
|---|---|---|
| `PROXIES` | `socks5://1.2.3.4:1080,http://user:pass@5.6.7.8:8080` | 智能代理池，逗号分隔；启动后也能在面板里加 |
| `PROXY_URL` | `http://127.0.0.1:7890` | 单代理（legacy，会合并进 `PROXIES`） |
| `PROXY_MAX_RETRIES` | `3` | 代理失败时的重试次数 |
| `DISABLED_ACCOUNTS` | `bad@x.com,old@y.com` | 启动时禁用的账号（逗号分隔），后续可在面板里改 |
| `OUTPUT_THINK` | `false` | 是否把 thinking 内容输出 |
| `SEARCH_INFO_MODE` | `text` | 联网搜索结果格式 `text` / `table` |
| `SIMPLE_MODEL_MAP` | `false` | 简化模型列表（不要带后缀的变体） |
| `QWEN_CHAT_PROXY_URL` | `https://chat.qwen.ai` | 改用自定义反代 Qwen 端点 |
| `ENABLE_FILE_LOG` | `false` | 写日志文件到 `/app/logs`（需配合下面第二个 volume） |

填写方法：Environment 区域 → **Add variable** → 一条条填 Key/Value（敏感的可以选 `Secret type`，仅在容器内可见）。也可以点 **Bulk edit** 一次性粘贴：

```env
API_KEY=sk-your-api-key-here
ACCOUNTS=email@example.com:password
SERVICE_PORT=3000
DATA_SAVE_MODE=file
LOG_LEVEL=INFO
PROXIES=
PROXY_MAX_RETRIES=3
DISABLED_ACCOUNTS=
QWEN_CHAT_PROXY_URL=https://chat.qwen.ai
```

> ⚠ **不要设 `LISTEN_ADDRESS`** ——Northflank 默认就绑 `0.0.0.0`，自己设可能反而绑错。
>
> ⚠ **`DATA_SAVE_MODE` 一定要是 `file`**，不要留空 / 写 `none`，否则下面的持久卷挂了也不会写盘。

**Advanced → Persistent volume（持久卷，⚠ 关键步骤）：**

- 点 **Add persistent volume**
- Container mount path: `/app/data`（**必须**这个路径，data.json 写在这里）
- Storage size: `1 GB`
- 创建

> ⚠ **不挂卷的话**，每次 redeploy / 重启容器，`data.json`（账号 token、代理状态、运行时 API Key、用量统计）全部清空。Northflank 默认容器是 ephemeral 的，必须手动加 volume 才能持久化。

可选第二个卷 `/app/logs`（仅当 `ENABLE_FILE_LOG=true` 时需要）。

**Health check（健康检查）：**

- Type: **HTTP**
- Path: `/health`
- Port: `3000`

点 **Create service**，Northflank 会拉镜像（首次约 30-60 秒）→ 启动容器 → 健康检查通过后亮绿灯。

#### 路径 A 升级新版本

镜像作者推了新 tag（比如 `qingdeng/qwen-proxy:2026601`）后：

1. Service → **Settings → Image** → 把 tag 改成新版本号 → **Save**
2. Northflank 自动滚动重启（持久卷数据保留）

如果用的是 `:latest` tag，可以直接 **Service → Restart with latest image** 强制拉一次新镜像。

---

#### 路径 B — 从 GitHub 源码构建

进 Project → **Create new** → **Service** → **Combined service**（同时管构建 + 运行）。

**Source（代码源）：**
- 选 **Repository**
- Account: 你的 GitHub
- Repository: 选你 fork 后的 `Qwen-Proxy`
- Branch: `main`（或你部署用的分支）
- Build context: `/`

**Build（构建）：**
- Build type: **Dockerfile**
- Dockerfile path: `./Dockerfile`（仓库自带的三阶段构建，自动构建 webui）

剩下的 **Resources / Networking / Environment / Persistent volume / Health check** 部分**跟路径 A 完全一样**（用一样的环境变量表，挂一样的 `/app/data` 卷）。

点 **Create service** → 拉代码 → 跑 Dockerfile（约 2-4 分钟）→ 启动 → 绿灯。

#### 路径 B 升级和自动部署

- 进 Service → **Settings → Continuous deployment** → 勾选 **Auto-deploy on push**，之后每次 `git push` 到部署分支会自动重建 + 部署，环境变量和 volume 都保留
- 也可以手动 **Service → Build & deploy** 触发一次

---

#### 步骤 3 — 验证服务

不论走哪条路径，服务亮绿后：
- 浏览器打开 Networking 页面给的 HTTPS 域名 → 应该看到管理面板
- 用 `API_KEY` 登录 → 进 **管理** 页面应该能看到从 `ACCOUNTS` env 加载的账号
- 跑一次请求：

```bash
curl https://<your-domain>.code.run/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-plus","messages":[{"role":"user","content":"你好"}]}'
```

#### 步骤 4 — 验证持久化（关键）

这是 Northflank 部署最容易踩坑的环节，务必验证一次：

1. 在管理面板新增一个测试账号，或在用量页面让计数器 +1
2. 顶栏 **Service → Restart**（强制重启容器）
3. 重启完成后刷新管理面板 → 数据**应该还在**

如果数据丢了，去 **Service → Volumes** 检查：
- Container mount path 必须是 `/app/data`
- Status 必须是 `Mounted`
- 重新挂卷或确认 `DATA_SAVE_MODE=file`

#### 维护和排错

- **改环境变量**：Service → Environment → 改完点 **Save** → 自动滚动重启，volume 数据保留
- **查看日志**：Service → Logs（实时 + 历史）。启动后应该看到 `Account manager initialized, loaded N accounts`，没看到说明 `ACCOUNTS` 没填对
- **进容器调试**：Service → Containers → Shell（web 终端）。`ls /app/data` 看看有没有 `data.json`
- **数据丢失**：99% 是 `DATA_SAVE_MODE` 没设成 `file`，或者 volume mount path 不是 `/app/data`

#### 成本

Northflank 注册即送试用额度（按 vCPU·小时 + 内存·小时 + 存储·GB-月 计费），nf-compute-20 (0.5 vCPU / 512 MB) + 1 GB volume 长期跑 1 个实例，单月成本通常在试用额度内或非常小（具体见 [Northflank Pricing](https://northflank.com/pricing)）。

> 💡 **为什么推荐 Northflank 而不是 Render 免费版？** Render 免费 Web Service 没有持久磁盘、容器休眠，不适合本项目。Northflank 容器长期运行 + 原生支持 volume，配 `DATA_SAVE_MODE=file` 体验和自家 VPS 一样。

### Render 部署

1. 创建 **Web Service**，连接 GitHub
2. Build Command: `npm install && npm run build:webui`
3. Start Command: `npm start`
4. 环境变量：`API_KEY`、`ACCOUNTS`

> ⚠️ **Render 免费版无持久磁盘**（容器休眠 / 重启即清空），`DATA_SAVE_MODE=file` 会丢数据。免费版部署强烈建议 `DATA_SAVE_MODE=redis` + Upstash（见下文 [数据持久化模式](#数据持久化模式)）。Render 付费 Disks 服务才支持 file 模式。

### Netlify 部署

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Git-think/Qwen-Proxy)

点按钮后 Netlify 会要求授权 GitHub、fork 仓库、选择团队，最后跳到 Site Configuration 页让你填环境变量。仓库自带 `netlify.toml`，构建会自动：
- 安装根 + `webui/` 依赖，构建前端到 `webui/dist`
- 把 `netlify/functions/api.js`（用 `serverless-http` 包 Express）作为 Functions 入口
- 把所有 `/v1/*` `/v1beta/*` `/anthropic/*` `/api/*` `/verify` `/health` 重定向到该 Function，其余路径回退到 SPA `index.html`

环境变量需要的设置（Site → Environment variables）：
```
API_KEY=sk-your-api-key-here
ACCOUNTS=your-email@example.com:your-password
DATA_SAVE_MODE=redis      # Netlify Functions 也是无持久磁盘
REDIS_URL=https://...      # Upstash 或兼容 HTTP Redis
REDIS_TOKEN=...
```

> ⚠️ **Netlify Functions 无持久磁盘**，与 Vercel 同理；务必用 `redis` 模式。

### 其他平台（Railway / Fly.io）

Node.js 18+，先 `npm run build:webui` 再 `npm start` 即可。

> Railway / Fly.io 默认有持久卷（volume）支持，可用 `DATA_SAVE_MODE=file`（需挂卷到 `data/`）；嫌麻烦也可以直接用 `redis` 模式，跨平台一致。Northflank 用法见上文 [Northflank 部署](#northflank-部署推荐白嫖友好--长期运行--持久卷)。

> Cloudflare Workers / Pages Functions 暂不支持（不是 Node.js 运行时），路线图与 workaround 见 [docs/cloudflare-workers.md](docs/cloudflare-workers.md)。

---

## 反向代理：宝塔 Nginx + Cloudflare

适用场景：你已经用 Docker 把服务跑在 VPS 的 `127.0.0.1:3000`，想用自己的域名（比如 `qwen.example.com`）暴露 API，并加上 Cloudflare 的 CDN/防护。

整体链路：

```
客户端
  ↓  HTTPS（Cloudflare 边缘节点签的证书）
Cloudflare CDN（橙云开启，可选 WAF / 限流 / Bot 防护）
  ↓  HTTPS（源站证书）
你的 VPS:443
  ↓  宝塔 Nginx 反向代理 + 流式优化
Docker 容器 127.0.0.1:3000  ←  本仓库 qwen-proxy
```

下面按部就班来。

### 步骤 1 — 容器只监听 127.0.0.1（强烈推荐）

公网直接放出 `3000` 是没必要的：所有流量都从 Nginx 进，容器只服务本机就行。改 `docker-compose.yml`：

```yaml
services:
  qwen2api:
    # ...
    ports:
      - "127.0.0.1:3000:3000"   # ← 只绑回环网卡，公网扫描不到
```

`docker compose up -d` 重启。验证：

```bash
curl -s http://127.0.0.1:3000/health   # → {"status":"ok"}
curl -s http://<服务器公网IP>:3000/health   # 应该连不上（拒绝 / 超时）
```

如果还想保留 `:3000` 公网可访问（不推荐），跳过这一步。

### 步骤 2 — Cloudflare 把域名指到你的 VPS

1. Cloudflare dashboard → 选你的域名 → **DNS → Records → Add record**
2. 加一条：
   - Type: `A`
   - Name: `qwen`（最终域名 `qwen.example.com`）
   - IPv4 address: 你的 VPS 公网 IP
   - Proxy status: **Proxied（橙色云朵开启）** ← 必开，才能用 Cloudflare 的 CDN/SSL
3. **SSL/TLS → Overview**，加密模式选 **Full (strict)**
   - `Off` / `Flexible` 不要选：前者明文，后者 Cloudflare → 你 VPS 是 HTTP，不安全
   - `Full` 也行但不强制证书有效，懒人可用；规范做法是 `Full (strict)` + 源站证书

### 步骤 3 — 申请源站证书（二选一）

#### 方式 A：Cloudflare Origin Certificate（推荐，15 年有效）

1. Cloudflare dashboard → **SSL/TLS → Origin Server → Create Certificate**
2. 默认参数（RSA 2048，包含 `*.example.com` 和 `example.com`），Validity 选 15 年
3. 生成后会给你两块文本：**Origin Certificate**（证书）和 **Private Key**（私钥）
4. 在 VPS 上保存好（路径用宝塔默认的）：

```bash
mkdir -p /www/server/panel/vhost/cert/qwen.example.com
nano /www/server/panel/vhost/cert/qwen.example.com/fullchain.pem   # 粘贴 Origin Certificate
nano /www/server/panel/vhost/cert/qwen.example.com/privkey.pem     # 粘贴 Private Key
chmod 600 /www/server/panel/vhost/cert/qwen.example.com/privkey.pem
```

> 💡 Cloudflare Origin Certificate **只对 Cloudflare 边缘节点信任**，浏览器直接访问你 VPS 公网 IP 会报证书错误——这正好是想要的，强制流量走 Cloudflare。

#### 方式 B：Let's Encrypt（如果不想信任 Cloudflare 私 CA）

宝塔面板里 **网站 → SSL → Let's Encrypt** 一键申请，需要先在 Cloudflare 把 Proxy status 临时改成 **DNS only**（灰云），签完再改回橙云。

### 步骤 4 — 宝塔创建站点 + 配置反代

1. 宝塔面板 → **网站 → 添加站点**
   - 域名：`qwen.example.com`
   - PHP 版本：纯静态（**不需要 PHP**，避免装无关组件）
   - 创建数据库：不勾
   - 创建 FTP：不勾
2. 创建后 → **设置 → SSL → 其他证书** → 把上面 fullchain.pem / privkey.pem 内容粘进去 → 保存 → **强制 HTTPS** 开启
3. **设置 → 反向代理 → 添加反向代理**：
   - 名称：`qwen-proxy`
   - 目标 URL：`http://127.0.0.1:3000`
   - 发送域名：`$host`
   - 创建

### 步骤 5 — 替换宝塔默认 Nginx 配置（关键）

宝塔自动生成的反代配置**不适合 SSE 流式**，必须手动覆盖。**网站 → 设置 → 配置文件**，把整段替换成：

```nginx
server {
    listen 443 ssl http2;
    server_name qwen.example.com;

    # SSL（路径就是步骤 3 写进去的）
    ssl_certificate    /www/server/panel/vhost/cert/qwen.example.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/qwen.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # 上传 / 请求体限制 —— 图片编辑、视频生成是 multipart 上传，留宽点
    client_max_body_size 64m;
    client_body_buffer_size 256k;

    # 把 Cloudflare 报的真实客户端 IP 透传给后端日志
    # 完整 CF IP 段见 https://www.cloudflare.com/ips/，这里是常用 v4 段
    set_real_ip_from 173.245.48.0/20;
    set_real_ip_from 103.21.244.0/22;
    set_real_ip_from 103.22.200.0/22;
    set_real_ip_from 103.31.4.0/22;
    set_real_ip_from 141.101.64.0/18;
    set_real_ip_from 108.162.192.0/18;
    set_real_ip_from 190.93.240.0/20;
    set_real_ip_from 188.114.96.0/20;
    set_real_ip_from 197.234.240.0/22;
    set_real_ip_from 198.41.128.0/17;
    set_real_ip_from 162.158.0.0/15;
    set_real_ip_from 104.16.0.0/13;
    set_real_ip_from 104.24.0.0/14;
    set_real_ip_from 172.64.0.0/13;
    set_real_ip_from 131.0.72.0/22;
    real_ip_header CF-Connecting-IP;

    location / {
        proxy_pass http://127.0.0.1:3000;

        # 转发头
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;

        # ── SSE / 流式输出关键配置 ──────────────────────────────
        # 必须关掉 nginx 的输出缓冲，否则 stream:true 的回复会卡到结束才一次性返回
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection "";        # 切到 keep-alive
        proxy_http_version 1.1;
        # 显式禁用按响应头的缓冲（Anthropic / Gemini 路径也吃这个）
        proxy_set_header X-Accel-Buffering no;

        # 长流式响应可能跑几分钟（思维链 + 长输出），把超时调大
        proxy_connect_timeout 60s;
        proxy_send_timeout    600s;
        proxy_read_timeout    600s;
        send_timeout          600s;

        # WebSocket 暂时用不到（项目没用 ws），但留着兼容未来
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $http_connection;
    }
}

# 把 :80 redirect 到 :443
server {
    listen 80;
    server_name qwen.example.com;
    return 301 https://$host$request_uri;
}
```

保存 → 宝塔会自动 `nginx -t` 校验 + reload。如果报错把错误贴回来排查。

### 步骤 6 — 验证

```bash
# 健康检查（普通 HTTP）
curl https://qwen.example.com/health
# → {"status":"ok"}

# 走 OpenAI 协议的非流式调用
curl https://qwen.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-plus","messages":[{"role":"user","content":"你好"}]}'

# 流式调用（关键：观察是不是逐 chunk 出来，不是一次性 dump）
curl -N https://qwen.example.com/v1/chat/completions \
  -H "Authorization: Bearer sk-your-api-key-here" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.6-plus","messages":[{"role":"user","content":"写一段长文"}],"stream":true}'
```

`-N` 是禁用 curl 的输出缓冲；理想情况是看到 `data: {...}` 一条条往下滚，**不是**等几十秒一次性出现。如果是后者，回去检查 `proxy_buffering off` 和 `X-Accel-Buffering no` 这两行有没有写。

### 步骤 7（可选）— Cloudflare 加固

进 Cloudflare dashboard：

| 位置 | 设置 | 说明 |
|---|---|---|
| **SSL/TLS → Edge Certificates** | Always Use HTTPS = **On** | 浏览器误打 http 也强制升级 |
| **SSL/TLS → Edge Certificates** | Min TLS Version = **1.2** | TLS 1.0/1.1 现在没人用了 |
| **Speed → Optimization → Content** | Brotli = **On** | 文本响应自动压缩 |
| **Network** | gRPC = **On** | 不用也建议开，未来扩展兼容 |
| **Network** | HTTP/2 / HTTP/3 = **On** | 默认就开，确认一下 |
| **Network** | WebSockets = **On** | 默认就开 |
| **Caching → Configuration** | Browser Cache TTL = **Respect Existing Headers** | 别让 CF 缓存 API 响应 |
| **Rules → Page Rules** 或 **Configuration Rules** | URL `qwen.example.com/*` → Cache Level = **Bypass** | **关键**，否则同一个请求可能拿到旧响应 |
| **Security → WAF** | 加自定义规则限流 | 比如 `(http.host eq "qwen.example.com")` 上加 rate-limit |

> ⚠️ **必须 Bypass 缓存**：Cloudflare 默认会试图缓存 GET 响应，本项目 `/v1/models` 之类的端点会被缓存住，新加的账号 / 模型动态加载会看不到变化。规则建一条 `qwen.example.com/*` → Cache Level = Bypass 就行。

### 排错

| 症状 | 可能原因 |
|---|---|
| `502 Bad Gateway` | 容器没起 / 没绑 127.0.0.1:3000；`docker compose ps` + `curl 127.0.0.1:3000/health` 自检 |
| `526 Invalid SSL Certificate` | Cloudflare 设了 Full (strict) 但源站证书不合法。换成 Cloudflare Origin Certificate 或 LE |
| 流式响应卡几十秒一次性返回 | `proxy_buffering off` 没写 / 没 reload；nginx 配置里漏了 `X-Accel-Buffering no` |
| 大文件 / 图片编辑 413 报错 | `client_max_body_size` 太小，调到 `64m` 或更大 |
| 跑久了客户端断 (`upstream timed out`) | `proxy_read_timeout` 太短，拉到 `600s` 或以上 |
| 后端日志看到的全是 Cloudflare IP | 没配 `set_real_ip_from` + `real_ip_header CF-Connecting-IP` |
| Cloudflare 一直返回 `Error 1016` | DNS A 记录指错 IP / 该域名被降级到 DNS only 但配置没改回 |

完成后客户端就用 `https://qwen.example.com/v1/chat/completions` 当 base URL，所有 OpenAI / Anthropic / Gemini SDK 都正常工作。

---

## 贡献

- 提交代码 / PR：见 [docs/contributing.md](docs/contributing.md)
- 提交 issue：见 [docs/issues.md](docs/issues.md)
- API 详细文档：见 [docs/api.md](docs/api.md)
- 架构与功能实现：见 [docs/architecture.md](docs/architecture.md)
- Cloudflare Workers 适配路线图：见 [docs/cloudflare-workers.md](docs/cloudflare-workers.md)

## 致谢

Tool calling 子系统的设计思路来自 **[CJackHwang/ds2api](https://github.com/CJackHwang/ds2api)**——一个用 prompt 注入 + DSML XML 解析让上游模型支持 OpenAI tools 协议的 Go 项目。本仓库参考了它的 DSML 标记选择、四级候选解析、流式 sieve 状态机思路并完整重写为 Node.js 实现，**未直接复用其代码**。感谢作者的开源工作给了我们一个可行参照。

## 友链

- **[Linux DO](https://linux.do)** —— 不一样的中文技术社区，本项目的灵感、反馈与折腾乐趣大多源自这里。

---

## 技术架构

### 系统总览

```
客户端（OpenAI SDK / Claude SDK / Gemini SDK / NextChat / ChatBox）
        │
        ▼  HTTP / SSE
┌──────────────────────────────────────┐
│  Qwen-Proxy（Express.js）             │
│                                      │
│  协议适配 → API Key 鉴权 → 格式转换 → 账号轮询 │
│        │                              │
│        ▼                              │
│  请求模块 + ssxmod Cookie + 代理      │
└────────┬─────────────────────────────┘
         │  HTTPS
         ▼
┌──────────────────────────────────────┐
│  通义千问 API（chat.qwen.ai）         │
│  登录 / 创建会话 / 聊天 / 模型列表    │
└──────────────────────────────────────┘
```

三协议适配层：所有非 OpenAI 协议（Anthropic / Gemini）请求统一在 `src/adapters/` 中转换为 OpenAI 内部表示，复用同一套上游请求与流式解析。

### 目录结构

```
项目根目录/
├── api/index.js              # Vercel Serverless 入口
├── netlify/
│   └── functions/api.js      # Netlify Functions 入口（serverless-http 包 Express）
├── netlify.toml              # Netlify build + redirects
├── docs/                     # 详细文档
│   ├── api.md                # 三协议 API 全量参考
│   ├── architecture.md       # 架构与功能实现
│   ├── contributing.md       # 提交代码 / PR 流程
│   ├── issues.md             # 提交 Issue 模板
│   └── cloudflare-workers.md # CF Workers 适配路线图
├── src/
│   ├── adapters/
│   │   ├── anthropic.js      # Anthropic ↔ OpenAI 转换 + SSE 重写
│   │   └── gemini.js         # Gemini ↔ OpenAI 转换 + SSE 重写
│   ├── config/index.js       # 环境变量配置（含代理列表 / 禁用账号）
│   ├── controllers/          # 控制器（聊天、图片视频、模型）
│   ├── middlewares/          # 中间件（鉴权、tool-call gate、格式转换）
│   ├── models/models-map.js  # 动态模型获取与缓存
│   ├── routes/
│   │   ├── chat.js           # /v1/chat/completions、images、videos
│   │   ├── anthropic.js      # /v1/messages、/anthropic/v1/messages
│   │   ├── gemini.js         # /v1(beta)/models/{model}:generate*
│   │   ├── models.js         # /v1/models
│   │   ├── accounts.js       # /api/* 账号 + 智能代理 + 禁用切换
│   │   ├── verify.js         # /verify
│   │   └── vercel.js         # Vercel 同步面板辅助接口
│   ├── utils/
│   │   ├── account.js        # 账号管理器（核心单例 + 禁用切换）
│   │   ├── account-rotator.js # LRU 负载均衡（跳过 disabled）
│   │   ├── token-manager.js  # Token 登录/验证/刷新
│   │   ├── data-persistence.js # 存储层（none / file / redis）
│   │   ├── redis-client.js   # Upstash REST Redis 客户端
│   │   ├── proxy-helper.js   # http(s) / socks5 代理 agent 工厂
│   │   ├── proxy-pool.js     # 智能代理池（四级优先 + 故障转移 + 持久化）
│   │   ├── vercel-sync.js    # 把代理 / 禁用列表 写回 Vercel env（serverless 持久化）
│   │   ├── request.js        # 上游 HTTP 请求 + 代理重试循环
│   │   ├── toolcall.js       # DSML tool-call prompt + 流式 sieve + JSON repair
│   │   ├── chat-helpers.js   # 消息解析与模型匹配
│   │   ├── cookie-generator.js # ssxmod Cookie（LZW 压缩）
│   │   ├── fingerprint.js    # 浏览器指纹合成
│   │   ├── ssxmod-manager.js # Cookie 生命周期（15分钟刷新）
│   │   ├── upload.js         # 阿里云 OSS 上传
│   │   ├── precise-tokenizer.js # token usage 估算
│   │   ├── logger.js         # 日志
│   │   └── tools.js          # SHA-256 / JWT / UUID
│   ├── server.js             # Express 应用
│   └── start.js              # 启动器
├── webui/                    # React 前端（Vite + Tailwind）
│   ├── src/
│   │   ├── pages/            # Login / Chat / Admin / Docs / Vercel
│   │   ├── components/       # Sidebar / AccountCard / MessageBubble / ...
│   │   ├── hooks/            # useChat / useApi / useToast
│   │   └── utils/            # api / storage / constants / markdown
│   ├── vite.config.js        # 构建期 inject 版本号
│   └── package.json
├── vercel.json               # Vercel build + SPA rewrites
├── Dockerfile
├── docker-compose.yml
├── .github/workflows/        # docker-build / release / quality-gates
├── package.json              # 改 version 即触发 release.yml
└── .env.example
```

### 后端实现详解

#### 认证流程

| 步骤 | 实现 |
|------|------|
| 密码处理 | `SHA-256` 哈希明文密码 |
| 登录 | `POST chat.qwen.ai/api/v1/auths/signin` |
| Token | JWT 格式，包含过期时间 `exp` |
| 自动刷新 | 每 6 小时重新登录（刷新 = 重新登录） |
| 刷新阈值 | 剩余有效期 < 24 小时时触发 |

#### 账号轮询

- **LRU 策略**：优先选择最久未使用的账号
- **失败冷却**：连续失败 3 次 → 5 分钟冷却 → 自动重置
- **负载均衡**：多账号自动分散请求压力

#### 反爬机制

通义千问 API 要求浏览器指纹 Cookie：

1. `fingerprint.js` 合成 37 字段浏览器指纹
2. `cookie-generator.js` 随机化 → LZW 压缩 → Base64 → `ssxmod_itna` + `ssxmod_itna2`
3. `ssxmod-manager.js` 每 15 分钟自动刷新

#### 请求处理链路

```
1. 客户端发送 OpenAI / Anthropic / Gemini 格式请求
2. 鉴权中间件（按协议匹配 Authorization / x-api-key / x-goog-api-key）
3. 适配器把请求转换为内部 OpenAI 表示
4. Chat 中间件转换格式：
   - 解析模型后缀（-thinking / -search 等）
   - 匹配上游模型 ID
   - 转换消息为 Qwen 格式
5. Request 模块：
   - 选取账号 Token
   - 生成 ssxmod Cookie
   - 创建会话 → 发送请求
6. Chat 控制器处理响应：
   - 解析 SSE（phase=think → reasoning_content，phase=answer → content）
   - 按客户端协议封装为对应格式（OpenAI Chunk / Anthropic Event / Gemini Candidate）
```

#### Tool Calling

Qwen3 模型原生支持 Function Calling。工作方式：

1. 客户端按 OpenAI 格式在 `messages` 中携带 `tools` 定义
2. 中间件将所有消息序列化为文本上下文
3. Qwen3 模型从上下文理解工具协议，自动生成结构化 `tool_calls`
4. 实测 OpenAI SDK 的 function calling 可正常使用

### 前端实现

| 项目 | 说明 |
|------|------|
| 框架 | React 18 + Hooks |
| 构建 | Vite 5，产物 `webui/dist/` |
| 样式 | Tailwind CSS 3，暗色主题，毛玻璃 |
| 路由 | React Router 6 |
| 聊天 | `fetch` + `ReadableStream` SSE 流式解析；重试不重发消息，新版本作为 `versions[]` 追加并支持左右切换 |
| 存储 | `localStorage` 聊天历史 |
| 渲染 | `marked` + `highlight.js` 代码高亮 |
| 文档页 | OpenAI / Anthropic / Gemini / 管理 / 公共 五分类切换 |

页面：聊天界面 / 管理面板 / API 文档 / 登录

```bash
cd webui && npm install && npm run build   # 构建
cd webui && npm run dev                     # 开发
```

---

## 环境变量

| 变量 | 说明 | 默认值 | 必填 |
|------|------|--------|------|
| `API_KEY` | API 密钥，逗号分隔，第一个为管理员 | — | ✅ |
| `ACCOUNTS` | 账号 `email:pass,email2:pass2` | — | ✅ |
| `SERVICE_PORT` | 端口 | `3000` | — |
| `DATA_SAVE_MODE` | `none`（内存）/ `file`（文件）/ `redis`（HTTP Redis） | `none` | — |
| `REDIS_URL` | Redis HTTP 端点（仅 `redis` 模式；最高优先级） | — | — |
| `REDIS_TOKEN` | Redis Bearer Token（仅 `redis` 模式；最高优先级） | — | — |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel Marketplace 集成（Upstash for Redis）自动注入 | — | — |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Upstash 控制台直连（兼容） | — | — |
| `LISTEN_ADDRESS` | 监听地址 | 所有接口 | — |
| `OUTPUT_THINK` | 输出思考内容 | `false` | — |
| `SEARCH_INFO_MODE` | 搜索显示 `text` / `table` | `text` | — |
| `SIMPLE_MODEL_MAP` | 简化模型列表 | `false` | — |
| `LOG_LEVEL` | 日志级别 | `INFO` | — |
| `PROXY_URL` | 单代理（legacy，会合并进 `PROXIES`） | — | — |
| `PROXIES` | 代理池，逗号分隔（`socks5://` / `http://` / `https://`） | — | — |
| `PROXY_MAX_RETRIES` | 代理失败时的重试次数 | `3` | — |
| `QWEN_CHAT_PROXY_URL` | 自定义 API 地址 | `https://chat.qwen.ai` | — |

### 智能代理池

`PROXIES` 配置后启用代理池模式：

- **状态持久化**（`DATA_SAVE_MODE=file` 或 `redis`，见下文）：代理 `untested/available/failed` 状态和账号绑定关系写入存储，重启秒级恢复。`none` 模式不持久（重启重新探测）
- **四级优先级**：先 _可用且未占用_ → 再 _未测试_（首次探测）→ 再 _已失败_（再探测，可能恢复）→ 最后 _可用且共享_（按占用最少优先）
- **故障转移**：上游请求出现 TCP/SOCKS 类网络错误时自动标记代理失败、换绑、重试（最多 `PROXY_MAX_RETRIES` 次）
- **增量去重**：从 `PROXIES` 环境变量 + 持久化记录合并加载，按 URL 去重

管理面板提供 `GET /api/proxy/status`、`POST /api/proxy/add`、`DELETE /api/proxy` 三个接口（需要管理员 API Key）。

### 数据持久化模式

| 模式 | 使用场景 | 存储位置 |
|---|---|---|
| `none`（默认） | 任何平台 | 内存；重启即丢，账号靠 `ACCOUNTS` env 重新登录 |
| `file` | 本地 / Docker / VPS / **Northflank** / Render（付费 Disks） | `data/data.json` |
| `redis` | **Vercel / Netlify / Cloudflare Workers** 等 serverless | Redis-over-HTTP（兼容 Upstash REST 协议） |

> ⚠️ **Vercel 不支持 `file` 模式**：serverless 容器无持久磁盘，每次冷启动 `data/data.json` 都会丢失，账号 token 和代理状态都会重置。Vercel 部署请用 `redis` 模式。

#### Redis 模式：三种凭证来源（按优先级）

后端按以下顺序自动检测，**任选其一即可**：

| 优先级 | 环境变量对 | 使用场景 |
|---|---|---|
| 1 | `REDIS_URL` + `REDIS_TOKEN` | 通用（推荐手动配置时使用） |
| 2 | `KV_REST_API_URL` + `KV_REST_API_TOKEN` | **Vercel Marketplace** 集成（如 Upstash for Redis）自动注入 |
| 3 | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Upstash 控制台直连 |

> 三种凭证最终都走 **Upstash REST 协议**（HTTPS + JSON）。Vercel 已不再提供"原生 KV" —— 所谓"Vercel KV"现在是通过 [Vercel Marketplace](https://vercel.com/marketplace?category=storage) 集成的 **Upstash for Redis**，走的就是这套协议。如果你的 Redis 提供商只支持 RESP/TCP（自建 Redis / Aiven / Redis Cloud 直连），目前还不能用 `redis` 模式——可以走 `file` 模式部署到 VPS / Docker。

#### Vercel 部署的三种 Redis 配置

**方式 A：Vercel Marketplace 集成 Upstash for Redis（最省事）**

1. Vercel 项目 → **Storage** → **Create Database** → 选 **Upstash for Redis**
2. 关联到本项目 → 自动注入 `KV_REST_API_URL` / `KV_REST_API_TOKEN`
3. 仅需手动加 `DATA_SAVE_MODE=redis`，Redeploy

**方式 B：Upstash 直连**

1. [console.upstash.com](https://console.upstash.com) 创建 Redis 数据库
2. **REST API** 选项卡复制 URL 和 Token
3. Vercel Environment Variables 添加：
   ```
   DATA_SAVE_MODE=redis
   UPSTASH_REDIS_REST_URL=https://xxxxx.upstash.io
   UPSTASH_REDIS_REST_TOKEN=AXxxxxxxxxxxxxxxxxxxxxxxx
   ```

**方式 C：通用 REDIS_URL**

任何兼容 Upstash REST 协议的服务（包括上面两种）都可以用通用名：
```
DATA_SAVE_MODE=redis
REDIS_URL=https://your-endpoint
REDIS_TOKEN=your-bearer-token
```

---

## API 接口文档

### OpenAI 格式

```http
POST /v1/chat/completions
Authorization: Bearer sk-your-key

{"model":"qwen3.6-plus","messages":[{"role":"user","content":"你好"}],"stream":true}
```

模型后缀：无（标准） / `-thinking`（思维链） / `-search`（搜索） / `-thinking-search` / `-image` / `-video` / `-image-edit`

常用基础模型示例：`qwen3.6-plus`。完整列表通过 `GET /v1/models` 动态获取。

### Anthropic Messages 格式

```http
POST /v1/messages           （或 /anthropic/v1/messages）
x-api-key: sk-your-key
Content-Type: application/json

{
  "model": "qwen3.6-plus",
  "max_tokens": 1024,
  "messages": [{"role":"user","content":"你好"}],
  "stream": true
}
```

也接受 `Authorization: Bearer ...`。流式响应遵循 Anthropic SSE 事件类型（`message_start` / `content_block_delta` / `message_stop` 等）。

### Gemini 格式

```http
POST /v1beta/models/qwen3.6-plus:generateContent
x-goog-api-key: sk-your-key
Content-Type: application/json

{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}
```

也支持：
- 流式：`/v1beta/models/{model}:streamGenerateContent`
- v1 路径：`/v1/models/{model}:generateContent`、`/v1/models/{model}:streamGenerateContent`
- 鉴权：`x-goog-api-key` 头、`?key=...` 查询参数、`Authorization: Bearer ...`

### 模型列表

```http
GET /v1/models
```

### 图片 / 视频

```http
POST /v1/images/generations
{"prompt":"海上日落","size":"1024x1024"}

POST /v1/images/edits  (multipart)
POST /v1/videos        (multipart)
```

### 账号管理（管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/getAllAccounts` | 获取账号列表（支持分页） |
| POST | `/api/setAccount` | 添加账号 |
| DELETE | `/api/deleteAccount` | 删除账号 |
| POST | `/api/refreshAccount` | 刷新单账号 Token |
| POST | `/api/refreshAllAccounts` | 批量刷新（支持 `thresholdHours`） |

### 健康检查

```http
GET /health → {"status":"ok"}
POST /verify {"apiKey":"sk-..."} → {"valid":true}
```

---

## 常见问题

**Token 过期？** — 自动刷新，每 6 小时重新登录。也可在管理面板手动刷新。

**Vercel 冷启动慢？** — 首次请求需登录账号（几秒），后续直接使用内存中的 Token。

**支持哪些客户端？** — 任何 OpenAI / Anthropic / Gemini 客户端均可：OpenAI SDK、`@anthropic-ai/sdk`、`@google/generative-ai`、NextChat、ChatBox、Open WebUI、Lobe Chat、Claude Code 等。

**Tool Calling 怎么用？** — 按 OpenAI function calling 格式发送即可，Qwen3 自动识别。

**多账号？** — `ACCOUNTS=email1:pass1,email2:pass2,email3:pass3` 或管理面板批量添加。

**前端重试会丢失上一次回答吗？** — 不会。新一轮回答作为新版本追加到同一条 assistant 消息，可以用消息底部的 `< 1/N >` 控件随时切回旧版本。

---

## 许可证

MIT
