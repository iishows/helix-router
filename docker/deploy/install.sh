#!/bin/sh
# CCR 离线发布包一键安装（宝塔 / 任意 Linux 主机）。
#
# 做四件事：加载镜像 → 生成 .env → 启动容器 → 打印访问地址。
# 幂等：重复执行不会覆盖已有的 .env，只做 load + up。
#
# 用法：
#   sh install.sh                       # 默认：管理台用密码登录（见 docker/README.md）
#   CCR_WEB_INJECT_HEADER=1 sh install.sh   # 加固：不在容器内登录，由反代注入 header
#   CCR_PUBLIC_BASE_URL=https://ccr.example.com sh install.sh

set -eu

IMAGE_TAG="helix-compressor:local"
PACKAGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
COMPOSE_FILE="$PACKAGE_DIR/docker-compose.server.yml"
ENV_FILE="$PACKAGE_DIR/.env"

log() { printf '[ccr-install] %s\n' "$1"; }
die() { printf '[ccr-install] 错误: %s\n' "$1" >&2; exit 1; }

# ---------- 前置检查 ----------
command -v docker >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker Engine。"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "未找到 docker compose 插件。宝塔面板可在「Docker → 安装」里启用 compose。"
fi

[ -f "$COMPOSE_FILE" ] || die "compose 文件缺失：$COMPOSE_FILE"

# 按模式查找镜像归档，不写死版本号，故本脚本无需随发版改写。
# 注意：glob 无匹配时 $1 是字面量模式本身，请求数会是 1，所以必须再验 -f。
IMAGE_TAR=""
for candidate in "$PACKAGE_DIR"/ccr-*-image.tar.gz; do
  [ -f "$candidate" ] || continue
  [ -z "$IMAGE_TAR" ] || die "目录下有多个镜像归档，无法确定用哪个：请只保留一个 ccr-*-image.tar.gz。"
  IMAGE_TAR="$candidate"
done
[ -n "$IMAGE_TAR" ] || die "找不到镜像归档（应为 $PACKAGE_DIR/ccr-*-image.tar.gz）。请确认已完整解压发布包。"

# ---------- 加载镜像 ----------
log "加载镜像 $(basename -- "$IMAGE_TAR") ..."
# docker load 自己识别 gzip，无需先解压。
docker load -i "$IMAGE_TAR"

docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 \
  || die "镜像加载后仍找不到 $IMAGE_TAG，归档可能损坏。"

# ---------- 生成 .env ----------
if [ -f "$ENV_FILE" ]; then
  log ".env 已存在，保持不变（如需轮换 token，删掉 .env 后重跑本脚本）。"
else
  # 升级陷阱：把新版本解压到新目录后再跑本脚本时，包里没有 .env。若这里
  # 直接生成新 token，老 token 会失效——反代里注入的还是老值，管理台立刻 401。
  # 所以只要已经存在 CCR 容器，就认定这是升级，停下来让人把旧 .env 拷过来。
  if [ -n "$(docker ps -aq --filter "name=^ccr$" 2>/dev/null)" ] \
     && [ "${CCR_ALLOW_NEW_TOKEN:-0}" != "1" ]; then
    die "检测到已存在名为 ccr 的容器，但本目录没有 .env —— 这看起来是升级。
     直接继续会生成新管理 token，使旧 token 与反代里注入的值同时失效。

     升级请执行：
       cp <旧版本目录>/.env $PACKAGE_DIR/.env     # 沿用原 token
       sh install.sh

     确认就是要轮换 token（例如 token 疑似泄露）时，加环境变量放行：
       CCR_ALLOW_NEW_TOKEN=1 sh install.sh
     轮换后记得同步更新反代里注入的 x-ccr-web-auth。

     提示：从旧版本（无 CCR_WEB_LOGIN_PASSWORD）升级过来的 .env 不含登录密码，
     容器首次启动会自动生成一个并持久化到数据卷，用这条命令查看：
       docker logs ccr | grep 'login password'"
  fi

  command -v openssl >/dev/null 2>&1 \
    || die "未找到 openssl，无法生成管理 token。请先安装，或手写 .env（参考 .env.example）。"

  TOKEN=$(openssl rand -hex 32)
  LOGIN_PASSWORD=$(openssl rand -base64 24 | tr -d '\n')
  PUBLIC_BASE_URL=${CCR_PUBLIC_BASE_URL:-http://127.0.0.1:3458}

  # 先落盘再 chmod，避免凭据有一段短暂的可读窗口。
  ( umask 077; cat > "$ENV_FILE" <<EOF
# 由 install.sh 生成于首次安装。改动后需 docker compose up -d 重启生效。
CCR_PUBLIC_BASE_URL=$PUBLIC_BASE_URL
CCR_WEB_AUTH_TOKEN=$TOKEN
CCR_WEB_LOGIN_PASSWORD=$LOGIN_PASSWORD
CCR_WEB_INJECT_HEADER=${CCR_WEB_INJECT_HEADER:-0}
EOF
  )
  chmod 600 "$ENV_FILE"
  log "已生成 .env（权限 600，token 与登录密码均已随机化）。"
fi

# ---------- 启动 ----------
log "启动容器 ..."
$COMPOSE -f "$COMPOSE_FILE" up -d

# ---------- 结果 ----------
log "当前状态："
$COMPOSE -f "$COMPOSE_FILE" ps

cat <<EOF

------------------------------------------------------------------------
CCR 已启动。

管理界面（仅本机可访问，需经宿主 Nginx 反代才能公网使用）：
  http://127.0.0.1:3458

登录密码与管理 token 存放于：
  $ENV_FILE
  变量名分别为 CCR_WEB_LOGIN_PASSWORD（浏览器登录用）和 CCR_WEB_AUTH_TOKEN（脚本/反代用）。
  浏览器首次打开管理台会跳转到登录页，输入上面那个密码即可。

下一步：
  1) 在宝塔为域名建站 + 申请证书 + 开强制 HTTPS
  2) 反向代理到 http://127.0.0.1:3458
  3) 把反代配置里的 location 主体换成包内 README.md 的 Nginx 片段
     （面板默认模板会缓冲响应、中断模型流，必须替换）

详见包内 README.md。
------------------------------------------------------------------------
EOF
