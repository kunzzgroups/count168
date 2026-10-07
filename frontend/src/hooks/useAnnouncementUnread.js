import { useCallback, useEffect, useRef, useState } from "react";
import { buildApiUrl } from "../utils/core/apiUrl.js";
import { useRealtimeDomain } from "../lib/realtime/useRealtimeDomain.js";
import { REALTIME_DOMAINS } from "../lib/realtime/realtimeEvents.js";

const UNREAD_COUNT_URL = "api/announcements/announcement_unread_count_api.php";
const MARK_READ_URL = "api/announcements/announcement_mark_read_api.php";

/**
 * 侧边栏铃铛未读数 —— 按登录账号、由后端保存和计算（与公司 / 浏览器 / 设备无关）。
 *
 * 身份取自 PHP session，前端只传 `me` 用来判断是否登录；IT 账号后端恒返回 0。
 *
 * @param {object|null} me 当前登录用户（用 user_id 判定账号切换）
 * @param {number} [pollMs] 轮询间隔；没挂 AppRealtimeBridge 的壳（会员自助壳）用它兜底
 * @returns {{ unreadCount: number, markRead: () => Promise<void>, refresh: () => Promise<void> }}
 */
export function useAnnouncementUnread(me, pollMs = 0) {
  const [unreadCount, setUnreadCount] = useState(0);
  /** 序号防旧响应覆盖：刷新和 markRead 都会递增，返回时序号不一致就丢弃。 */
  const requestSeqRef = useRef(0);
  const ownerKey = me ? String(me.user_id ?? me.id ?? "") : "";

  const refresh = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    try {
      const res = await fetch(buildApiUrl(UNREAD_COUNT_URL), {
        credentials: "include",
        cache: "no-store",
      });
      const json = await res.json();
      if (seq !== requestSeqRef.current) return;
      const count = Number(json?.data?.unreadCount);
      setUnreadCount(Number.isFinite(count) && count > 0 ? count : 0);
    } catch {
      /* 网络失败保留上一次的数字，不闪成 0 */
    }
  }, []);

  useEffect(() => {
    if (!ownerKey) {
      requestSeqRef.current += 1;
      setUnreadCount(0);
      return;
    }
    refresh();
  }, [ownerKey, refresh]);

  // 有 AppRealtimeBridge 的壳：公告增删改广播到达即刷新。
  useRealtimeDomain([REALTIME_DOMAINS.ANNOUNCEMENTS], refresh, { enabled: Boolean(ownerKey) });

  // 没有实时总线的壳（会员自助壳）：轮询兜底，页面隐藏时跳过。
  useEffect(() => {
    if (!ownerKey || !pollMs) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, pollMs);
    return () => clearInterval(timer);
  }, [ownerKey, pollMs, refresh]);

  const markRead = useCallback(async () => {
    requestSeqRef.current += 1; // 让在途的 refresh 响应失效
    setUnreadCount(0); // 乐观更新：先清徽标，失败再拉回真实值
    try {
      const res = await fetch(buildApiUrl(MARK_READ_URL), {
        method: "POST",
        credentials: "include",
      });
      const json = await res.json();
      if (!json?.success) refresh();
    } catch {
      refresh();
    }
  }, [refresh]);

  return { unreadCount, markRead, refresh };
}
