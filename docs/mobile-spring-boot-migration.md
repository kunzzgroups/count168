# 手机版接桌面 Spring Boot 后端 —— 开工手册

> 目标：让 `c168_mobile`（手机版 Web + 已发布的 Android 壳 APK）在**不重写前端、不重发 APK** 的前提下，
> 跑在同事那边新写的 Spring Boot 后端上。
>
> 状态：**待开工**（等第 1 节的资料到手即可开始 P0）。台账写在 [`backend-migration.md`](./backend-migration.md)。
> 配套工具：`scripts/parity-scan.mjs`（前端侧对齐扫描）、本文第 9 节的 `scripts/api-contract-dump.mjs`。

---

## 0. 30 秒摘要（三条硬事实，决定成本）

| 事实 | 依据 | 结论 |
|---|---|---|
| 前端不拼后端域名，一律用**当前 origin** | `c168_mobile/frontend/src/utils/apiUrl.js`：`new URL(pathAndQuery, window.location.origin)` | **前端零改动**；切后端是**服务端路由**决策 |
| 老 APK 只是远程 WebView 壳 | `c168_mobile/app/capacitor.config.json` 的 `server.url` 指向 https 站点 | **不用重发 APK**；但代价是 `/api/**` **路径与 wire 格式必须保真**（老壳改不了指向） |
| dev 指新后端只改一个环境变量 | `vite.config.js`：`VITE_PHP_PROXY_TARGET`（默认 127.0.0.1:8000）、`VITE_REALTIME_PROXY_TARGET`（默认 3911） | 本地对拍成本极低 |

**所以这是「契约对齐 + 灰度切流」的活，不是「前端重写」的活。**

### 最大风险（先看这条）
手机版打 **84** 个接口：74 个与桌面共享、**10 个是手机版独有**：

```
api/session/webauthn_register_options_api.php   ← 扫脸/指纹注册（iOS Face ID、安卓指纹）
api/session/webauthn_register_verify_api.php
api/session/webauthn_login_options_api.php      ← 扫脸登录
api/session/webauthn_login_verify_api.php
api/session/webauthn_credentials_api.php        ← 本机凭据列表/删除
api/session/device_token_register_api.php       ← 安卓壳：生物识别解锁令牌
api/session/device_token_revoke_api.php
api/session/device_tokens_api.php
api/session/device_login_api.php                ← 安卓壳：免密登录
api/session/remember_device_api.php
```
桌面 `frontend/src` 里**完全没有** `webauthn` / `device_token` / `remember_device` 的引用
（`grep -rn "webauthn\|device_token" frontend/src` 为空）→ 同事按桌面重写的 Spring 后端**很可能一个都没实现**。
这 10 个不补上，症状是：**安卓壳的指纹解锁/免密登录、iOS 的扫脸登录全部失效** ✗
→ 第 1 节第 4 条、第 5 节第 1 条都围绕它。

---

## 1. 开工前必须从同事那里拿到的资料（8 项）

缺哪一项都会让后面的对拍变成猜。

| # | 要什么 | 具体形式 | 没有它会怎样 |
|---|---|---|---|
| 1 | repo / branch / 本地起法 | 端口、docker-compose 或 `mvn spring-boot:run`、默认 profiles | 无法本地对拍，只能上服务器试 |
| 2 | **接口清单** | controller 列表（`@RequestMapping` 全表）或 OpenAPI/springdoc 的 `/v3/api-docs` | 无法与第 2 节的 84 条对上，漏接口只能靠用户报障发现 |
| 3 | **响应 envelope + 错误码全表** | `{success, code, message, data}` 是否保留；`code` 全集 | 前端拿 `code` 做分支（见第 5 节第 3 条），缺一个就静默走错分支 |
| 4 | **鉴权方案** | cookie 名/属性（`SameSite`/`Secure`/`Domain`/`Path`）、session 存哪、CSRF、二级密码 gate、**passkey 与 device token 打算怎么办** | 登录后立刻 401 / 扫脸全挂 |
| 5 | **SSE** | `/realtime/sse` 是否保留、`api/realtime/ticket_api.php` 的 `sse_path` 字段、事件名与 domain 枚举 | 电话版"数据不刷新"（它完全依赖这条总线） |
| 6 | 金额与日期口径 | 小数位常量（PHP 侧 `SUBMIT_STORE_SCALE_RATE = 6`）、半进位 vs 截断、时区 `Asia/Kuala_Lumpur` | 金额差一分 / 提交被拒 / 日期差一天 |
| 7 | 组台账与权限语义 | `view_group`、（display）`group_id` vs `native_group_id`、group ledger 403 的返回 | 数字来自**另一个组**的台账（我在前端对齐时就踩过这个坑） |
| 8 | 迁移进度表 | 哪些域已迁完、哪些仍是 PHP | 无法排灰度顺序 |

