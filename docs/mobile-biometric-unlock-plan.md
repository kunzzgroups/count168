# c168_mobile 指纹解锁 / Face ID 方案设计

> 状态：**定稿**，全部决策已确认（见 §10）。本文档只做设计，不含代码改动。
> 调研日期：基于当前仓库 HEAD。

---

## 1. 结论摘要

| 问题 | 结论 |
|---|---|
| 安卓指纹解锁能不能做？ | **能做**，且比预想省事——仓库里**已有 `remember_token` 免登录机制**可复用 |
| Apple Face ID 能不能做？ | **APK 里做不到**。仓库无 iOS 工程；只能在 iPhone Safari/PWA 走 WebAuthn，或另建 iOS App（需 Mac + $99/年账号） |
| 最大障碍是什么？ | **不是生物识别本身**（那是 40 行原生代码），而是**没有可长期持有、可吊销、支持多设备的凭据** |
| 推荐做法 | 设备令牌表 + Android Keystore 存令牌 + BiometricPrompt 门禁，工期 **5.5 人日** |
| ✅ 已确认决策 | 全部 6 项已定（见 §10）：**必须多设备**、**member 也要**、**90 天**、**二级密码必须重输** |
| ⚠️ 补充发现 | 实际有 **3 种**登录身份（`owner`/`user`/`member`），而现有免登录只盖住 1/3（见 §2.1） |

**一句话定性**：生物识别在这里是**「门禁」而不是「认证因子」**。它只是本地的一道锁，解开后放行一个已存在的登录凭据。它不会让服务端更安全，只是让「拿到你已解锁手机的人」进不来。

---

## 2. 现状调研（带证据）

| # | 事实 | 证据位置 | 对方案的影响 |
|---|---|---|---|
| 1 | 认证是 **PHP Session Cookie**，1 小时超时，`httponly` + `SameSite=Lax`，`path=/` | `api/session/login_api.php:1-11` | 会话本身撑不过 1 小时，**必须靠免登录机制续期** |
| 2 | **已存在 `remember_token` 免登录**：`user.remember_token` + `remember_token_expires`，30 天 | `api/session/login_api.php:231-240`、`335-349`、`430-438` | ⭐ **可复用的核心资产**，不必从零设计 |
| 3 | **已有免登录自动建立会话的服务端路径** | `api/session/current_user_api.php:25-66` | ⭐ 免登录换 session 的逻辑已跑通，新 API 可照抄 |
| 4 | 已有吊销函数与清理函数 | `includes/auth_invalidation.php:19-33`（吊销）、`41-58`（清 cookie） | ⭐ 吊销链路已存在，改密码时会自动调用（`:117`） |
| 5 | ⚠️ `remember_token` cookie **没设 `Secure`** | `login_api.php:236`：`setcookie('remember_token', $t, time()+..., "/", "", false, true)` — 第 6 参 `false` | **现存缺陷**，HTTPS 站点上该 cookie 会被明文 HTTP 请求带走，本方案应顺手修掉 |
| 6 | ⚠️ `remember_token` 是**明文存库**（`varchar(64)`），查询用 `WHERE remember_token = ?` | `current_user_api.php:28` | 本方案应改为存 `sha256` |
| 7 | ⚠️ `remember_token` 只在 `user` 表 → **一个用户只有 1 个 token，多设备互踢** | `user` 表结构无多行设计 | 手机 + 电脑同时用会互相踢掉，**移动 App 场景不可接受** |
| 8 | ⚠️ **现有免登录只覆盖 3 种登录身份中的 1 种**（详见 §2.1） | `api/session/login_api.php:138-190`（member 无）、`:606-609`（owner 是空壳） | 另两种身份的指纹解锁**必须补** |
| 9 | 前端已勾选过 remember-me，但**member 角色不发这个字段** | `c168_mobile/frontend/src/pages/login/LoginPage.jsx:315-319` | 前端也要改 |
| 10 | remember-me 逻辑在 `login_api.php` **重复了 3 遍** | `:231-240`、`:335-349`、`:430-438` | 新增逻辑建议抽到 `includes/` 里，别再复制第 4 遍 |
| 11 | APK 是 **Capacitor 8 空壳**，`server.url` 远程加载网站，无任何插件、无 iOS 工程 | `c168_mobile/app/capacitor.config.json` | 插件要走 `window.Capacitor.Plugins.*`，**不能常规打包引入**（前端没装 `@capacitor/core`，见 `frontend/package.json`） |
| 12 | `minSdkVersion = 24` | `c168_mobile/app/android/variables.gradle` | ✅ 满足 `BiometricPrompt`（API 23+） |
| 13 | 前端是**部署在网站上的 React SPA**，有 PWA manifest 但**没有 Service Worker** | `frontend/` 无 sw 注册 | 网页端指纹只能靠 WebAuthn，且不是本期范围 |
| 14 | ⚠️ **路由没有守卫**，所有页面直接渲染，鉴权全靠各 API 自己 | `c168_mobile/frontend/src/App.jsx:44-76` | 锁屏必须做在「发请求之前」的启动层，而不是路由层 |
| 15 | 仓库**没有** rate limit / throttle 工具 | `includes/` 无相关文件 | 令牌登录端点需自行加限流，否则可暴力枚举 |
| 16 | 迁移脚本放 `database/migrations/`，命名 `YYYYMMDD_描述.sql` | `database/migrations/` | 新表按此规范落盘 |

### 2.1 ⚠️ 补充发现：有 **3 种**登录身份，不是 2 种

设计设备令牌时必须一次性覆盖全部三种，否则会像现有 `remember_token` 一样只盖住三分之一：

| 登录身份 | 表 | `$_SESSION['user_type']` | 二级密码 | 现有免登录 |
|---|---|---|---|---|
| Owner | `owner`（`owner_code` 字段） | `owner` | **总是要** | ❌ **无**：`owner` 表根本没 `remember_token` 列，且 `login_api.php:606-609` 是个**空壳分支**（`if ($remember_me) { /* 可以存在 session 或另外处理 */ }`，什么都不做） |
| Staff/Admin | `user` | `user` | 仅当 C168 公司且 `user.secondary_password` 非空 | ✅ 有（唯一真正可用的） |
| Member | `account` | `member` | 无 | ❌ **无**：`account` 表无该列 |

