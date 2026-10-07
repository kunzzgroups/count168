# 侧边栏铃铛未读提示 — 按登录账号、后端存储

> **范围**：新表 `announcement_read_state`；新接口 `api/announcements/announcement_unread_count_api.php`、
> `api/announcements/announcement_mark_read_api.php`；前端 `frontend/src/hooks/useAnnouncementUnread.js`、
> `frontend/src/components/AuthenticatedLayout.jsx`、`frontend/src/pages/member/useMemberPageShell.js`、
> `frontend/src/pages/member/MemberPage.jsx`；建表脚本 `database/migrations/20261007_announcement_read_state.sql`。
> **相关**：`realtime-websocket-mechanism.md`（公告广播，`REALTIME_DOMAINS.ANNOUNCEMENTS`）。

---

## 1. 问题

铃铛未读数原本完全在前端算：`frontend/src/lib/announcementSeenStore.js` 把「已看过的公告 id」存在
localStorage，key 是 `<user_id>:<YYYY-MM-DD>`。结果：

- 跨天必回：同一批公告第二天又变成未读；
- 换浏览器 / 换设备，已读记录丢失；
- 未读只在「拉到的最近 10 条」里算，第 11 条起的公告永远不进徽标；
- 前端要自己维护 id 集合、跨天翻页（`markAnnouncementsSeen` / `unreadAnnouncementCount` 共约 35 行）。

根因：「已读」是**账号**的属性，却被存成了「浏览器 × 日期」的属性。

## 2. 方案

未读状态改为 **按登录账号** 记录，由后端保存和计算，与日期、浏览器、设备无关。

### 2.1 表 `announcement_read_state`

| 字段 | 说明 |
|---|---|
| `user_type` | `user`（后台员工）/ `owner` / `member`（对应 `account` 表） |
| `user_id` | 对应表的 id（取自 session `user_id`） |
| `last_read_at` | 该账号最后一次标记已读的时间（DB 时钟） |
| `updated_at` | 自动更新时间 |

主键 `(user_type, user_id)`。三张表的 id 空间会重叠，所以 `user_type` 必须进主键。

### 2.2 未读规则（SQL 内计算，只用 DB 时间）

```
未读数 = company_code='C168' 且 status='active' 的公告中，created_at > last_read_at 的条数
```

- 公告是全平台的（`C168`），所以没有公司维度。
- 账号还没有记录时，接口先 `INSERT IGNORE ... last_read_at = NOW()` 锚定基准：
  **新账号不会看到自己出现之前的旧公告为未读**。
  （文档原稿想用「账号自己的 `created_at`」，但 `account` 表没有这个字段，所以改成首次取数时锚定。）
- **IT 账号**（`IT_JK` / `IT_JS` / `IT_MS`）不参与未读提醒：接口用仓库已有的
  `gc_is_system_it_login()`（`includes/group_company_access.php`）判定，`unreadCount` 恒为 0，
  `markRead` 不做任何事。

### 2.3 接口

| 接口 | 作用 |
|---|---|
| `GET api/announcements/announcement_unread_count_api.php` | 返回 `data.unreadCount` |
| `POST api/announcements/announcement_mark_read_api.php` | `INSERT ... ON DUPLICATE KEY UPDATE last_read_at = NOW()`，返回 `data.unreadCount = 0`；非 POST 返回 405 |

身份取自 session（`user_type` + `user_id`），前端不传任何标识；未登录返回 401。

## 3. 前端行为（`useAnnouncementUnread(me, pollMs)`）

- 返回 `{ unreadCount, markRead, refresh }`；`me` 只用来判断「是否登录 / 换了账号」（用 `user_id`），
  真实身份始终来自后端 session。
- **刷新时机**：账号变化时；收到 `announcements` 实时广播时（hook 内部 `useRealtimeDomain`）；
  没挂 `AppRealtimeBridge` 的壳（会员自助壳）用 `pollMs` 轮询兜底（页面隐藏时跳过）。
- **markRead 乐观更新**：点击铃铛 / 进入公告页时先把徽标清零，再请求后端；失败则重新 `refresh`。
  两个调用点：`AuthenticatedLayout.jsx`（铃铛点击、路由进入 `/announcement`）、
  `useMemberPageShell.js`（会员壳铃铛点击，`pollMs = 60000`）。
- **防旧响应覆盖**：`requestSeqRef` 序号，`markRead` 和每次 `refresh` 都递增，返回时序号不一致就丢弃。
- 原来的 `frontend/src/lib/announcementSeenStore.js` 已删除（localStorage / 按天 / 拉到的前 10 条都不再参与）。

## 4. 上线 / 迁移

1. 手动执行 `database/migrations/20261007_announcement_read_state.sql`（仓库没有自动 SQL runner）。
   脚本可重复执行（`CREATE TABLE IF NOT EXISTS` + `INSERT IGNORE`）。
2. 脚本给**所有现有账号**回填 `last_read_at = 迁移时间`，上线瞬间没人会突然看到一堆旧公告的未读。
   （即使不回填，2.2 的首次锚定也不会让老账号爆发未读；回填只是让基准在迁移时就落库。）
3. 之后新建的账号没有记录，走 2.2 的首次锚定。

## 5. 已知限制

- **移动端未改**：`c168_mobile` 仍用自己的本地「已读」判断，和桌面端不互通。
- 「已读」是全量的：一次 `markRead` 把该账号截至当前的所有公告都标为已读，不记录单条。
- 徽标数字来自**全部** active 公告，而通知面板只列最近 10 条，所以数字可能大于面板条目数。
- 公告被编辑（update）不会重新变未读，只有新发布（`created_at` 更晚）的才会计入。