---

## 2. 兼容性核对表（本体，84 条）

> 由静态扫描生成（`scripts/api-contract-dump.mjs`）：扫两个前端的字面量 `api/**.php` 调用。
> **限制**：动态拼接的路径会漏 → 必须与第 1 节第 2 条的 controller 清单**交叉核对**。
> 用法：同事那边每迁完一族，就在这一行标 `对拍通过 / 已切流`，并同步到台账。

### api/transactions（16，全部共享）
- [ ] `api/transactions/dashboard_api.php`
- [ ] `api/transactions/dashboard_bootstrap_api.php` ← 看板核心；聚合/ownership 语义最重
- [ ] `api/transactions/search_api.php`
- [ ] `api/transactions/history_api.php`
- [ ] `api/transactions/submit_api.php` ← 写入口，金额小数/幂等最危险
- [ ] `api/transactions/get_accounts_api.php`
- [ ] `api/transactions/get_company_currencies_api.php`
- [ ] `api/transactions/get_scope_account_currencies_api.php`
- [ ] `api/transactions/get_owner_companies_api.php`
- [ ] `api/transactions/get_categories_api.php`
- [ ] `api/transactions/user_currency_order_api.php` ← 含 `group_id` / `g:GROUP` 存储键
- [ ] `api/transactions/type_account_search_api.php`
- [ ] `api/transactions/type_transaction_search_api.php`
- [ ] `api/transactions/contra_inbox_api.php`
- [ ] `api/transactions/contra_approve_api.php`
- [ ] `api/transactions/contra_reject_api.php`

### api/session（17：7 共享 + 10 仅手机版）
- [ ] `api/session/login_api.php` · `logout_api.php` · `current_user_api.php`
- [ ] `api/session/update_company_session_api.php` · `update_account_session_api.php`
- [ ] `api/session/verify_owner_secondary_password_api.php` · `verify_user_secondary_password_api.php`
- [ ] ⚠️ 仅手机版 ×10：见第 0 节列表（passkey ×5 + device token ×4 + remember_device）

### api/accounts（13，全部共享）
- [ ] `accountlistapi.php` · `getaccount_api.php` · `addaccountapi.php` · `update_api.php`
- [ ] `toggle_account_status_api.php` · `toggle_payment_alert_api.php` · `delete_accounts_api.php`
- [ ] `account_company_api.php` · `account_currency_api.php` · `bulk_account_currency_api.php`
- [ ] `create_currency_api.php` · `delete_currency_api.php` · `account_link_api.php`

### api/ownership（12，全部共享）
- [ ] `get_companies_api.php` · `get_owners_api.php` · `get_group_owners_api.php`
- [ ] `get_available_accounts_api.php` · `get_group_available_accounts_api.php` · `get_group_earnings_api.php`
- [ ] `batch_save_owners_api.php` · `batch_save_group_owners_api.php`
- [ ] `add_external_partner_api.php` · `add_group_external_partner_api.php`
- [ ] `remove_owner_api.php` · `update_company_group_api.php`

### api/announcements（7，全部共享）
- [ ] `announcement_list_api.php` · `announcement_get_dashboard_api.php` · `announcement_unread_count_api.php`
- [ ] `announcement_mark_read_api.php` · `announcement_create_api.php` · `announcement_update_api.php` · `announcement_delete_api.php`