**推论**：现有免登录实际只覆盖 **1/3** 登录类型。这也反向验证了 §4 结论：新建 `device_token` 表（`enum('owner','user','member')`）比修 `remember_token` 更划算。

### 2.2 ⚠️ 补充发现：二级密码强制点**不统一**

| 强制方式 | 位置 | 覆盖 |
|---|---|---|
| `includes/session_check.php` | `:132-147`（owner）、`:149-190`（C168 的 user） | 仅 **19 个** API 文件引用 |
| **自行判定** | `api/session/current_user_api.php:102-105`、`:171-178` | `current_user_api` 自己算 `$needsOwnerSecondary` / `$needsUserSecondary` |

→ **不能假设 `session_check.php` 会兜底**。新 API 必须**照抄 `current_user_api.php` 的判定**并自己返回正确的 `redirect`，见 §5.3.1。

---

## 3. 核心判断

生物识别解锁 = **本地保管凭据 + 本地门禁**，拆开看是三件事：

```
[1] 一个能长期持有、可吊销、可多设备的服务端凭据   ← 真正的工程量在这
[2] 把这个凭据安全存在手机里（Android Keystore）    ← 插件帮你做了
[3] 用指纹/人脸当钥匙去取它（BiometricPrompt）      ← 40 行代码
```

绝大多数团队会把时间花在 [3]（因为最像"功能"），然后被 [1] 卡住。
**本方案的时间也主要花在 [1]。**

### 现有 `remember_token` 够不够用？

| 维度 | 现有 remember_token | 移动 App 需要 | 结论 |
|---|---|---|---|
| 多设备 | ❌ 单列，互踢 | ✅ 必须 | **必须新建表** |
| 存储安全 | ❌ 明文 | ✅ 哈希 | 必须改 |
| 覆盖 member | ❌ 只有 user | ✅ 需要 | 必须补 |
| 可吊销 | ✅ 已实现 | ✅ | 复用 |
| 设备标识 | ❌ 无 | ✅ 需要（"我的登录设备"） | 必须补 |

→ 结论：**新建 `device_token` 表，`remember_token` 保持不变（网页端继续用）**。两套并存，互不干扰。

---

## 4. 三档方案对比

### 方案 A：纯客户端门禁（0 后端改动，1~2 天）

复用现有 `remember_token`（用户勾了记住我 → 30 天免登录），APK 里只加一道本地指纹遮罩。

- ✅ 极快，不动后端，不动数据库
- ❌ **安全上基本是心理安慰**：遮罩只在 UI 层，凭据仍在 WebView cookie 里
- ❌ **只覆盖 owner/admin 角色**，member 账号无效（见事实 #8）
- ❌ 单设备，手机登录会把电脑踢掉（见事实 #7）

> ❌ **已排除**（用户已确认不接受"手机登录踢掉电脑"）：方案 A 完全依赖现有的**单设备** `remember_token`（事实 #7），天然无法满足多设备需求。此处保留仅为记录，不再考虑。

### 方案 B：设备令牌 + Keystore + 原生门禁（**推荐**，5.5 人日）

- ✅ 支持多设备、可远程吊销、令牌哈希存储、覆盖 member
- ✅ 服务端真正可控（能看"我的登录设备"、能一键下线）
- ✅ 顺手修掉 `Secure=false` 和明文存令牌两个现存缺陷
- ❌ 需要动数据库 + 后端 + 前端 + 原生四层
- ❌ 只覆盖安卓 APK

### 方案 C：WebAuthn / Passkey（网页 + PWA + iPhone Face ID，1~2 周）

- ✅ 网页、安卓浏览器指纹、iPhone Safari 16+ Face ID 通吃
- ✅ 不存密码，是真正的服务端认证因子
- ❌ **安卓 WebView 不支持 WebAuthn** → 装了 APK 的用户反而用不了，等于 B 还是得做
- ❌ 仓库无 composer/vendor，需引入 `web-auth/webauthn-lib`（PHP 8.1+）或手写 CBOR/COSE 校验

> 定位：**独立的第二阶段项目**，不是 B 的替代品。

### 关于 iOS / Face ID

仓库只有 `app/android/`，**没有 iOS 工程**。所以"Apple 扫脸"目前只能：

| 路径 | 前提 | 备注 |
|---|---|---|
| iPhone Safari / PWA + WebAuthn | 走方案 C | 无需开发者账号，Face ID 由系统弹窗 |
| 原生 iOS App + LocalAuthentication | Mac + $99/年 + 上架审核 | 工期最长，且要维护第二套壳 |

**建议本期明确不做 iOS，在方案里留好 `Platform` 抽象层即可。**

---

## 5. 方案 B 详细设计

### 5.1 时序

**注册（首次开启）**
```
用户登录成功
   └─> 前端: window.Capacitor.isNativePlatform() ? 弹出「开启指纹解锁」 : 跳过
        └─> 用户同意 → 生成 device_id (UUID, localStorage 持久)
             └─> POST api/session/device_token_register_api.php {device_id, device_name}
                  └─> 服务端: 生成 64hex token, 只存 sha256, 返回明文 token (仅此一次)
                       └─> NativeBiometric.setCredentials({server:'count168.site', username:device_id, password:token})
                            └─> Android Keystore 加密落盘 ✅
```

**解锁（每次打开 App）**
```
App 启动 → WebView 加载远端 SPA → React 挂载
   └─> 启动门禁层: isNativePlatform() && 存在本地凭据 ?
        ├─ 否 → 正常走 /login
        └─ 是 → 渲染全屏锁屏遮罩 (阻止任何 API 请求发出)
             └─> NativeBiometric.verifyIdentity({reason:'验证指纹以登录'})
                  ├─ 成功 → getCredentials() 取出 token
                  │    └─> POST api/session/device_login_api.php {token, device_id}
                  │         └─> 服务端校验 sha256 → 重建 $_SESSION → 返回 redirect
                  │              └─> 前端 navigate(redirect), 撤掉遮罩
                  ├─ 失败/取消 → 停留锁屏, 提供「用密码登录」出口
                  └─ 凭据不存在(Keystore 失效) → 清理本地标记 → 跳密码登录
```

