/**
 * 出正式发布包（三个域名各一份）+ 验签 + 打印上传命令。
 *
 * 用法：
 *   node release-apk.mjs            # site org com 三个都出
 *   node release-apk.mjs com        # 只出 com
 *
 * 为什么要有这个脚本而不是直接跑 `npm run build:apk:*`：
 *   APK 的签名密钥一旦与线上不一致，**已安装用户无法覆盖升级**，必须卸载重装（登录状态全丢）。
 *   所以发布前必须验签：脚本会把包内证书指纹与线上已发布包的指纹（下面 EXPECTED_CERT_SHA256）比对，
 *   不一致就直接失败退出。（换密钥确实是唯一选项时，用 --force-fingerprint 显式确认。）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 线上 v1.2~v1.5 包内的证书指纹（见 README「签名信息」），新包必须同源。 */
const EXPECTED_CERT_SHA256 = "953d3d441ee45adbb90e40ad8f5da266ceeef8925b256d0d5f4f5930d712d019";

/** 每个域名上传到各自 Web 根下的文件名，以及下载页里要同步改的那一行。 */
const TARGETS = {
  site: { host: "count168.site", upload: "/var/www/count168/app" },
  org: { host: "count168.org", upload: "/var/www/count168.org/app" },
  com: { host: "count168.com", upload: "/var/www/count168.com/app" },
};

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const domains = args.length ? args : ["site", "org", "com"];
const force = process.argv.includes("--force-fingerprint");

for (const d of domains) {
  if (!TARGETS[d]) {
    console.error(`未知域名 "${d}"（可选：${Object.keys(TARGETS).join(" / ")}）`);
    process.exit(1);
  }
}

const run = (cmd, cmdArgs, cwd, extraEnv) =>
  execFileSync(cmd, cmdArgs, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  });

function readSdkDir() {
  try {
    const props = fs.readFileSync(path.join(here, "android", "local.properties"), "utf8");
    const m = props.match(/^\s*sdk\.dir\s*=\s*(.+?)\s*$/m);
    return m ? m[1].replace(/\\:/g, ":").replace(/\\\\/g, "/") : "";
  } catch {
    return "";
  }
}

/** build-tools 下的 apksigner（Windows 上是 .bat）。 */
function apksigner() {
  const sdk = readSdkDir() || process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
  const btDir = path.join(sdk, "build-tools");
  const versions = fs.existsSync(btDir)
    ? fs.readdirSync(btDir).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    : [];
  for (const v of versions) {
    const exe = path.join(btDir, v, process.platform === "win32" ? "apksigner.bat" : "apksigner");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/* 1) 签名配置必须在位——否则 Gradle 出的是 unsigned 包，装了等于没签，用户也无法升级。 */
const keystoreProps = path.join(here, "android", "keystore.properties");
if (!fs.existsSync(keystoreProps)) {
  console.error(
    [
      "",
      "!! 找不到 android/keystore.properties —— 无法出正式包（Gradle 只会产出 unsigned APK）。",
      "",
      "在该文件（已 gitignore，勿提交）写入四行，路径按你的实际情况：",
      "  storeFile=../../keystore/eazycount.keystore",
      "  storePassword=eazycount2026",
      "  keyAlias=eazycount",
      "  keyPassword=eazycount2026",
      "",
      "密钥（keystore/eazycount.keystore）不在 git 里；README 记录服务器备份位置：",
      "  /home/ec2-user/eazycount.keystore.backup-2026-09-11",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const gradle = fs.readFileSync(path.join(here, "android", "app", "build.gradle"), "utf8");
const versionName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1] || "?";
const versionCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1] || "?";
const signer = apksigner();

console.log(`==> 出包版本 ${versionName} (versionCode ${versionCode})：${domains.join(", ")}`);
if (!signer) console.warn("（找不到 apksigner，跳过验签；请在 build-tools 里确认）");

const sdk = readSdkDir();
const env = sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {};
const built = [];

for (const d of domains) {
  console.log(`\n=== ${d} ===`);
  run("node", ["build-apk-for-site.mjs", d], here, env);
  const apk = path.join(here, "dist-apk", `EazyCount-v${versionName}-${d}.apk`);
  if (!fs.existsSync(apk)) {
    console.error(`!! 预期产物不存在：${apk}`);
    process.exit(1);
  }
  built.push({ d, apk });
}

/* 2) 验签：指纹不一致 = 用户必须卸载重装，必须在发布前发现。 */
let failed = false;
for (const { d, apk } of built) {
  if (!signer) continue;
  let out = "";
  try {
    /* Windows 上 .bat 必须经 shell 启动，否则 Node 直接抛 EINVAL（拿不到任何输出）。 */
    out = execFileSync(signer, ["verify", "--print-certs", apk], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  const digest = (out.match(/SHA-256 digest:\s*([0-9a-f]+)/i) || [])[1];
  const dn = (out.match(/DN:\s*(.+)/) || [])[1] || "?";
  const ok = digest === EXPECTED_CERT_SHA256;
  console.log(
    `${ok ? "OK  " : "BAD "} ${path.basename(apk)}  signer=${dn}  sha256=${digest || "?"}${
      ok ? "" : `  (期望 ${EXPECTED_CERT_SHA256})`
    }`,
  );
  if (!ok) failed = true;
}

if (failed) {
  console.error(
    [
      "",
      "!! 签名证书与线上包不一致 —— 现在的包无法覆盖已安装的 App，用户必须卸载重装。",
      "   要么用正确的密钥重新出包，要么确认「就是换密钥」后用 --force-fingerprint 重跑。",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/* 3) 上传与下载页：顺序很重要——先上传 APK，再改下载页链接，否则用户点下载会 404。 */
console.log("\n==> 下一步（顺序不能反）：");
for (const { d } of built) {
  const t = TARGETS[d];
  console.log(
    [
      `\n# ${d} (${t.host})`,
      `scp -i ~/.ssh/count168-ec2.pem dist-apk/EazyCount-v${versionName}-${d}.apk \\`,
      `    ec2-user@56.68.48.190:${t.upload}/EazyCount-v${versionName}.apk`,
      `# 上传确认后，改 install-page/index.html 里 ${t.host} 那一页的下载链接：`,
      `#   href="EazyCount-v${versionName}.apk?v=${versionCode}"`,
      `# 然后 git push（deploy 会自动发布下载页），再用手机扫下载页二维码验证一次。`,
    ].join("\n"),
  );
}
