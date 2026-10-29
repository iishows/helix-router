# CCR 离线部署包

面向宝塔面板 / 任意 Linux 主机的自包含发布包。解压后无需源码、无需联网拉镜像。

## 包内文件

| 文件 | 用途 |
| --- | --- |
| `ccr-<版本>-image.tar.gz` | 容器镜像归档，`docker load` 后 tag 为 `helix-compressor:local` |
| `docker-compose.server.yml` | 编排文件，已指向上面的镜像 tag，无需改 |
| `install.sh` | 一键安装：加载镜像 → 生成 `.env` → 启动 → 打印地址 |
| `.env.example` | 环境变量模板（手工部署时参考） |
| `README.md` | 本文件 |
| `SHA256SUMS` | 归档校验和 |

## 快速开始

```sh
tar xzf ccr-<版本>-release.tar.gz
cd ccr-<版本>-release
sh install.sh
```

脚本会打印容器的启动状态和管理界面地址。默认监听 `127.0.0.1:3458`，**公网访问不到**，必须再配宿主反代。

安装前建议先设定公开地址，避免装完再改：

```sh
CCR_PUBLIC_BASE_URL=https://ccr.example.com sh install.sh
```

`install.sh` 是幂等的：重复执行只做「加载镜像 + 启动」，不会覆盖已有的 `.env`。要轮换管理 token，删除 `.env` 后重跑。

## 前置条件

- Docker Engine（宝塔面板：「Docker」→ 安装）
- Docker Compose 插件（宝塔面板可在 Docker 页启用；脚本也兼容独立的 `docker-compose`）
- `openssl`（仅首次生成 token 和登录密码时用；没有它就得手写 `.env`）

## 手动部署（不用 install.sh）

```sh
docker load -i ccr-<版本>-image.tar.gz

# 生成 .env，权限收紧
cp .env.example .env
chmod 600 .env
# 编辑 .env：填 CCR_PUBLIC_BASE_URL，CCR_WEB_LOGIN_PASSWORD 换成随机密码
openssl rand -base64 24       # 用这条生成登录密码
# CCR_WEB_AUTH_TOKEN 留空即可，容器启动时自动随机生成（只有脚本/反代调用才需要）

docker compose -f docker-compose.server.yml up -d
docker compose -f docker-compose.server.yml ps
```

## 架构与端口

```text
宿主 :3458 -> 容器 Nginx :8080
                        |-> 管理界面（静态）
                        |-> 管理 RPC: 127.0.0.1:3459
                        `-> 网关:    127.0.0.1:3456
