# Docker Deployment

[中文说明](#中文说明) · [Project documentation](https://ccrdesk.top/en/) · [GitHub](https://github.com/musistudio/claude-code-router)

The Docker image runs the CCR core server under PM2 and serves the built management UI through Nginx. Nginx is the only public container entrypoint: the browser UI, management RPC, gateway API, and health route all share one published port.

The image is intended for a persistent gateway and browser-based administration. It does not include Electron, the npm `ccr` command, system tray features, desktop Agent/App launching, automatic desktop updates, or desktop-only browser integrations.

## Architecture And Ports

```text
host:3458 -> container Nginx:8080
                         |-> static management UI
                         |-> management RPC: 127.0.0.1:3459
                         `-> gateway:       127.0.0.1:3456
```

Only Nginx port `8080` should be published. The internal management and gateway ports are container implementation details and should not be exposed individually.

Nginx routes:

| Public route | Purpose |
| --- | --- |
| `/` and `/pages/home/index.html` | Browser management UI. `/` redirects to a URL containing the management token. |
| `/api/ccr/rpc` | Authenticated management RPC. |
| `/health` | Gateway health, not container/UI health. It can return `502` until a provider and model are configured and the gateway starts. |
| `/v1/*`, `/v1beta/*`, `/messages`, `/chat/completions`, `/responses`, `/interactions`, `/mcp/*` | Supported model and MCP gateway requests. |

## Quick Start With Compose

From the repository root:

```sh
npm run docker:compose:up
docker compose logs -f ccr
```

Open <http://127.0.0.1:3458>. On a new volume, the management UI is immediately available. Add a provider and model, create a CCR client key under **API Keys**, and start the gateway from **Server**.

The npm Compose script prepares a local `../../next-ai/gateway` checkout before building so the image uses that plugin-capable ai-gateway runtime. If you run `docker compose up -d --build` directly, run `npm run docker:prepare-gateway` first. `npm run docker:build` performs the same preparation automatically.

The repository Compose file publishes `3458:8080`, stores data in the `ccr-data` named volume, and restarts the service unless explicitly stopped. A mapping without a host IP binds on every host interface. For local-only access, change it to:

```yaml
ports:
  - "127.0.0.1:3458:8080"
```

Stop or remove the container without deleting its named volume:

```sh
docker compose stop
docker compose down
```

Do not add `--volumes` to `docker compose down` unless you intentionally want to delete all persisted CCR data.

## `docker run`

Build and run without Compose:

```sh
npm run docker:build
docker run -d \
  --name ccr \
  --restart unless-stopped \
  -p 127.0.0.1:3458:8080 \
  -e CCR_PUBLIC_BASE_URL=http://127.0.0.1:3458 \
  -v ccr-data:/data \
  helix-compressor:local
```

The temporary run script is also available:

```sh
npm run docker:run
```

`npm run docker:run` uses port `3458` and the `ccr-data` volume, but runs an ephemeral container without a fixed name or restart policy.

## Authentication And Network Security

There are two independent authentication layers:

1. `CCR_WEB_AUTH_TOKEN` protects management RPC. Nginx puts it into the management-page URL, and the browser sends it to RPC as `x-ccr-web-auth`.
2. CCR client API keys created in the **API Keys** page protect model gateway requests. These are separate from upstream provider credentials.

If `CCR_WEB_AUTH_TOKEN` is unset, the entrypoint generates a new random token on each container start. Opening `/` still works because Nginx redirects to a tokenized URL, but a stable token is recommended for persistent or remote deployments.

Avoid putting the token directly in shell history. Create a protected environment file instead:

```dotenv
CCR_WEB_AUTH_TOKEN=replace-with-a-long-random-value
CCR_PUBLIC_BASE_URL=http://127.0.0.1:3458
```

Then use it with `docker run --env-file` or map the same variables under the Compose service's `environment` section. Keep this file out of version control.

Security guidance:

- Bind the published port to `127.0.0.1` unless LAN or remote access is intentional.
- Never expose the management UI over untrusted networks without TLS, a firewall/private network, and a fixed strong management token.
- Treat tokenized management URLs as secrets; URLs may be recorded in browser history, proxy logs, screenshots, and support tickets. The hardened reverse-proxy mode above removes the token from the URL entirely.
- Create scoped CCR client API keys before exposing gateway routes. Do not reuse upstream provider credentials as client keys.
- Protect `/data` and its backups because they contain configuration, provider credentials, CCR client keys, request data, and generated certificates.

## Changing The Public Address

The host-facing URL is separate from the container's internal ports. Whenever the host port, hostname, or scheme changes, set `CCR_PUBLIC_BASE_URL` to the exact URL clients should use:

```yaml
services:
  ccr:
    ports:
      - "127.0.0.1:8088:8080"
    environment:
      CCR_PUBLIC_BASE_URL: http://127.0.0.1:8088
      CCR_WEB_AUTH_TOKEN: ${CCR_WEB_AUTH_TOKEN:?set CCR_WEB_AUTH_TOKEN}
```

`CCR_PUBLIC_BASE_URL` is written to CCR's public router endpoint. It does not publish a Docker port by itself.

For a reverse proxy or ingress that terminates HTTPS:

```yaml
services:
  ccr:
    ports:
      - "127.0.0.1:3458:8080"
    environment:
      CCR_PUBLIC_BASE_URL: https://ccr.example.com
      CCR_WEB_AUTH_TOKEN: ${CCR_WEB_AUTH_TOKEN:?set CCR_WEB_AUTH_TOKEN}
```

Proxy all paths to Nginx and preserve streaming. The external proxy should allow long-lived responses and should not buffer SSE/model streams. Keep the host port private when the reverse proxy is the public entrypoint.

## Reverse Proxy And TLS

Put TLS termination and network gating in front of the container. Never publish the container port to the internet directly.

```text
browser -> host reverse proxy (443, TLS) -> 127.0.0.1:3458 (container Nginx)
                                                        |-> management RPC: 127.0.0.1:3459
                                                        `-> gateway:       127.0.0.1:3456
```

Keep the container's own Nginx in the path: it already multiplexes the UI, management RPC, gateway routes, and `/health` on one port. Forward every path to it instead of re-implementing routing in the outer proxy. Bind the published port to loopback first (see [Quick Start With Compose](#quick-start-with-compose)).

### Generic Nginx Example

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
  listen 80;
  server_name ccr.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name ccr.example.com;
  ssl_certificate     /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:3458;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Model streams, SSE, and recall must not be buffered.
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}
```

Set `CCR_PUBLIC_BASE_URL=https://ccr.example.com`. If the outer proxy defaults to buffering (Nginx does not), model streams arrive in one burst after a long pause. `proxy_buffering off` is required for `/v1/*` and other streaming routes.

### BT Panel (宝塔)

The container keeps its own Nginx; the panel's Nginx only terminates TLS and forwards.

1. **Site**: add a site for `ccr.example.com` (a plain static site is enough; no PHP or database). Issue a Let's Encrypt certificate and enable **Force HTTPS**.
2. **Reverse proxy**: add one with target `http://127.0.0.1:3458` and send domain `$host`.
3. **Edit the generated proxy config** (Reverse proxy -> config file, typically `/www/server/panel/vhost/nginx/proxy/<domain>/<name>.conf`). The default template buffers responses and breaks model streaming, so replace its `location` body with the snippets above. Keep custom rules in this proxy file, not the site's main config, because re-saving the site can reset it.
4. Run `nginx -t && nginx -s reload` (or the panel's **Reload** action).

Keep the container port loopback-only and open only `443` in the host firewall.

### Management Auth Modes

**Default — token in URL.** Container Nginx 302-redirects `/` to `/pages/home/index.html?ccr_web_token=...`. The browser reads the token, removes it from the address bar before the app's main script runs, keeps it in `sessionStorage`, and sends it as the `x-ccr-web-auth` header on management RPC. The token appears once in the first redirect URL (and may therefore be recorded in browser history, screenshots, or support tickets).

**Hardened — token never in the URL.** The reverse proxy injects the token header and the browser never receives it. Enable it with `CCR_WEB_INJECT_HEADER=1`, which stops the container Nginx from appending `ccr_web_token` to any URL, and inject the header on the host proxy:

```nginx
proxy_set_header x-ccr-web-auth "<CCR_WEB_AUTH_TOKEN>";
```

No application code changes are needed: when the browser has no token it simply omits the header, and the proxy-supplied header authorizes the RPC. Tokenless RPC still returns `401` from the core server, so a leaked container port fails closed.

**The proxy must authenticate the caller first.** Because the proxy injects the token unconditionally, anyone who can reach the site becomes an administrator. Use HTTP Basic (BT: **Site -> Access restriction**), an SSO forward-auth service (oauth2-proxy, Cloudflare Access), or a private network / VPN. Without one of these, this mode exposes an unauthenticated admin console.

The injected token is embedded in the container Nginx config, so it must not contain a double quote; base64url tokens are safe.

Generate a strong token with the same algorithm the entrypoint uses:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Store it in a mode-`600` env file, out of shell history and version control. This token is the management superuser credential; rotate it by changing the value and recreating the container.

## Using CCR As An Upstream Provider

CCR's gateway speaks OpenAI-compatible (`POST /v1/chat/completions`, `GET /v1/models`) and Anthropic-compatible (`POST /v1/messages`) protocols, so it can sit behind another router (one-api, new-api, LiteLLM) as a plain upstream channel.

- **Channel type**: custom / OpenAI-compatible.
- **Base URL**: your public URL, e.g. `https://ccr.example.com`. The container Nginx routes `^/(v1|v1beta|mcp|messages|chat/completions|responses|interactions)(/|$)` to the gateway.
- **API key**: a CCR client key (`sk-ccr-...`) created under **API keys**. CCR accepts it as `Authorization: Bearer`, `x-api-key`, or `api-key`. Without one, `authorize` returns `403` ("CCR API key is not initialized").
- **Models**: whatever you configured under **Providers**. `GET /v1/models` lists the available ids.

### Does compression still work?

Yes. Compression and recall are **server-side**: when a request still holds collapsible placeholders, the compressor rewrites the model to `ccr-helix-recall/<model>`, CCR matches a virtual profile and resolves recall through an internal tool loop, including for streaming responses. The caller never sees a placeholder and never calls a recall tool.

Two conditions must hold:

1. The `helix-compressor` plugin must be enabled. It is **on by default**; existing deployments whose config predates this get the entry added automatically on load. To turn it off, add `{ "id": "helix-compressor", "enabled": false }` to the plugins list.
2. Recall only rewrites tokens that were compressed *in the same session/account*. A brand-new caller's first request has nothing to recall, so it simply passes through; savings appear as a conversation grows.

Because recall is internal, a generic OpenAI client behind one-api benefits from compression transparently. The one caveat is billing, below.

### Billing: what the caller's `usage` reports

CCR returns the **post-compression** usage to the caller: the upstream provider is called with the compressed body, so the `usage` it reports already reflects the compressed prompt. A downstream router that bills from the returned `usage` therefore bills the compressed amount — and the upstream provider is billed the compressed amount too, so CCR's compression is a real cost reduction on both hops.

Do **not** rely on the `x-helix-compressor-*` response headers for reconciliation. Measured behavior: they are only attached when a plugin transform was actually applied, so they appear on requests that were *not* compressed (where `baseline == compressed` and carry no signal) and are **absent on the requests that were compressed**. Verified: a large tool-result conversation compresses (baseline 11891 → post 5123) yet returns zero `x-helix-compressor-*` headers.

To reconcile pre- vs post-compression volume, read CCR's own request log (`compression_baseline_tokens`, `compression_post_tokens`, `compression_recall_tokens`). Note the accounting scope, since the three numbers do not line up as "before vs after" on the same base:

- `baseline` and `post` count **messages only** — they exclude `system` and `tools`.
- `recall` is the original text the gateway re-injected during recall; a request can be net *larger* than baseline once system + tools + recall are added back.

## Persistent Data

The entrypoint sets `HOME=/data`, so CCR stores files under:

```text
/data/.claude-code-router/
├── config.sqlite
├── gateway.config.json
├── app-data/
│   ├── api-keys.sqlite
│   ├── request-logs.sqlite
│   ├── usage.sqlite
│   └── certs/
├── profiles/
└── bin/
```

Use a named volume unless a bind mount is operationally required. Bind mounts must be writable by the container and should not be shared by two running CCR containers.

The first-run bootstrap writes a minimal legacy `config.json` only when neither `config.json` nor `config.sqlite` exists. When the UI saves current settings, SQLite becomes authoritative. By default, every container start also synchronizes the stored gateway listener and `routerEndpoint` to the Docker public endpoint.

## Backup And Restore

The safest application-level backup is **Settings → Export data**. For a full volume backup, stop writes before copying the data directory:

```sh
docker compose stop ccr
docker compose cp ccr:/data/. ./ccr-data-backup/
docker compose start ccr
```

Keep the backup private. It contains secrets and may include request/response data.

For a full restore, use a new empty volume or empty `/data` directory, copy the backup contents into it while the CCR container is stopped, then start the container. Do not overlay an old backup onto a populated live volume: stale SQLite WAL/SHM files and newer runtime files can produce an inconsistent result. Make a second backup before replacing existing data.

## Upgrade And Rollback

Back up `/data`, update the source revision, rebuild with fresh base layers, and recreate the service:

```sh
git pull
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 ccr
```

Configuration migrations run against the persistent data. To roll back, use the previous image/source revision together with a backup created before the upgrade; do not assume a newer database can always be read by an older build.

## Environment Variables

Most deployments should set only `CCR_WEB_AUTH_TOKEN`, `CCR_PUBLIC_BASE_URL`, and the Docker port mapping. Internal listener values normally should remain unchanged.

| Variable | Default | Description |
| --- | --- | --- |
| `CCR_WEB_AUTH_TOKEN` | Random per container start | Management UI/RPC token. Set a stable strong value for persistent or remote use. |
| `CCR_PUBLIC_BASE_URL` | `http://127.0.0.1:3458` | Exact public gateway/UI base URL written into CCR configuration. Overrides `CCR_PUBLIC_HOST` and `CCR_PUBLIC_PORT`. |
| `CCR_PUBLIC_HOST` | `127.0.0.1` | Used only to derive `CCR_PUBLIC_BASE_URL` when the full URL is unset; it does not change Docker port publishing. |
| `CCR_PUBLIC_PORT` | `3458` | Used only to derive `CCR_PUBLIC_BASE_URL` when the full URL is unset. |
| `CCR_DATA_DIR` | `/data` | Container data root and process `HOME`. Mount persistent storage here. |
| `CCR_NGINX_PORT` | `8080` | Container-private Nginx listen port. Match the container side of the published mapping if changed. |
| `CCR_WEB_HOST` | `127.0.0.1` | Container-private management server host. |
| `CCR_WEB_PORT` | `3459` | Container-private management server port. |
| `CCR_GATEWAY_HOST` | `127.0.0.1` | Container-private gateway listener host. |
| `CCR_GATEWAY_PORT` | `3456` | Container-private gateway listener port used by Nginx. |
| `CCR_NO_GATEWAY` | `0` | Set to `1`, `true`, or `yes` to run the management UI without starting the gateway at boot. |
| `CCR_WEB_INJECT_HEADER` | `0` | Set to `1`, `true`, `yes`, or `on` to stop putting the management token in URLs. The outer reverse proxy must then inject `x-ccr-web-auth` and authenticate the caller. See [Management Auth Modes](#management-auth-modes). |
| `CCR_DOCKER_INIT_CONFIG` | `1` | Set to `0` to disable minimal first-run `config.json` bootstrap. |
| `CCR_DOCKER_SYNC_PUBLIC_ENDPOINT` | `1` | Set to `0` to stop startup from syncing existing JSON/SQLite listener and public endpoint fields to Docker values. |

Changing internal ports requires corresponding Nginx/PM2 variables and offers no benefit in normal deployments. Publish only `CCR_NGINX_PORT`.

## Build Options And Smoke Test

The Dockerfile builds native dependencies with `node:22-bookworm`, then copies production dependencies and built assets into `node:22-bookworm-slim`. Override the base images when required:

```sh
docker build \
  --build-arg NODE_IMAGE=node:22-bookworm \
  --build-arg RUNTIME_NODE_IMAGE=node:22-bookworm-slim \
  -t helix-compressor:local .
```

Run the isolated Docker smoke test:

```sh
npm run test:docker
```

The test builds the image, starts a temporary container and volume, verifies that only Nginx is published, checks UI/RPC authentication, tests public-endpoint migration, starts a configured gateway, checks `/health`, and removes its resources. Set `CCR_DOCKER_TEST_SKIP_BUILD=1` to reuse an existing image or `CCR_DOCKER_TEST_IMAGE` to test a different local tag.

## Operations And Troubleshooting

Useful commands:

```sh
docker compose ps
docker compose logs -f ccr
docker compose restart ccr
docker compose config
```

### `/` returns `302`

This is expected. Nginx redirects the root URL to the management page and URL-encodes the management token.

### `/health` returns `502`

`/health` checks the model gateway, not Nginx or the management UI. On a fresh volume it returns `502` until a provider/model exists and the gateway has started; after startup, the plugin-capable ai-gateway runtime returns `200` with status `ok`. Use `docker compose ps` for container health and open the UI to configure/start the gateway.

### The UI returns `401` after a token change

Open the bare root URL again so Nginx creates a URL with the current token. Close stale tabs and avoid bookmarks that contain an old `ccr_web_token`.

### Model responses arrive in one burst after a long pause

The outer reverse proxy is buffering. Set `proxy_buffering off` (and `proxy_request_buffering off`) for the streaming routes, keep long `proxy_read_timeout`/`proxy_send_timeout` values, and reload the proxy. Restrict the change to this proxy's own config file, since re-saving a site in a panel like BT Panel can reset its main config.

### HTTPS works but the app still uses http:// addresses

Set `CCR_PUBLIC_BASE_URL` to the exact `https://` URL and recreate the container so CCR's stored public endpoint is re-synchronized at startup.

### Clients still use the old port or hostname

Update `CCR_PUBLIC_BASE_URL` and recreate the container. Leave `CCR_DOCKER_SYNC_PUBLIC_ENDPOINT=1` so existing SQLite configuration is synchronized at startup.

### Configuration disappears after recreation

Confirm that `/data` is mounted and that the same named volume or bind-mount path is being reused. `docker compose down` keeps named volumes; `docker compose down --volumes` deletes them.

### A bind mount fails with permission errors

Verify that the host directory exists, is writable by the container, and is not mounted read-only. Named volumes avoid most host ownership and labeling issues.

### The container is healthy but model requests fail

Container health only verifies Nginx/UI reachability. Check **Server** status, provider connectivity, CCR client-key authentication, routing, and request logs. Then inspect `docker compose logs --tail=200 ccr` for startup or runtime errors.

---

## 中文说明

Docker 镜像通过 PM2 运行 CCR Core，并由 Nginx 同时提供管理 UI、管理 RPC、模型网关和健康检查。对外只应发布 Nginx 的容器端口 `8080`；`3459` 和 `3456` 是容器内部实现端口，不应单独暴露。

这个镜像面向常驻网关和浏览器管理，不包含 Electron、npm 的 `ccr` 命令、系统托盘、桌面 Agent/App 启动、桌面自动更新和桌面专属浏览器集成。

### 快速启动

```sh
npm run docker:compose:up
docker compose logs -f ccr
```

打开 <http://127.0.0.1:3458>。首次启动时管理 UI 可以立即访问；添加供应商和模型、在 **API 密钥** 页面创建 CCR 客户端 Key，然后从 **服务** 页面启动网关。

这个 npm Compose 脚本会在构建前准备本机的 `../../next-ai/gateway` checkout，让镜像使用支持插件的 ai-gateway runtime。如果直接运行 `docker compose up -d --build`，请先执行 `npm run docker:prepare-gateway`。`npm run docker:build` 也会自动打包这份本地 ai-gateway。

仓库默认映射是 `3458:8080`，会监听宿主机所有网卡。如果只允许本机访问，请改为：

```yaml
ports:
  - "127.0.0.1:3458:8080"
```

### 鉴权与远程访问

- `CCR_WEB_AUTH_TOKEN` 用于管理 UI / RPC；不设置时，每次容器启动都会生成新的随机 Token。
- **API 密钥** 页面创建的 CCR 客户端 Key 用于模型网关请求。
- 上游供应商凭据是第三类凭据，不应拿来代替 CCR 客户端 Key。

根路径会重定向到包含 `ccr_web_token` 的管理 URL。请把该 URL 当作密码。远程部署至少应使用固定强 Token、TLS、主机防火墙或私网，并让反向代理把全部路径转发到 Nginx。流式响应和 SSE 不应被代理缓冲。

### 反向代理与 TLS

把 TLS 终止与网络准入放在容器前面，不要把容器端口直接暴露到公网。

```text
浏览器 -> 宿主反代(443, TLS) -> 127.0.0.1:3458(容器 Nginx)
                                        |-> 管理 RPC: 127.0.0.1:3459
                                        `-> 网关:    127.0.0.1:3456
```

保留容器自带的 Nginx：它已经把 UI、管理 RPC、网关路由和 `/health` 收敛在一个端口。把全部路径转发给它，不要在外部反代里重新实现路径分流。发布端口先绑回环（见「快速启动」）。

通用 Nginx 示例：

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
  listen 80;
  server_name ccr.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name ccr.example.com;
  ssl_certificate     /path/to/fullchain.pem;
  ssl_certificate_key /path/to/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  location / {
    proxy_pass http://127.0.0.1:3458;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # 模型流、SSE、召回不应被缓冲
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;

    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}
```

同时设置 `CCR_PUBLIC_BASE_URL=https://ccr.example.com`。若外部反代默认开启缓冲（Nginx 默认开），模型流会先长时间无输出、再一次性吐出；`/v1/*` 等流式路由必须 `proxy_buffering off`。

#### 宝塔面板（BT Panel）

容器保留自己的 Nginx，面板的 Nginx 只负责终止 TLS 与转发。

1. **网站**：为 `ccr.example.com` 添加站点（纯静态即可，无需 PHP/数据库），申请 Let's Encrypt 证书并开启 **强制 HTTPS**。
2. **反向代理**：目标 URL 填 `http://127.0.0.1:3458`，发送域名填 `$host`。
3. **编辑生成的代理配置**（反向代理 → 配置文件，通常位于 `/www/server/panel/vhost/nginx/proxy/<域名>/<名称>.conf`）。面板默认模板会缓冲响应、中断模型流，请把其中的 `location` 主体替换为上面的片段。自定义规则放在这个代理配置里，不要混进站点主配置——重新保存站点可能重置它。
4. 执行 `nginx -t && nginx -s reload`（或面板的「重载配置」）。

容器端口保持只绑回环，宿主防火墙只放行 `443`。

#### 管理端鉴权模式

**默认 —— token 进 URL。** 容器 Nginx 把 `/` 302 到 `/pages/home/index.html?ccr_web_token=...`。浏览器取出 token、在应用主脚本运行前从地址栏抹掉、存入 `sessionStorage`，之后以 `x-ccr-web-auth` header 发管理 RPC。token 会在首次跳转 URL 里出现一次（因而可能被浏览器历史、截图或工单记录）。

**加固 —— token 不进 URL。** 由反代注入 token header，浏览器根本拿不到 token。以 `CCR_WEB_INJECT_HEADER=1` 启用：容器 Nginx 不再向任何 URL 追加 `ccr_web_token`；再在宿主反代注入 header：

```nginx
proxy_set_header x-ccr-web-auth "<CCR_WEB_AUTH_TOKEN>";
```

无需改动应用代码：浏览器没有 token 时会省略 header，反代注入的 header 即可通过 RPC 鉴权。不带 header 的 RPC 仍由核心服务返回 `401`，容器端口意外暴露时失败关闭。

**反代必须先认人。** 因为注入是无条件的，任何能访问该站点的人都等于管理员。请配合 HTTP Basic（宝塔：**网站 → 访问限制**）、SSO 前置认证（oauth2-proxy、Cloudflare Access）或私网/VPN。缺了这一环，此模式等于敞开一个无鉴权的管理后台。

注入的 token 会被写进容器 Nginx 配置，因此不能包含双引号；base64url token 安全。

用与 entrypoint 相同的算法生成强 token：

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

存入权限 `600` 的 env 文件，避免进入 shell 历史与版本控制。该 token 即管理端超级凭据，轮换方式是改值并重建容器。

外部端口、域名或协议变化时，必须同步设置公开地址：

```yaml
environment:
  CCR_PUBLIC_BASE_URL: https://ccr.example.com
  CCR_WEB_AUTH_TOKEN: ${CCR_WEB_AUTH_TOKEN:?set CCR_WEB_AUTH_TOKEN}
```

`CCR_PUBLIC_BASE_URL` 只负责写入客户端应使用的公开地址，不会自动发布 Docker 端口。

### 把 CCR 当上游供应商

CCR 网关同时支持 OpenAI 兼容（`POST /v1/chat/completions`、`GET /v1/models`）与 Anthropic 兼容（`POST /v1/messages`），可作为普通「自定义渠道」放在 one-api / new-api / LiteLLM 之后。

- **渠道类型**：自定义 / OpenAI 兼容。
- **Base URL**：你的公开地址，如 `https://ccr.example.com`。容器 Nginx 会把 `^/(v1|v1beta|mcp|messages|chat/completions|responses|interactions)(/|$)` 转给网关。
- **密钥**：在**API 密钥**页创建的 CCR 客户端 key（`sk-ccr-...`）。CCR 接受 `Authorization: Bearer`、`x-api-key`、`api-key`；未配置任何 key 时 `authorize` 返回 `403`。
- **模型**：填你在**供应商**里配好的模型；`GET /v1/models` 会列出可用 id。

#### 压缩还生效吗？

生效。压缩与召回都在**服务端**完成：只要请求里仍有可折叠的占位符，压缩器就把 model 改写成 `ccr-helix-recall/<模型>`，CCR 命中虚拟 profile 后经内部 tool 循环兑现召回，**流式响应同样支持**。调用方既看不到占位符，也无需调用任何召回工具。

两个前提：

1. `helix-compressor` 插件必须启用。它**默认开启**；早于该默认值的旧部署会在读取配置时自动补上该条目。如需关闭，在插件列表里加 `{ "id": "helix-compressor", "enabled": false }`。
2. 召回只能还原**同一会话/账号**内被压缩的内容。全新调用方的首个请求无可召回内容，直接透传；收益随对话增长而显现。

由于召回在网关内部完成，one-api 后面的普通 OpenAI 客户端可透明享受压缩。唯一需要注意的是计费，见下。

#### 计费：调用方看到的 `usage` 是哪个

CCR 回给调用方的 `usage` 是**压缩后**的：上游收到的本就是压缩后的 body，其上报的 `usage` 已反映压缩结果。因此若 one-api 按返回的 `usage` 给用户计费，计的就是**压缩后**的量；上游供应商同样按压缩后计费，压缩在**两跳**上都是真实降本。

**不要**依赖 `x-helix-compressor-*` 响应头做对账。实测行为：这些头只在插件 transform 确实生效时才附加，于是它们出现在**未被压缩**的请求上（此时 `baseline == compressed`，没有信息量），而在**真正被压缩**的请求上**反而缺失**。已验证：一个含大段 tool_result 的会话确实被压缩（baseline 11891 → post 5123），却返回了 **0 个** `x-helix-compressor-*` 头。

要对账压缩前后的量，请读 CCR 自己的请求日志（`compression_baseline_tokens`、`compression_post_tokens`、`compression_recall_tokens`）。注意口径，三者并非同一基准上的「前 vs 后」：

- `baseline` 与 `post` 只统计 **messages**，不含 `system` 与 `tools`。
- `recall` 是网关在召回时重新注入的原文；把 system + tools + recall 加回来后，一次请求可能比 baseline **更大**。

### 数据、备份与升级

数据实际位于 `/data/.claude-code-router/`，其中包括 `config.sqlite`、`app-data/`、Agent 配置和生成文件。优先使用命名卷，不要让两个运行中的 CCR 容器共享同一个数据目录。

完整文件备份前先停止写入：

```sh
docker compose stop ccr
docker compose cp ccr:/data/. ./ccr-data-backup/
docker compose start ccr
```

备份包含密钥和请求数据，必须按敏感数据保存。恢复时应复制到新的空卷或空 `/data`，不要把旧备份覆盖到仍有新数据的目录。升级前先备份，然后执行：

```sh
git pull
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 ccr
```

### 常见排查

- `/` 返回 `302`：正常，Nginx 正在跳转到带管理 Token 的页面。
- `/health` 返回 `502`：它检查的是模型网关；首次启动尚未配置模型时属于预期行为。
- 修改 Token 后 UI 返回 `401`：重新打开不带参数的根地址，关闭仍使用旧 Token 的标签页。
- 模型响应长时间无输出后一次性吐出：外部反代开启了缓冲。对流式路由设置 `proxy_buffering off`（以及 `proxy_request_buffering off`），保留较长的 `proxy_read_timeout` / `proxy_send_timeout` 后重载代理。改动只放在该代理自己的配置文件里——在宝塔等面板里重新保存站点可能重置站点主配置。
- HTTPS 可用但应用仍使用 `http://` 地址：把 `CCR_PUBLIC_BASE_URL` 设为精确的 `https://` 地址并重建容器，让 CCR 在启动时重新同步已存的公开地址。
- 重建后配置消失：检查是否仍挂载同一个 `/data` 卷；`docker compose down --volumes` 会删除数据卷。
- 容器健康但模型请求失败：继续检查服务状态、供应商连通性、CCR 客户端 Key、路由和请求日志；容器健康只表示 Nginx / UI 可访问。

完整的环境变量、端口拓扑、远程部署、构建参数和烟雾测试说明见本页英文主体，对应变量名和命令在中英文环境中完全相同。