### api/maintenance（6）+ payment_maintenance（2）+ reports（2）
- [ ] `api/maintenance/list_api.php` · `create_api.php` · `update_api.php` · `delete_api.php` · `get_public_api.php` · `mode_api.php`
- [ ] `api/payment_maintenance/search_api.php` · `delete_api.php`
- [ ] `api/reports/customer_report_api.php` · `api/reports/domain_report_api.php` ← group ledger 403 回退语义

### 其它（11，共享）
- [ ] `api/company/verify_api.php` · `api/domain/domain_api.php` · `api/editdata/editdata_api.php`
- [ ] `api/fx/fx_rates_api.php` · `api/processes/processlist_api.php` · `api/subscription/auto_renew_api.php`
- [ ] `api/realtime/ticket_api.php` ← SSE 票据（配合第 1 节第 5 条）
- [ ] `api/users/userlist_api.php` · `api/users/toggle_status_api.php`

> 参考：`api/` 下共 **179** 个 PHP 文件；前端没直接调的 **62** 个（被 include / 内部用 / 其它线）→ PHP 下线时别一刀切。

---

## 3. 三层验证（缺一层都别切）

**L1 契约对拍（字段级，数值零容差）**
同一请求分别打 PHP 与 Spring，diff JSON：字段增删改名、`null` vs 缺失、数字字符串 vs 数字、
小数位与进位、数组顺序、`code` 取值。脚本骨架见第 9 节。
> 宁可对拍 200 个样本，也不要"读代码觉得一样"——前端对齐那轮证明了光看代码会漏。

**L2 真机冒烟（三端 × 五流程）**
- 端：Android 壳 APK、iOS 主屏 PWA、桌面浏览器窄屏
- 流程：① 登录（含二级密码、**扫脸/指纹**）② 看板（单公司 / 组 / All）③ 交易（PAYMENT / RATE / 类型搜索 / 提交）
④ 报告（customer / domain，含 group ledger 被拒的回退）⑤ 维护 / 公告 / 自动续费

**L3 SSE 对拍**
事件名、domain 枚举、触发时机（另一台设备改数据 → 本机是否自动刷新）。
电话版**完全依赖**这条总线：`ledger`（列表/看板）、`accounts`（交易页账号选项）等。

---

## 4. 怎么"零改代码"切过去

| 环境 | 做法 |
|---|---|
| 本地 dev | `VITE_PHP_PROXY_TARGET=http://127.0.0.1:8080 VITE_REALTIME_PROXY_TARGET=… npm run dev` |
| 线上阶段 1（自测） | nginx 新增 `location /api2/ { proxy_pass http://127.0.0.1:8080/; }`；前端/用户无感 |
| 线上阶段 2（灰度） | 按**路径族**把 `/api/transactions/` 之类的 `location` 指向 Spring，其余仍走 PHP |
| 线上阶段 3（全量） | `/api/` 整体反代到 Spring；PHP 只留 62 个内部文件 |
| 回滚 | 把该 `location` 改回 PHP（一行，秒级） |

> 老 APK 与 iOS 主屏用户**不需要做任何事**；正因为如此，**路径与 wire 格式必须保真**。

---

## 5. 高危点：现象 + 怎么测 + 验收

| # | 高危点 | 现象 | 怎么测 | 验收 |
|---|---|---|---|---|
| 1 | 10 个手机独有接口缺失 | 安卓指纹解锁/免密登录、iOS 扫脸**全挂** | 三端各真机登录一次 | 三端都能用；或明确决定"暂不支持扫脸"并给前端兜底 |
| 2 | Cookie/CSRF/SameSite | 登录成功但下一个接口 401；APK 内同样 | 连打 3 个接口 + 壳内再打一次 | 会话可跨请求保持 |
| 3 | 错误码语义 | 不弹提示 / 走错分支 | 逐个触发：`SECONDARY_PASSWORD_REQUIRED`、`NOT_LOGGED_IN`、`DEVICE_LIMIT`、`CREDENTIAL_UNKNOWN`、`OPTIONS_FAILED` | 前端分支行为与 PHP 时一致 |
| 4 | 金额小数与进位 | 差一分；提交被拒"小数位最多 6 位" | RATE 用 6/7/8 位小数各提交一次；对拍 `rate_from_amount` | 与 PHP 完全相同 |
| 5 | 组台账 display vs native group | 数字来自另一个组 | 用 partner 重映射账号（`is_external=1`）切换组 | 与 PHP 相同 |
| 6 | SSE 事件名/domain | "数据不刷新" | 另一设备改数据 → 本机看是否自动刷新 | 事件名与 domain 与 PHP 完全一致 |
| 7 | 时区/日期格式 | 日期差一天、本月区间错 | 跨零点前后各测一次；DMY/YMD 混用处 | 与 PHP 相同 |
| 8 | 幂等与并发 | 重复流水 | submit / contra 审批连点两次 | 与 PHP 相同 |

