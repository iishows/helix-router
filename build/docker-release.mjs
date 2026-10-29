import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "./docker-local-gateway.mjs";

// 打一个自包含的服务器部署包：镜像归档 + compose + 安装脚本 + 说明。
//
// 之所以要做成脚本而不是手工拼：上一版发布的 tar 里只有镜像，compose 文件
// 根本没进包，而且 compose 注释里写的镜像文件名是 ccr-3.1.6-amd64.tar —— 连
// 仓库里编译出来的 ccr-3.1.6-helix-default.tar.gz 都对不上。手工拼装每次都会
// 重新引入这类"包内文件互相不一致"的漂移，所以这里把一致性做成断言。
//
// 用法：
//   npm run docker:release                # 用 helix-compressor:local
//   npm run docker:release -- --image=foo:bar
//   npm run docker:release -- --skip-save  # 复用已有的 release/ 暂存目录

// 模板放在 docker/deploy/ 而非 docker/release/：.gitignore 第 4 行的 `release`
// 模式会匹配任意层级的同名目录，放 release/ 下会被忽略、导致新克隆上打包失败。
const releaseTemplateDir = path.join(projectRoot, "docker", "deploy");
const releaseRoot = path.join(projectRoot, "release");
const composeSource = path.join(projectRoot, "docker-compose.server.yml");

const args = process.argv.slice(2);
const imageOverride = args.find((a) => a.startsWith("--image="))?.slice("--image=".length);
const skipSave = args.includes("--skip-save");

const packageJson = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")
);
const version = packageJson.version;
const imageTag = imageOverride || process.env.CCR_DOCKER_IMAGE || "helix-compressor:local";
const imageName = `ccr-${version}-image.tar.gz`;
const bundleName = `ccr-${version}-release`;
const bundlePath = path.join(releaseRoot, `${bundleName}.tar.gz`);

function log(message) {
  console.log(`[docker:release] ${message}`);
}

