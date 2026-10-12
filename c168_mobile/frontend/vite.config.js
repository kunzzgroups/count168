import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";

/**
 * `build <sha> · MM-DD HH:mm`, shown in the login corner.
 *
 * Why it is worth a line of pixels: the phone app is a remote SPA, so it keeps running its old
 * bundle until the page actually reloads. "Still broken after the fix" is very often "still the old
 * bundle", and without a marker there is no way to tell from a bug report.
 */
function resolveBuildId() {
  let sha = "dev";
  try {
    /* `--dirty` matters: dist is committed together with the source change, so at build time the
       tree usually still has that change uncommitted — the marker must not claim a clean revision. */
    sha = execSync("git describe --always --abbrev=7 --dirty", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .replace(/-dirty$/, "+");
  } catch {
    /* not a git checkout — keep "dev" */
  }
  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  return `${sha} · ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Cloudflare Rocket Loader breaks Vite ES modules on count168.site */
function cloudflareModuleFix() {
  return {
    name: "cloudflare-module-fix",
    transformIndexHtml(html) {
      return html
        .replace(
          /<script type="module"(?![^>]*data-cfasync)/g,
          '<script type="module" data-cfasync="false"',
        )
        .replace(
          /<link rel="stylesheet"(?![^>]*data-cfasync)/g,
          '<link rel="stylesheet" data-cfasync="false"',
        );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const phpTarget = env.VITE_PHP_PROXY_TARGET || "http://127.0.0.1:8000";

  return {
    plugins: [react(), tailwindcss(), cloudflareModuleFix()],
    define: { __BUILD_ID__: JSON.stringify(resolveBuildId()) },
    base: mode === "production" ? "/c168_mobile/frontend/dist/" : "/",
    server: {
      port: 5174,
      strictPort: true,
      proxy: {
        "/api": { target: phpTarget, changeOrigin: true },
        "/dashboard.php": { target: phpTarget, changeOrigin: true },
        "/member.php": { target: phpTarget, changeOrigin: true },
        "/reset-password": { target: phpTarget, changeOrigin: true },
        "/images": { target: phpTarget, changeOrigin: true },
        "/js": { target: phpTarget, changeOrigin: true },
        // SSE hub (services/tx-realtime); same path nginx uses in production.
        // nginx strips the /realtime prefix; the hub only serves /sse and /publish.
        "/realtime": {
          target: env.VITE_REALTIME_PROXY_TARGET || "http://127.0.0.1:3911",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/realtime/, ""),
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