---

## 6. 分阶段计划与 DoD

| 阶段 | 内容 | 交付物 | DoD（全过才进下一阶段） |
|---|---|---|---|
| **P0** | 契约快照 | `docs/backend-migration.md` 台账 + 84 条接口的「PHP 现状」列（参数/字段/code） | 与同事 controller 清单交叉核对完，差异清单确认 |
| P1 | 只读族对拍 | transactions 读 + dashboard 的对拍报告 | L1 通过（零容差）+ 电话版看板真机冒烟通过 |
| P2 | 写族 | submit / editdata / contra / accounts 增删改 | L1 + 真机提交（含 RATE）+ 幂等测试 |
| P3 | 会话与鉴权 | 登录/登出/二级密码/10 个手机独有接口 | 三端真机登录 + 会话保持 + 错误码分支 |
| P4 | SSE | 总线切 Spring | L3 通过（事件名/domain/时机） |
| P5 | 全量 + PHP 下线 | 179 → 62 内部文件 | 线上观察 N 天无相关报障 |

每阶段都：① 有对拍报告 ② 有真机冒烟记录 ③ 台账更新 ④ 演练一次回滚。

---

## 7. 台账模板（`docs/backend-migration.md`）

```markdown
| 接口 | 域 | 手机版用 | PHP 现状 | Spring 状态 | 对拍 | 切流日期 | 回滚方式 | 备注 |
|---|---|---|---|---|---|---|---|---|
| api/transactions/submit_api.php | tx | 是 | 在用 | 已实现 | 待对拍 | — | nginx location 回 PHP | 小数 6 位 |
```

---

## 8. 已知的坑（从前端对齐那轮学到的，别重犯）

1. **别顺手"RESTful 化"**：路径、方法、envelope、字段名都可能是前端硬编码的契约；`login_api.php` 改成 `/login` 就等于打断老 APK。
2. **错误码是接口的一部分**：前端 `switch (code)` 分支（见第 5 节第 3 条），换 HTTP 状态码或改文案都会静默失效。
3. **`null` 与"字段缺失"不同**：前端有 `?? ` 与 `!== undefined` 两种写法，混用会走错分支。
4. **金额字符串 vs 数字**：现在多处传的是字符串（保精度），换成 JSON number 会掉精度。
5. **组归属有两套字段**：display `group_id`（`COALESCE(partner_group_id, …)`）与 `native_group_id`，用错数字来自别的组。
6. **SSE 的 `sse_path` 是服务端下发的**（`ticket_api` 返回），所以后端可以换实现，但**事件名/domain 不能换**。
7. **别同时改前端**：这次迁移的目标就是前端零改动，一旦动前端，就等于同时开两个战场。
8. **老 APK 不能改 base URL**：任何"只在新版前端里兼容"的方案都等于放弃老用户。

---

## 9. 开工当天我做的第一件事（P0）

1. 产出 `scripts/api-contract-dump.mjs`：列出手机版打到的 84 条 + 与同事 controller 清单求差（多/少/改名）。
2. 产出 `docs/backend-migration.md` 空台账（第 7 节模板）。
3. 产出对拍脚本骨架：`scripts/api-contract-diff.mjs`（同一请求 → PHP 与 Spring 各打一次 → 字段级 diff，输出报告）。
4. 与同事确认第 1 节的 8 项资料，把差异写进台账"差异清单"。

> 前置条件：第 1 节的资料（尤其第 2、4 条）。在此之前我**不会**改任何业务代码。