```

只有 Nginx 的 `8080` 会发布出来，其余两个内部端口属于容器实现细节。容器端口**只绑回环**，公网出口靠宿主 Nginx。

## 反代配置（关键）

容器自带 Nginx，宿主 Nginx 只负责终止 TLS 并转发。

把反代配置里的 `location` 主体替换为下面这段。面板默认模板会**缓冲响应并中断模型流**（表现为响应迟迟不来、然后一次性吐完），必须替换：

```nginx
location / {
  proxy_pass http://127.0.0.1:3458;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;

  # 模型流、SSE、recall 都不能被缓冲。
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;

  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

### 宝塔面板步骤

1. **网站**：为域名建站（纯静态即可，不需要 PHP/数据库），申请 Let's Encrypt 证书，开启**强制 HTTPS**。
2. **反向代理**：目标 URL 填 `http://127.0.0.1:3458`，发送域名填 `$host`。
3. **编辑生成的代理配置**（反向代理 → 配置文件，通常在 `/www/server/panel/vhost/nginx/proxy/<域名>/<名称>.conf`），用上面的片段替换 `location` 主体。自定义规则放这个文件里，别混进站点主配置——重新保存站点可能会重置它。
4. `nginx -t && nginx -s reload`（或面板的「重载配置」）。

宿主防火墙只放行 `443`。

## 管理端鉴权

**默认（`CCR_WEB_INJECT_HEADER=0`）** —— 密码登录。容器把未登录的 `/` 302 到 `/pages/login/index.html`；浏览器提交密码（`POST /api/ccr/login`）后拿到 `HttpOnly` 会话 cookie（12 小时），之后凭 cookie 访问管理台和 RPC。密码取自 `CCR_WEB_LOGIN_PASSWORD`；该变量为空时容器首次启动会自动生成一个随机密码，持久化到数据卷 `.claude-code-router/web-login-password`，并打印在启动日志里：

```sh
docker compose -f docker-compose.server.yml logs ccr | grep 'login password'
```

URL 里不含任何凭据，浏览器历史/截图都不会泄露 token。

**加固（`CCR_WEB_INJECT_HEADER=1`）** —— 不在容器内登录，改由反代注入 token：

```nginx
proxy_set_header x-ccr-web-auth "<CCR_WEB_AUTH_TOKEN>";
```

浏览器拿不到 token 时就不带该头，反代注入的头照样通过鉴权；不带头的 RPC 仍由核心服务返回 `401`，所以容器端口意外暴露时是失败关闭的。

**加固模式的前提**：反代是无条件注入 token 的，因此**任何能访问该站点的人都等于管理员**。必须在该反代之前再加一层访问限制——HTTP Basic（宝塔：**站点 → 访问限制**）、SSO 前置鉴权（oauth2-proxy、Cloudflare Access）或私网/VPN。缺了这层，等于把管理台裸奔在公网上。

注入的 token 会写进容器 Nginx 配置，所以**不能含双引号**。`openssl rand -hex 32` 产出的十六进制串是安全的。

## 数据与备份

容器内 `HOME=/data`，CCR 把文件存在：

```text
/data/.claude-code-router/
├── config.sqlite
├── gateway.config.json
├── app-data/          (api-keys / request-logs / usage / certs)
├── profiles/
└── bin/
```

数据在具名卷 `ccr-data` 里。应用层最稳妥的备份是界面里的 **设置 → 导出数据**；整卷备份则先停写：

```sh
docker compose -f docker-compose.server.yml stop ccr
docker compose -f docker-compose.server.yml cp ccr:/data/. ./ccr-data-backup/
docker compose -f docker-compose.server.yml start ccr
```

备份含密钥和请求数据，注意保管。恢复时用**全新的空卷或空 `/data`**，别把旧备份覆盖到已在用的卷上——陈旧的 SQLite WAL/SHM 会造成数据不一致。

## 升级

解压新版本包（解到**新目录**即可，不必覆盖旧目录），把旧 `.env` 拷过来，再重建容器：

```sh
tar xzf ccr-<新版本>-release.tar.gz
cp <旧版本目录>/.env ccr-<新版本>-release/.env     # 必须：沿用原管理 token
docker load -i ccr-<新版本>-release/ccr-<新版本>-image.tar.gz
docker compose -f ccr-<新版本>-release/docker-compose.server.yml up -d
```

**为什么必须拷 `.env`**：`.env` 存放在包目录里，新目录默认没有它。若缺了它，`install.sh` 会生成一个**新的**管理 token —— 旧 token 与反代里注入的值同时失效，管理台立刻 `401`。为防手滑，容器已存在而目录里没有 `.env` 时，`install.sh` 会**拒绝执行**并提示拷贝；确实要轮换 token 时用 `CCR_ALLOW_NEW_TOKEN=1 sh install.sh` 放行。

**数据不受影响**：compose 里固定了项目名 `name: ccr` 和卷名 `name: ccr-data`，**与解压目录无关**，所以各版本可以各解压到自己的目录、共享同一个卷。不要删掉这两处 `name:` —— 删掉后卷名会退回默认的 `<解压目录名>_ccr-data`，升级解压到新目录就会以**空 `/data`** 启动，表现为"配置全丢了"。

回滚同理：加载旧版本镜像归档，用旧目录里的 compose `up -d`。升级前建议先按上一节备份 `/data`。

## 校验归档

```sh
sha256sum -c SHA256SUMS
```

## 常见排查

| 现象 | 原因 |
| --- | --- |
| `/` 返回 `302` | 正常，正在跳转到登录页（未登录时） |
| `/health` 返回 `502` | 正常。这是**网关**健康检查，配好供应商并启动网关前一直是 502 |
| UI 返回 `401` | 会话过期或 `CCR_WEB_LOGIN_PASSWORD` 改过但容器没重建：重新登录或 `docker compose up -d` |
| 不知道登录密码 | `docker compose -f docker-compose.server.yml logs ccr \| grep 'login password'`，或在 `.env` 里手动设 `CCR_WEB_LOGIN_PASSWORD` |
| 响应长时间无输出后一次性吐完 | 反代在缓冲，`proxy_buffering off` 没生效 |
| HTTPS 正常但应用仍用 `http://` 地址 | `CCR_PUBLIC_BASE_URL` 没设成公开的 `https://` 地址 |
| 重建后有配置丢失 | 卷没挂上，或用了 bind mount 但权限不对 |
| 容器健康但模型请求全失败 | 供应商/模型没配或密钥失效，看 `docker compose logs ccr` |

```sh
docker compose -f docker-compose.server.yml logs -f ccr
docker compose -f docker-compose.server.yml config
```

完整文档见仓库 `docker/README.md`。