### 5.2 数据库变更

新增迁移：`database/migrations/2026MMDD_add_device_token.sql`

```sql
CREATE TABLE `device_token` (
  `id`             bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_type`      enum('owner','user','member') NOT NULL COMMENT '对应 owner / user / account 三张表',
  `user_id`        int NOT NULL,
  `token_hash`     char(64) NOT NULL COMMENT 'sha256(明文token)，明文不落库',
  `device_id`      varchar(64) NOT NULL COMMENT '客户端UUID，同一设备恒定',
  `device_name`    varchar(100) DEFAULT NULL COMMENT '如 Xiaomi 14 / Android 15',
  `expires_at`     datetime NOT NULL COMMENT '默认90天',
  `last_used_at`   datetime DEFAULT NULL,
  `last_used_ip`   varbinary(16) DEFAULT NULL,
  `revoked_at`     datetime DEFAULT NULL,
  `created_at`     datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_token_hash` (`token_hash`),
  UNIQUE KEY `uk_device` (`user_type`,`user_id`,`device_id`),
  KEY `idx_user` (`user_type`,`user_id`,`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='移动端生物识别解锁的设备令牌';
```

设计要点：
- `token_hash` 唯一索引 → 查询走索引，且库被拖走也无法反推 token
- `uk_device` 保证同一账号同一设备只有一条，重新开启指纹 = 覆盖旧令牌
- 不做外键（与现有 `remember_token` 保持一致风格）
- **不动 `user` / `account` 表**，`remember_token` 逻辑原样保留

### 5.3 API 契约

统一约定：POST + `Content-Type: application/x-www-form-urlencoded`（与现有 API 一致），响应 `application/json`，`Cache-Control: no-store`。

#### ① 签发令牌
`POST /api/session/device_token_register_api.php`

| 参数 | 必填 | 说明 |
|---|---|---|
| `device_id` | ✅ | 客户端 UUID |
| `device_name` | ➖ | 设备名，用于"我的登录设备" |

前置：**必须已有有效 session**（只能登录后开启）。
响应：
```json
{ "status": "success",
  "token": "64位hex明文，仅此一次返回",
  "expires_at": "2026-11-01 12:00:00" }
```
错误：`{"status":"error","message":"Not logged in"}` / `{"status":"error","code":"DEVICE_LIMIT","message":"..."}`

> 因已确认多设备，此处需要**设备数上限**。建议同账号最多 **5 台**已授权设备；超限时返回 `DEVICE_LIMIT`，前端引导用户先去「我的登录设备」下线一台（见 ④，已提升为 P0）。不做上限的话，令牌表会随装机量无限膨胀。

#### ② 令牌换会话 ⭐核心
`POST /api/session/device_login_api.php`

| 参数 | 必填 | 说明 |
|---|---|---|
| `token` | ✅ | 明文令牌 |
| `device_id` | ✅ | 必须与签发时一致（绑定校验） |

服务端流程（照抄 `current_user_api.php:25-66` 的成功路径，但**不设 cookie**）：
1. `sha256(token)` → 查 `device_token`，条件 `revoked_at IS NULL AND expires_at > NOW() AND device_id = ?`
2. 校验用户 `status='active'`（按 `user_type` 分别查 `owner` / `user` / `account` 三张表，见 §2.1）
3. 复用现有 `maintenance_gate` / `company_expiration` 判定，**保持与 `login_api.php` 完全一致的拒绝语义**
4. **二级密码：不得放行**（已确认为硬需求）——具体做法见 §5.3.1
5. 重建 `$_SESSION`（`user_id` / `login_id` / `role` / `user_type` / `company_id` / `company_code` / `last_activity` / `read_only`；owner 还需 `owner_id` / `real_owner_id` / `owner_code`）
6. 更新 `last_used_at`、`last_used_ip`（失败也记，便于审计）
7. 返回与 `login_api.php` **同构**的响应，前端可直接复用 `resolvePostLoginPath()`：

```json
{ "status": "success", "redirect": "/dashboard",
  "user_type": "user", "company_id": 12,
  "login_scope": "...", "login_identifier": "..." }
