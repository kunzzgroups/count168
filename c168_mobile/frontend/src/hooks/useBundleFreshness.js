import { useEffect } from "react";

/**
 * App 回到前台时比对线上包与正在运行的包，**不一致就自动重载**。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────
 *
 * 安卓 WebView 会把已加载的页面留在内存里：从任务切换器切回来**不会重新加载** ✗
 * 于是「改了代码，设备上却毫无变化」—— 实机反复出现过，最近一次设备上显示
 * `[b19]` 而线上早已是 `[b22]`，中间三轮修复一次都没到达 ✗
 *
 * 注意 `index.html` 本身是 `Cache-Control: no-cache` ✓，**冷启动时确实拿到新包** ✓
 * 问题只出在「不冷启动」。所以这里只需要处理 resume。
 *
 * ── 实现 ──────────────────────────────────────────────────────────
 *
 * 构建产物里 index.html 引用的是带哈希的 JS（`assets/index-XXXX.js`）；
 * 当前跑哪一个可以从 `<script type="module">` 的 src 读出来 ✓
 * 于是：拉一次 index.html（no-store）→ 取出最新哈希 → 与当前不同就 reload。
 */
export function useBundleFreshness() {
  useEffect(() => {
    // 开发服务器没有这个目录结构，直接不启用
    if (!import.meta.env.PROD) return undefined;

    let checking = false;

    const check = async () => {
      if (checking || document.visibilityState !== "visible") return;

      // 锁屏 / 正在弹生物识别时绝不重载 —— 会把用户正在做的验证打断
      if (document.querySelector(".bio-lock")) return;

      checking = true;
      try {
        const current =
          document.querySelector('script[type="module"]')?.getAttribute("src") || "";
        const res = await fetch("index.html", { cache: "no-store" });
        if (!res.ok) return;
        const html = await res.text();
        const latest = (html.match(/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0];

        // 拿不到哈希就什么都不做（宁可停在旧包，也不要在不确定时重载）
        if (!latest || !current) return;
        if (current.includes(latest)) return;

        // 已确认线上是新的：重载，用户下次看到的就是新包
        window.location.reload();
      } catch {
        /* 网络失败就下次再说，不影响使用 */
      } finally {
        checking = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };

    // 冷启动也查一次（不影响首屏：它是异步的，且只在确认有新版时才重载）
    void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}