function fail(message) {
  console.error(`[docker:release] 错误: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    // capture 时要接管管道才能读到 stdout；否则直接透传到当前终端。
    stdio: options.capture ? "pipe" : "inherit",
    cwd: options.cwd ?? projectRoot,
    env: options.env,
    encoding: options.capture ? "utf8" : undefined
  });
  if (result.error) fail(`执行 ${command} 失败: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${commandArgs.join(" ")} 退出码 ${result.status}`);
  return options.capture ? (result.stdout ?? "").trim() : "";
}

// docker save 的输出格式随存储驱动变化（containerd 镜像存储产出 OCI 归档，
// 经典 overlay2 产出 docker-archive）。两者都能被 docker load 读回，所以这里
// 不假设格式，而是加载后回读来确认 tag。
const stagingDir = path.join(releaseRoot, bundleName);

if (skipSave) {
  // 复用上次的镜像归档：不清理暂存目录，省掉重新 save 的几分钟。
  if (!fs.existsSync(stagingDir)) {
    fail(`--skip-save 需要 ${path.relative(projectRoot, stagingDir)} 已存在。`);
  }
  const existing = fs.readdirSync(stagingDir).filter((f) => f.endsWith("-image.tar.gz"));
  if (existing.length !== 1) {
    fail(`--skip-save 需要暂存目录里恰好有一个镜像归档，实际 ${existing.length} 个。`);
  }
  log(`--skip-save：复用 ${existing[0]}。`);
} else {
  fs.rmSync(releaseRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  log(`导出镜像 ${imageTag} -> ${imageName}`);
  run("docker", ["image", "inspect", imageTag, "--format", "{{.Id}}"], { capture: true });
  // 位置参数 ($1/$2) 而非字符串插值：镜像名可能来自环境变量，不拼进 shell 源码。
  run("sh", ["-c", 'docker save "$1" | gzip -1 > "$2"', "sh", imageTag, imageName], {
    cwd: stagingDir
  });
}

const imageTarPath = path.join(stagingDir, imageName);
if (!fs.existsSync(imageTarPath)) {
  fail(`镜像归档没有生成：${path.relative(projectRoot, imageTarPath)}`);
}

// 归档要经网络传输再在服务器上 docker load；先自检 gzip 完整性，
// 免得把一个截断的文件发出去。
log("校验镜像归档完整性");
run("gzip", ["-t", imageName], { cwd: stagingDir });

// ---------- 组装包内容 ----------
log("复制 compose / 安装脚本 / 说明文件");
fs.copyFileSync(composeSource, path.join(stagingDir, "docker-compose.server.yml"));
for (const file of ["install.sh", ".env.example", "README.md"]) {
  fs.copyFileSync(path.join(releaseTemplateDir, file), path.join(stagingDir, file));
}

// install.sh 会被服务器上的 sh 执行；CRLF 的 shebang/续行都会炸。
// 这里强制 LF，和仓库 .gitattributes 对 *.sh 的处理保持一致。
for (const script of ["install.sh"]) {
  const target = path.join(stagingDir, script);
  const content = fs.readFileSync(target, "utf8").replace(/\r\n/g, "\n");
  fs.writeFileSync(target, content);
}
fs.chmodSync(path.join(stagingDir, "install.sh"), 0o755);

// ---------- 一致性断言 ----------
// 这三条断言就是本次要修的那类漂移：包里的 compose 必须真能跑起来指向的镜像，
// 文档里写的镜像文件名必须真的存在。

const composeText = fs.readFileSync(path.join(stagingDir, "docker-compose.server.yml"), "utf8");
const composeImageMatch = composeText.match(/^\s*image:\s*(\S+)\s*$/m);
if (!composeImageMatch) fail("docker-compose.server.yml 里找不到 image: 字段。");
const composeImage = composeImageMatch[1];

if (composeImage !== imageTag) {
  fail(
    `compose 指向 ${composeImage}，但打包的镜像是 ${imageTag}。` +
      `服务器上 docker load 之后 compose 会起不来。`
  );
}
log(`断言通过：compose image 与镜像 tag 一致 (${composeImage})。`);

// compose 注释里若写死了归档文件名，必须与包里实际的名字一致。
// 允许 ccr-<版本>-image.tar.gz 这种带占位符的抽象写法 —— 它不随发版漂移。
// 这里只拦"写死了一个具体版本号，但和实际产物对不上"的情况，
// 因为上一版包就是这么坏的（注释写 ccr-3.1.6-amd64.tar，产物却是别的名字）。
const hardcodedTarRefs = [...composeText.matchAll(/ccr-(\d+\.\d+\.\d+)[\w.\-]*\.tar(?:\.gz)?/g)].map(
  (m) => m[0]
);
const mismatchedRefs = hardcodedTarRefs.filter((name) => name !== imageName);
if (mismatchedRefs.length > 0) {
  fail(
    `compose 注释里写死了一个不存在于包内的归档名 ${[...new Set(mismatchedRefs)].join(", ")}；` +
      `实际包内是 ${imageName}。请改成 ccr-<版本>-image.tar.gz 这种不写死版本号的写法。`
  );
}
log("断言通过：compose 注释没有指向不存在的归档名。");

// install.sh 是按 ccr-*-image.tar.gz 模式找归档的，因此不得出现具体版本号 ——
// 否则每次发版都要改脚本，早晚改漏。
// 判据只认 "ccr- 后面跟数字" 和当前版本号字面量，不要用宽泛的 \d+\.\d+\.\d+，
// 那个会误伤 127.0.0.1 这类正常内容。
for (const file of ["install.sh", "README.md"]) {
  const text = fs.readFileSync(path.join(stagingDir, file), "utf8");
  if (/ccr-\d/.test(text)) {
    fail(`${file} 里写死了带版本号的归档名（ccr-<数字>），发版会漂移。用 ccr-<版本> 占位。`);
  }
  if (text.includes(version)) {
    fail(`${file} 里出现了当前版本号 ${version}，发版会漂移。用 ccr-<版本> 占位。`);
  }
}
log("断言通过：install.sh / README.md 没有写死版本号。");

// compose 必须固定项目名与卷名。否则二者都取自解压目录名，而发布包目录是
// ccr-<版本>-release —— 升级时解压到新目录，具名卷跟着改名，容器以空 /data
// 启动，用户看到的是"配置全丢了"。
//
// 直接校验 docker compose 解析后的结果，而不是正则匹配 YAML 文本：
// 文本里插注释、换写法都会让正则失效，解析结果才是真正生效的东西。
const resolvedConfig = run("docker", ["compose", "-f", "docker-compose.server.yml", "config"], {
  cwd: stagingDir,
  capture: true,
  env: { ...process.env, CCR_WEB_AUTH_TOKEN: "release-assertion-placeholder" }
});
if (!/^name:\s*ccr\s*$/m.test(resolvedConfig)) {
  fail("compose 解析后项目名不是 ccr，会随解压目录漂移。");
}
if (!/^\s+name:\s*ccr-data\s*$/m.test(resolvedConfig)) {
  fail("compose 解析后 ccr-data 卷没有固定 name，升级会换卷导致丢配置。");
}
log("断言通过：解析后项目名 ccr、卷名 ccr-data 均已固定。");

// ---------- 计算校验和并打包 ----------
log("计算 SHA256SUMS");
const checksumLines = [];
for (const file of fs.readdirSync(stagingDir).sort()) {
  if (file === "SHA256SUMS") continue;
  const digest = run("sh", ["-c", 'sha256sum "$1"', "sh", file], {
    cwd: stagingDir,
    capture: true
  });
  checksumLines.push(digest);
}
fs.writeFileSync(path.join(stagingDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);

log(`打包 ${bundleName}.tar.gz`);
// 镜像本身已是 gzip，外层再压一遍收益极小却要花几分钟，因此外层用 gzip -1。
// 直接管到文件，不把 140MB 灌进 Node 内存。
run("sh", ["-c", 'tar -cf - "$1" | gzip -1 > "$1.tar.gz"', "sh", bundleName], {
  cwd: releaseRoot
});

const bundleSize = fs.statSync(bundlePath).size;
log(`完成: ${path.relative(projectRoot, bundlePath)} (${(bundleSize / 1024 / 1024).toFixed(1)} MB)`);
log(`包含: ${imageName} + docker-compose.server.yml + install.sh + .env.example + README.md + SHA256SUMS`);