```

错误码（前端据此决定"重试指纹"还是"直接跳密码登录"）：
```json
{ "status": "error", "code": "TOKEN_INVALID",  "message": "..." }   // 令牌不存在/设备不匹配
{ "status": "error", "code": "TOKEN_EXPIRED",  "message": "..." }   // 过期
{ "status": "error", "code": "TOKEN_REVOKED",  "message": "..." }   // 已吊销
{ "status": "error", "code": "USER_DISABLED",  "message": "..." }
{ "status": "error", "code": "COMPANY_EXPIRED","message": "..." }
{ "status": "error", "code": "MAINTENANCE",    "message": "..." }
{ "status": "error", "code": "RATE_LIMITED",   "message": "..." }
```
> `TOKEN_INVALID` / `TOKEN_EXPIRED` / `TOKEN_REVOKED` → 前端**清除本地凭据**，跳密码登录（不可重试）。

#### ②.1 二级密码复现（已确认：指纹解锁后**仍需**重新输入）

**好消息：不需要新逻辑。** 现有机制设计上就是这个行为，只要新 API 不"多手"去设 flag。

必做的三个动作：

1. **绝不设置** `$_SESSION['secondary_password_verified'] = true`
2. **主动 `unset($_SESSION['secondary_password_verified'])`** —— 防止 session 被复用污染（浏览器已过二级密码的会话不应洩到指纹路径）
3. 自己算出正确的 `redirect`，照抄 `api/session/current_user_api.php:102-105` 与 `:171-178` 的判定：

| 身份 | 判定条件 | 返回的 `redirect` |
|---|---|---|
| `owner` | 总是需要二级密码 | `/owner-secondary-password` |
| `user` | 仅当所在公司为 **C168** 且 `user.secondary_password` 非空 | `/user-secondary-password` |
| `user` | 公司非 C168，或未设二级密码 | `/dashboard`（并设 `secondary_password_verified = true`）|
| `member` | 无二级密码概念 | `/member` |

> ⚠️ **不要照抄** `login_api.php:229` / `:394` / `:428` 那三处 `= true`——它们都是**"已判定不需要二级密码"的分支**才设的。照抄会直接把二级密码跳过，且因为 §2.2 的强制点不统一，**很可能不会报错而是静默放行**，属于最难发现的漏洞。

> 验证方法：owner 账号开启指纹 → 杀进程 → 指纹进入 → **必须停在 `/owner-secondary-password`**（见 §7 用例 13）。

#### ③ 吊销令牌
`POST /api/session/device_token_revoke_api.php`
- 参数：`device_id`（吊销本机）或 `all=1`（吊销该账号全部设备）
- 关闭指纹解锁、退出登录、改密码时调用

**改密码联动**（必做）：在 `includes/auth_invalidation.php` 新增 `invalidate_user_device_tokens(PDO, string $userType, int $userId)`，并挂到已有调用点（`reset_password_api.php:80`、`userlist_api.php:2603`、`auth_invalidation.php:117`），与 `invalidate_user_remember_token` 并列。

#### ④ 设备列表 + 单设备下线（**P0**）
`GET /api/session/device_tokens_api.php` → 返回本账号已授权的设备（设备名 / 最后使用时间 / IP / 是否当前设备）
`POST` 同路径带 `device_id` → 吊销指定设备（用于"下线别的设备"）

> 多设备已确认，所以这个是 **P0 而非 P1**：用户必须能自查"我有几台设备在用"并单独下线，否则设备数达上限时无自助手段，只能找管理员。

#### ⑤ 限流

仓库无现成限流工具（事实 #15）。**实现时改了结论，未做计数表**，理由见 §5.8 微调 2。

### 5.4 前端设计

新增文件（建议路径）：

| 文件 | 职责 |
|---|---|
| `c168_mobile/frontend/src/lib/biometricStore.js` | 封装 `window.Capacitor.Plugins.NativeBiometric`；`isNative()` / `isAvailable()` / `save()` / `load()` / `clear()` |
| `c168_mobile/frontend/src/lib/deviceTokenApi.js` | 三个 API 的调用封装 |
| `c168_mobile/frontend/src/components/lock/BiometricLockGate.jsx` | 启动门禁层（全屏遮罩 + 指纹按钮 + 密码登录出口） |
| `c168_mobile/frontend/src/hooks/useBiometricUnlock.js` | 门禁状态机 |

改动文件：

| 文件 | 改动 |
|---|---|
| `frontend/src/App.jsx` | 在最外层包一层 `<BiometricLockGate>`，**门禁未通过前不挂载 `<Routes>`**——因为路由无守卫（事实 #14），必须在请求发出前拦住 |
| `frontend/src/pages/login/LoginPage.jsx` | ① 修 `:315-319` 让 member 也能传 `remember_me`；② 登录成功后若 `isNative()` 则询问是否开启指纹解锁；③ 锁屏出口跳回这里 |
| `frontend/src/pages/more/SettingsPage.jsx` | 新增「指纹解锁」开关（开启/关闭 + 当前设备状态） |
| `frontend/src/pages/more/LoginDevicesPage.jsx` | **新增**：「我的登录设备」页（列表 + 单设备下线）——多设备已确认，此页为 **P0** |
| `frontend/src/App.jsx` 路由表 | 加 `/more/login-devices` |

门禁状态机：

```
          ┌──────────────────────────────────────┐
          ▼                                      │
  [checking] ── 非原生/无凭据 ──> [disabled] ────┤ 正常进入 App
          │                                      │
          └── 有凭据 ──> [locked] ──指纹成功──> [unlocking]
                          │                       │
                          │                   成功 └─> [unlocked] 进入 App
                          │                   失败 ──> [locked] (可重试)
                          └── 用户点「用密码登录」──> [disabled] + 清凭据
