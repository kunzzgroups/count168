import { useCallback, useEffect, useRef, useState } from "react";
import { buildApiUrl } from "../utils/apiUrl.js";
import { useRealtimeDomain } from "../lib/realtime/useRealtimeDomain.js";
import { REALTIME_DOMAINS } from "../lib/realtime/realtimeEvents.js";

const UNREAD_COUNT_URL = "api/announcements/announcement_unread_count_api.php";
const MARK_READ_URL = "api/announcements/announcement_mark_read_api.php";

/**
 * Bell badge count — owned by the server and keyed by the logged-in account
 * (user_type + user_id), so switching company / browser / device no longer
 * resurrects an announcement that was already read.
 *
 * Desktop parity: `frontend/src/hooks/useAnnouncementUnread.js`. The two apps share no
 * source, so this file is kept in sync by hand. Identity comes from the PHP session;
 * `me` is only used to know whether someone is signed in (IT accounts report 0).
 *
 * @param {object|null} me current user (user_id decides the account switch)
 * @returns {{ unreadCount: number, markRead: () => Promise<void>, refresh: () => Promise<void> }}
 */
export function useAnnouncementUnread(me) {
  const [unreadCount, setUnreadCount] = useState(0);
  /** Request sequence guard: refresh and markRead both bump it, so a stale response is dropped. */
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
      /* Network failure keeps the previous number instead of flashing 0. */
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

  // The shell always mounts MobileRealtimeBridge (App.jsx), so announcement writes refresh the count.
  useRealtimeDomain([REALTIME_DOMAINS.ANNOUNCEMENTS], refresh, { enabled: Boolean(ownerKey) });

  const markRead = useCallback(async () => {
    requestSeqRef.current += 1; // invalidate an in-flight refresh response
    setUnreadCount(0); // optimistic: clear the badge first, pull the real value back on failure
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