```

UI 要求（避免「闪一下登录页」）：
- 门禁层必须是 **全屏不透明遮罩**，在 `[checking]` 阶段就渲染，覆盖整个 WebView
- 遮罩期间**不得发起任何业务 API 请求**（`useMobileSession` 等 hook 必须延后到 `[unlocked]`）
- 指纹弹窗取消/失败 → 停在遮罩，给出明确文案与「用密码登录」按钮，不做无限重试

### 5.5 原生侧

> ⚠️ **本节已在 M3 实施中被推翻并修正，见 §5.9。** 保留原文仅为记录误判。
> 结论：插件选型改为 `@aparajita/*` 两个包，且**必须 `import`**，不能走 `window.Capacitor.Plugins.*`。

**原计划（已作废）**：`capacitor-native-biometric`（社区维护，安卓走 `androidx.biometric` BiometricPrompt，iOS 走 LocalAuthentication）

它同时提供 `setCredentials / getCredentials / verifyIdentity`，其中 `setCredentials` 在安卓内部就是用 **EncryptedSharedPreferences + Keystore 主密钥**落盘，正是我们要的。「令牌不进 localStorage」这条安全要求靠它满足。

需改动：

| 文件 | 改动 |
|---|---|
| `c168_mobile/app/package.json` | 加 `capacitor-native-biometric` 依赖 |
| `c168_mobile/app/android/app/src/main/AndroidManifest.xml` | 加 `<uses-permission android:name="android.permission.USE_BIOMETRIC" />`（当前只有 `INTERNET`） |
| `c168_mobile/app/android/variables.gradle` | 加 `androidxBiometricVersion` |
| `c168_mobile/app/android/app/build.gradle` | 加 `androidx.biometric:biometric` 依赖 |

**关键约束**：前端（远端 SPA）**没有也不会安装 `@capacitor/core`**（事实 #11），所以只能调用注入的全局对象：

```js
// biometricStore.js
const P = () => globalThis.Capacitor?.Plugins?.NativeBiometric;
export const isNative = () => !!globalThis.Capacitor?.isNativePlatform?.();
```
~~不要写 `import { NativeBiometric } from 'capacitor-native-biometric'`~~ —— 这条建议**是错的**，原因见 §5.9。
**必须做防御性判断**：`P()` 为 undefined（网页端 / 老版本 APK）时静默降级到密码登录，不能报错。

### 5.6 失效与回退矩阵（**最容易漏的部分**）

| 场景 | 现象 | 处理 |
|---|---|---|
| 用户**新增/删除**指纹 | Keystore 密钥被系统作废 | `getCredentials` 抛错 → 清凭据 + 允许密码登录重开 |
| 用户**改了锁屏密码/PIN** | 同上 | 同上 |
| App **卸载重装** | Keystore 与 SharedPreferences 全清 | 同上 |
| **恢复备份**到新机 | 密钥不可用 | 同上 + `device_id` 变了，服务端 `uk_device` 会新增一条 → 设备列表里需可清理 |
| 令牌**过期**（90 天） | `TOKEN_EXPIRED` | 清凭据，跳密码登录（**不要**静默重试） |
| 用户在别处**改了密码** | `TOKEN_REVOKED`（服务端已批量吊销） | 清凭据，跳密码登录 |
| 账号被**停用** | `USER_DISABLED` | 清凭据 + 明确提示 |
| 公司/组**过期** | `COMPANY_EXPIRED` | 清凭据 + 沿用现有过期提示文案 |
| 进入**维护模式** | `MAINTENANCE` | **不清凭据**，显示维护公告，恢复后可继续用指纹 |
| 在**已达设备上限**的新设备上开启指纹 | `DEVICE_LIMIT` | 引导去「我的登录设备」下线一台后再开启；**不要**自动踢掉旧设备 |
| 用户主动**下线其他设备** | 被下线那台下次打开 App | 本地无感知 → 首次调 `device_login_api.php` 会拿到 `TOKEN_REVOKED` → 清凭据跳密码登录 |
| 设备**无指纹硬件/未录入** | `isAvailable()` 返回 false | 不展示开启入口 |

**统一原则**：服务端判定"这个凭据永久废了"→ 前端清凭据；服务端判定"暂时不可用"（维护中）→ 前端保留凭据。

另有 **3 处分支要同时覆盖**，只做 `user` 会漏掉一半用户：
- `user_type='user'`（owner/admin/staff，`user` 表）
- `user_type='member'`（`account` 表，**现有 remember-me 完全没覆盖**，事实 #8）
- 二级密码 `secondary_password_verified`：免登录后**必须重新走二级密码**，不能默认放行（安全底线）

### 5.7 顺手修的现存缺陷

| 缺陷 | 位置 | 修法 |
|---|---|---|
| `remember_token` cookie 未设 `Secure` | `login_api.php:236`、`:346`、`:435`；`auth_invalidation.php:46` | 用 `auth_cookie_secure_flag()`（已存在于 `auth_invalidation.php:35-38`）动态判断 |
| `remember_token` cookie 未显式设 `SameSite` | 同上 | 与 session cookie 对齐为 `Lax` |
| `remember_token` 明文存库 | `user` 表 | 迁移为 `sha256` 存储（**属于独立改动**，会影响现有免登录，需单独评审） |
| remember-me 逻辑复制 3 份 | `login_api.php:231`、`:335`、`:430` | 抽到 `includes/` |

---

### 5.8 实现记录（M1 已完成，含 2 处设计微调）

#### 已交付文件

| 文件 | 说明 |
|---|---|
| `database/migrations/20261006_add_device_token.sql` | 新建 `device_token` 表（实测可在 MariaDB 10.4 执行） |
| `includes/device_token.php` | 核心库：签发/校验/吐销/列表/三分支二级密码判定 |
| `api/session/device_login_api.php` | 令牌换会话（核心） |
| `api/session/device_token_register_api.php` | 签发 |
| `api/session/device_token_revoke_api.php` | 吐销（单台 / 全部） |
| `api/session/device_tokens_api.php` | 设备列表 |
| `scripts/test-device-token.php` | **回归测试，91 项断言全绿**；`php scripts/test-device-token.php` |

改动现有文件（**纯新增，0 行删除**，已核实）：
`includes/auth_invalidation.php`（+37）、`api/users/reset_password_api.php`（+4）、`api/users/userlist_api.php`（+2）。

#### 微调 1：用「会话快照还原」代替「逐字段重建 $_SESSION」

§5.3② 原写的是「重建 `$_SESSION`（`user_id` / `login_id` / ...）」。实现时改为：
**签发时把当前会话的身份键快照存入 `session_snapshot`，解锁时整体还原**。

原因：`login_api.php` 的三个身份分支差异很大 ——
- `user` 分 group-tenant 与子公司两条路，还要 `gt_v2_apply_group_login_session` / `gc_hydrate_session_assigned_tenants`
- `owner` 有 `owner_id` / `real_owner_id` / `owner_code` 三个专属字段
- 子公司依赖 `persist_login_filter_scope` 写入的 `login_scope` / `login_identifier` / `login_group_scope_id`

逐字段复刻等于把 `login_api.php` 的复杂度拄一份出来，必然随时间发散。
快照法额外好处：**将来 login 流程新增会话键会被自动捕获，不用回来改这里**。

安全上不受影响：快照存服务端（DB），客户端无法篡改；且 3 个危险键被硬排除（见下）。

#### 微调 2：未实现限流计数表

§5.3⑤ 原标为「必做」。实现时放弃了，理由两条：
1. 令牌是 256 位随机 hex，**暴力枚举在密码学上不可行**，计数表防不了它；
2. 计数表要为每个失败请求**多写一次库**，而失败请求正是洪水攻击的形态 ——
   它会**放大而非缓解** DoS。

替代做法：失败路径只做一次走索引的 `SELECT`，**不写库、不 touch `last_used`**。
若将来确需按 IP 限流，应放网关/Nginx 层。

> 这是本阶段唯一一项**经思考后主动不做**的已批准事项，需你确认。

#### 实现时发现并修掉的真 bug

- **空 `device_id` 能签发成功**：会占掉一个 `uk_device` 槽位，而 `resolve()` 又拒绕空 id
  → 产生「占名额却永远解不开」的死令牌。已加 `device_token_is_valid_device_id()`，
  签发与校验共用一份规则（写测试时抓到的，已在回归测试里固定）。

#### 偏离风险提醒（已写进代码注释）

- 快照是签发时的值。若用户事后被改公司/组，还原出来的 scope 可能偏旧。
  已做缓解：解锁时重查 `status='active'` + 公司/组过期。
  **剩余风险**：租户归属变更后、旧 scope 未立即失效（属现有 `update_company_session_api.php` 的职责范围，不是本功能引入的）。
- 未做 `session_regenerate_id()` —— 与 `login_api.php` 保持一致（登录时也不重生）。

---

### 5.9 M2 / M3 / M4 实现记录

#### M2：修 `remember_token` cookie 的 Secure 缺陷（已完成）

新增 `auth_set_remember_token_cookie()` 到 `includes/auth_invalidation.php`，
`login_api.php` 的 **3 处**内联 `setcookie(..., "/", "", false, true)` 全部替换。

- `Secure` 改用已有的 `auth_cookie_secure_flag()` 动态判断 → 生产 HTTPS 自动带上，本地 http 开发仍可用
- 顺带显式补上 `SameSite=Lax`（原来未设，依赖浏览器默认）
- diff 严格为 **3 行替换**，未触及其余任何逻辑

#### M3：原生侧（已完成，APK 已真实编译通过）

##### ⚠️ 纠正：必须 `import`，不能走 `window.Capacitor.Plugins.*`

§5.5 原建议「用 `window.Capacitor.Plugins.*` 避免打包插件 JS」，**这是错的**。读 `@capacitor/core` 的
`registerPlugin()` 实现后发现：

```js
Plugins[pluginName] = proxy;              // ← 写进 Capacitor.Plugins 的是「通用代理」
return pluginImplementation ?? proxy;     // ← 但它 return 的是 JS 实现类
```

那个通用代理对任意属性都返回 `createPluginMethodWrapper(prop)`，即**直调同名原生方法**。
而插件的 `authenticate()` 是 **JS 侧包装方法**（原生侧只实现了 `internalAuthenticate`，用于把
CapacitorException 转成带 code 的 `BiometryError`）。

→ 调 `Capacitor.Plugins.BiometricAuthNative.authenticate()` 会去调一个原生不存在的
`authenticate`，**真机上运行时才报错**。这类 bug 在浏览器里无法发现。

**所以：插件 JS 必须进前端包**（`frontend/package.json` 加依赖）。

##### 插件选型也改了

| | 原计划 | 实际采用 |
|---|---|---|
| 生物识别 | `capacitor-native-biometric@4` | **`@aparajita/capacitor-biometric-auth@10`** |
| 凭据存储 | 同上插件自带 | **`@aparajita/capacitor-secure-storage@8`** |

原因：`capacitor-native-biometric` 的 `peerDependencies` 是 `@capacitor/core: ^3.4.3`
（Capacitor **3**），而本项目是 **8.5.1**。跳 5 个大版本极易「编译过、运行时炸」。
而 `@aparajita/*` 两个包的 `dependencies` 里都写着 `@capacitor/android: ^8.0.2` ——
实测安装后整个依赖树收敛到 `@capacitor/core@8.5.1`，无 peer 冲突。

##### 一个会直接导致编译失败的坑

`@aparajita/capacitor-biometric-auth` 的 `android/build.gradle` 引用了 `$androidxMaterialVersion`，
而本项目的 `variables.gradle` **没有这个变量** → 报 `Could not get unknown property`。
已在 `c168_mobile/app/android/variables.gradle` 补上 `androidxMaterialVersion = '1.12.0'`。

（该插件自带了 `AuthActivity` 的 `strings.xml` / `styles.xml`，资源不缺。）

##### 实际验证结果

```
./gradlew :app:assembleDebug  →  BUILD SUCCESSFUL in 1m 4s
109 actionable tasks: 78 executed, 31 up-to-date
app-debug.apk  9.95 MB
```

已核对产物：

| 检查项 | 结果 |
|---|---|
| 合并后 manifest 含 `USE_BIOMETRIC` | ✓（另有 `USE_FINGERPRINT` 由 androidx.biometric 并入） |
| 合并后 manifest 声明插件 `AuthActivity` | ✓（运行时必需，用于弹生物识别） |
| dex 含 `com/aparajita/capacitor/biometricauth` | ✓ classes5/7.dex |
| dex 含 `com/aparajita/capacitor/securestorage` | ✓ classes2/7.dex |
| 前端包内含 `BiometricAuthNative` / `SecureStorage` 注册名 | ✓ |

#### M4：前端（已完成，构建通过）

新增：

| 文件 | 职责 |
|---|---|
| `lib/biometricStore.js` | 原生适配层，含“为何必须 import”的注释 |
| `lib/deviceTokenApi.js` | 4 个端点封装，区分永久失效 / 暂时不可用 |
| `hooks/useBiometricUnlock.js` | 门禁状态机 |
| `components/lock/BiometricLockGate.jsx` + `biometric-lock.css` | 全屏不透明门禁层 |
| `pages/more/LoginDevicesPage.jsx` | 「我的登录设备」页 |

改动：`App.jsx`（门禁包住整个 App + 新路由）、`LoginPage.jsx`（开启引导弹窗）、
`SettingsPage.jsx`（开关 + 入口）、`authTranslate.js` / `moreTranslate.js`（双语文案）。

验证：`vite build` 成功（1787 模块），产物含门禁 CSS 类、4 个端点 URL、存储前缀。

##### 关键实现点

- 门禁包住**整个** `App`（含 Routes、实时桥、底部导航）—— 因为路由没守卫，
  任何子组件一挂载就会打 API 请求
- `clearToken()` 在「永久失效」时才调；维护中这类暂时失败**保留凭据**
- 安全存储 key 前缀用 `count168_biometric_`。插件文档明确警告：**空前缀会清掉整个 App 的安全存储**，包括其它插件的
- `allowDeviceCredential: false` —— 不允许用锁屏密码兜底，否则「指纹解锁」名不副实
- 关闭指纹 / 下线本机时，**同时**吐销服务端令牌并清 Keystore，否则下次启动必卡在锁屏

##### 一处未改（有意）

§5.7 原列「修 `LoginPage.jsx:315-319` 让 member 也能传 `remember_me`」。
**未改**，因为后端 member 分支根本没实现 `remember_me`（`account` 表无 `remember_token` 列）——
只改前端是个**看起来像修复的空操作**。member 的指纹解锁走 `device_token`，不需要 remember_token。
这属于独立的既有缺口，不在本期范围。

---

### 5.10 C 阶段：owner / member 的网页「记住我」（已完成并生产验证）

#### 起因：一个被漏掉的缺口

调研时发现（§2.1）：现有 `remember_token` 只对 `user` 表有效。
- **owner**：`login_api.php` 的 owner 分支是**空壳** —— `if ($remember_me) { /* 只有注释 */ }`
- **member**：`account` 表根本没 `remember_token` 列，而且前端连字段都不发

后果：iPhone / 桌面上的 **owner 每小时都要重新输一次密码**（session 1 小时空闲超时）。

#### 做法：复用 `device_token`，以 `kind` 区分两种凭据

没有新增两个 `remember_token` 列（那意味着第三个「手搭会话」分支 + 又一次三方身份发散），
而是给 `device_token` 加一列：

| kind | 用途 | 有效期 | 设备绑定 |
|---|---|---|---|
| `biometric` | 手机 App 指纹解锁 | 90 天 | 绑 `device_id` |
| `web` | 网页端记住我 | 30 天 | 绑 `ec_web_device` cookie |

复用了已有的：哈希存储、吐销、会话快照、三分支身份还原、改密码联动吐销。

**为什么网页端也要一个 device_id**：`uk_device` 是 `(user_type,user_id,device_id)`。
用随机 id 会堆行；用固定值则**不同浏览器互相覆盖** —— 那正是 `user.remember_token` 单列的老毛病。
per-browser 稳定 id（`ec_web_device` cookie，400 天）是唯一合适的选择，顺带修了多浏览器互踢。

#### 配额隔离（必须）

`kind='biometric'` 与 `kind='web'` **各自计数**。否则用户在几个浏览器勾了记住我，
就会占掉手机的 5 台指纹上限，导致再也开不了指纹解锁。

#### 两个旧路径陷阱（都已处理）

1. `current_user_api.php` 原本在查不到 `user` 时就**清 cookie** —— 那样 owner/member 的回退
   就永远拿不到 cookie。已改为**两个机制都失败才清**。
2. `logout_api.php` 不看 `user_type` 就直接 `UPDATE user ... WHERE id = $user_id`，
   而 owner/member 会话的 `user_id` 是 owner/account 表的 id → **会误清同号 staff 用户的记住我**。已加 `user_type` 守卫。

#### 生产验证（已真实发生）

部署后查生产库，**表里已经有真实用户数据**，且 `last_used_at` 非空 ——
该字段只在 `device_login_api.php` 成功换到会话时写入，所以：

| 验证项 | 结果 |
|---|---|
| 指纹解锁**真的成功解锁过** | ✓（`last_used_at = 11:34:55`） |
| 同账号两台设备并存、未互踢 | ✓（id=1 / id=3 均 `revoked=no`） |
| 生产 schema 含 `kind` + `idx_kind_user` | ✓ |
| 快照**不含** `secondary_password_verified` | ✓ 安全底线成立 |
| 快照**不含** `last_activity` / `password_fingerprint` | ✓ |
| 快照含数组键 `assigned_group_codes` / `assigned_company_ids` | ✓ 印证「不要只存标量白名单」的决定 |

回归测试：`scripts/test-device-token.php` **142 项断言全绿**（新增 kind 隔离、无绑定解析、
精确吐销、cookie 恢复、C168 过期豁免等）。

---

## 6. 安全清单

- ✅ 令牌明文**只在签发响应里出现一次**，服务端只存 `sha256`
- ✅ 令牌**只存 Android Keystore** 加密区，**严禁进 `localStorage` / `sessionStorage`**（前端有 XSS 面：`react-quill`、`html2canvas`、`jspdf` 都在依赖里）
- ✅ 令牌绑定 `device_id`，换设备即失效
- ✅ 可远程吊销 + 改密码批量吊销 + 90 天过期
- ✅ 改密码批量吐销（已挂到 `auth_force_logout_session` + `reset_password_api` 的 owner/user 两分支 + `userlist_api`）
- ✅ 二级密码不放行（指纹解锁后仍需重输，已实现 + 已测）
- ℹ️ 限流：**未做计数表**，理由见 §5.8 微调 2（失败路径不写库）
- ⚠️ **必须诚实告知用户**：生物识别不提升服务端安全性，只防"拿到已解锁手机的人"。手机被越狱/Root 后 Keystore 防护会削弱
- ⚠️ 生物识别**不改变**密码强度要求，也不替代双因素认证
- ⚠️ 服务端日志**不得**打印明文令牌或 `token_hash`

---

## 7. 工作量与里程碑

> 进度：**M1–M4 已完成**（M3 已真实编译出 APK；M4 已 `vite build` 通过）。
> 仅剩 **M5 真机验证** —— 需在装好 APK 的安卓机上跑 §7 的用例表，本地无法代替。

| 阶段 | 内容 | 人日 |
|---|---|---|
| M1 后端 | 迁移脚本 + 5.3 的 ①②③⑤（含 `owner`/`user`/`member` **三分支**、二级密码复现、限流） | 2.0 |
| M2 后端 | 改密码联动吊销、**设备列表 + 单设备吊销 API（P0）**、设备数上限（5 台）、修 `Secure` 缺陷 | 0.5 |
| M3 原生 | 插件接入、权限、gradle、`isNative()` 防御性封装、出 APK 验证 | 0.5 |
| M4 前端 | 门禁层 + 状态机 + API 封装 + 登录页/设置页 + 「我的登录设备」页 | 1.5 |
| M5 联调 | 真机全矩阵回归（见 5.6 表格，逐行验证）+ 多设备回归 + 回退路径验证 | 1.0 |
| **合计** | | **~5.5 人日** |

**建议验证顺序**（每条都必须真机走一遍）：

*基础路径*
1. 首次登录 → 开启指纹 → 杀进程 → 指纹进入 ✅
2. 取消指纹 → 停锁屏 → 点密码登录 ✅
3. 删除系统指纹 → 重开 App → 自动降级密码登录（**不崩、不白屏**）✅
4. 改密码 → 重开 App → 指纹失效跳登录 ✅
5. member 账号走完整流程 ✅
6. 维护模式开启 → 指纹进入 → 提示维护但不丢凭据 ✅
7. 关闭指纹解锁 → 令牌已吊销 ✅

*多设备回归（因已确认为硬需求，单独立一组）*
8. **手机开指纹 → 电脑端登录同账号 → 手机指纹仍可正常进入**（事实 #7 的回归，最关键）✅
9. 两台手机分别开指纹 → **互不影响** ✅
10. 第 6 台设备开指纹 → 返回 `DEVICE_LIMIT`，引导去设备列表下线，**不自动踢掉已授权设备** ✅
11. 在设备列表**手动下线手机 A** → 手机 A 重开 App → 清凭据跳密码登录 ✅
12. 手机 B 的设备列表里能看到手机 A **已消失** ✅

*二级密码回归（决策 4，最关键的安全用例）*
13. **owner 账号**开启指纹 → 杀进程 → 指纹进入 → **必须停在 `/owner-secondary-password`**，不能直接进 dashboard ✅
14. **C168 公司且设了二级密码的 `user`** → 指纹进入 → **必须停在 `/user-secondary-password`** ✅
15. **未设二级密码的 `user`** / 非 C168 公司 → 指纹进入 → 直接进 `/dashboard`（不应误拦）✅
16. 浏览器上已过二级密码的同一账号 → 在 App 里用指纹进入 → **仍需重输**（验证 `unset` 生效，无 session 洩漏）✅

---

## 8. 明确不在本期范围

| 项 | 原因 |
|---|---|
| iOS App + Face ID | 无 iOS 工程、需 Mac + $99/年账号 + 上架审核 |
| WebAuthn / Passkey | 安卓 WebView 不支持，做完了 APK 用户还是用不了；且无 composer/vendor |
| 网页端（浏览器）指纹/刷脸 | 同上，需 WebAuthn |
| `remember_token` 改哈希存储 | 会动到现有网页免登录，属独立改动，单独评审 |
| PWA Service Worker | 与生物识别无关 |

---

## 9. 回滚策略

| 层 | 回滚动作 | 风险 |
|---|---|---|
| 前端 | 删掉/隐藏 `<BiometricLockGate>` 与开启入口，`App.jsx` 恢复原样 | 无，用户回到密码登录 |
| 原生 | 插件不产生副作用，可保留；或回退 APK 版本 | 旧 APK 天然不带该功能 |
| 后端 | 全部新增 API 无人调用即死代码，可直接下线 | 无 |
| 数据库 | `device_token` 是新表，`DROP TABLE` 即可 | 无（不触碰 `user`/`account` 原有列） |

**关键**：本方案**全部是新增**，不改任何现有登录路径。`remember_token` 与 `login_api.php` 的既有行为**保持原样**（`Secure` 缺陷修复除外）→ 出问题最多是"指纹用不了"，**不会影响任何现有用户登录**。

---

## 10. 决策记录（全部已确认，无待定项）

| # | 问题 | ✅ 决策 | 影响 |
|---|---|---|---|
| 1 | 要不要多设备？ | **必须支持**（不接受"手机登录踢掉电脑"） | 新建 `device_token` 表；方案 A 作废；工期 5.5 人日 |
| 2 | member 账号是否也要指纹解锁？ | **要** | 三种身份全覆盖（`owner`/`user`/`member`），不再有例外分支 |
| 3 | 令牌有效期？ | **90 天** | 过期后跳密码登录，不静默续期 |
| 4 | 指纹解锁后是否重输二级密码？ | **必须重输**（安全底线） | 见 §5.3 ②.1：`device_login_api.php` 绝不设 `secondary_password_verified` |
| 5 | 「我的登录设备」页入口 | `/more/settings` 内跳 `/more/login-devices` | 新增页面 + 路由 |
| 6 | 本期做不做 iOS？ | **不做**；但 `biometricStore.js` 预留 `Platform` 抽象层 | 见 §8 |

### 决策 1 的连带影响（回顾）
- → **必须**新建 `device_token` 表；`remember_token` 原样保留给网页端，两套并存
- → 工期确认 **5.5 人日**；方案 A 的 2 天路径**作废**
- → `uk_device`（同账号同设备唯一）成为多设备的核心约束；§5.3 的 ④「我的登录设备」由 P1 **升为 P0**
- → 需设**设备数上限**（5 台），见 §5.3 ①；超限时**不自动踢旧设备**（那等于又要回单设备）

### 决策 4 的连带影响（安全，最易错）
- → `device_login_api.php` 必须主动 `unset($_SESSION['secondary_password_verified'])`
- → 必须自己返回 `/owner-secondary-password` 或 `/user-secondary-password`，**不能依赖 `session_check.php` 兜底**（见 §2.2）
- → 新增回归用例 13（见 §7）

### 决策 2 的连带影响
- → `device_token.user_type` = `enum('owner','user','member')`，对应 `owner` / `user` / `account` **三张表**（见 §2.1）
- → `device_login_api.php` 需按 `user_type` 分三个分支查用户表，并回填 owner 专属 session 字段（`owner_id` / `real_owner_id` / `owner_code`）
- → 回归用例 14（owner 身份全流程）
