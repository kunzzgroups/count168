# iOS / 网页端 Face ID 可行性评估（WebAuthn / Passkey）

> 结论先说：**技术上完全可行，但我不建议现在做。** 理由与成本见 §1 与 §4。
> 本文是决策文档，不是实施方案；给出明确推荐（§9）与更便宜的替代路径（§10）。

---

## 1. 结论摘要

| 问题 | 结论 |
|---|---|
| iOS 上现在能用指纹/人脸吗？ | ❌ 不能。仓库无 iOS 工程；我的指纹方案在网页端会**静默降级**为密码登录 |
| 为什么网页拿不到 Face ID？ | iOS Safari 不给网页开生物识别 API。唯一标准路径是 **WebAuthn / Passkey** |
| WebAuthn 能做吗？ | ✅ 技术可行，服务器条件满足（见 §3 实测） |
| 成本主要在哪？ | **不在密码学**，而在：① 仓库没有 composer 基础设施；② 三个域名的 RP ID 互相隔离；③ 它改变的是**登录方式**，不是"给 App 加把锁" |
| 建议 | **暂缓**，但先注意 §10.1：iOS 实测只保存 username+password，公司 ID 需本地记忆（**已实施**）。B 的价值因此比初评更高 |

---

## 2. 为什么"现在"不是好时机

C 阶段（owner/member 网页记住我）已经上线，**每小时输密码的痛已经消除**。这改变了 B 的性价比：

| | 做 B 之前 | C 上线之后 |
|---|---|---|
| owner 在 iPhone 上的主要抱怨 | 每小时重输密码 | ✅ 已解决（30 天记住我） |
| B 的增量价值 | 很大（顺带解决输密码） | 缩小为"更好看/更安全" |

B 剩下要解决的是两件事，且都不紧急：
1. 在**独立 PWA**（添加到主屏幕）里也要刷脸
2. 把桌面端登录升级成抗钓鱼

---

## 3. 服务器与本地实测条件

| 项 | com 生产（EC2） | 本地开发（XAMPP） |
|---|---|---|
| PHP | **8.5.6** | 8.2.12 |
| `web-auth/webauthn-lib` 要求的 `>=8.2` | ✅ | ✅ |
| `ext-openssl`（ES256 验签必需） | ✅ | ✅ |
| `ext-json` / `mbstring` / `bcmath` | ✅ | ✅ |
| `ext-sodium` | ✅ 有 | ❌ **无** |
| `ext-gmp` | ❌ 无 | ❌ 无 |
| **composer** | ❌ **未安装** | ❌ 未安装 |
| `vendor/` 目录 | ❌ 不存在 | ❌ 不存在 |

**结论**：验签必须走 **openssl**（两边都有）；**不要**用 sodium（本地缺，dev/prod 会分叉）。

`web-auth/webauthn-lib` v5.3.9 的依赖实测：
- `requires`: `php >=8.2`、`ext-json`、`ext-openssl`、`spomky-labs/cbor-php`、`web-auth/cose-lib`、
  **外加 7 个 Symfony 包**（clock / uid / property-info / property-access / serializer / deprecation-contracts）
  与 paragonie / phpdocumentor / psr 系列 —— 合计约 **20 个包**。
- ✅ 不需要 `ext-gmp`（这点很关键，服务器没装）

---

## 4. 三个"不显眼但会咬人"的成本

### 4.1 仓库没有 composer，而它现在靠 git push + nginx 部署

引入 20 个包意味着要在**三个域名**上解决 `vendor/` 怎么到位的问题，二选一：

| 方案 | 代价 |
|---|---|
| 提交 `vendor/` 进 git | 仓库体积暴增（数千文件），且每次升级产生巨大 diff |
| 部署时服务器跑 `composer install` | 要改 3 套部署流程、服务器装 composer、引入网络依赖 |

这个仓库现在的发布模型非常轻（`git push main` → Actions → `deploy.sh`）。
为了一个便利功能去动它，**风险与收益不成比例**。

### 4.2 `www.count168.com` / `.org` / `.site` 是三个独立 RP ID

WebAuthn 的 RP ID 必须是可注册域后缀，**不能跨域名共享凭据**：

| 域名 | RP ID | 凭据能否互通 |
|---|---|---|
| `count168.com` / `www.count168.com` | `count168.com` | 二者可共用 ✅ |
| `count168.org` | `count168.org` | ❌ 与 com 隔离 |
| `count168.site` | `count168.site` | ❌ 与 com 隔离 |

好消息：三个域名**本来就各自独立数据库**，所以"各注册一次"是一致的、不是缺陷。
但必须接受"用户在 com 注册的 passkey 在 org 上无效"。

### 4.3 它改变的是登录方式，不是加把锁

现有指纹方案是「本地保管凭据 + 本地门禁」——对用户是**可选的便利**。
WebAuthn 是**服务端认证因子**，流程完全不同：

- 用户必须**先登录一次**才能注册 passkey（一次性的迁移动作，所有现有用户都要做）
- 登录页要新增「用 Face ID 登录」入口
- 桌面端也要跟着改（对桌面用户，Passkey 其实是**升级**：抗钓鱼、无共享秘密）

所以它的产品面比"加把锁"大得多。

### 4.4 ⚠️ 安卓 APK 内不可用（关键约束）

Android WebView **不支持 WebAuthn**。所以做了 B 之后：

| 客户端 | 指纹/人脸走哪条路 |
|---|---|
| 安卓 APK（com） | 继续走现有 `device_token`（**已上线并验证在用**） |
| iPhone Safari / PWA | 走 WebAuthn（B 新增） |
| 桌面浏览器 | 走 WebAuthn（B 新增） |
| 安卓 Chrome | 走 WebAuthn（B 新增，与 APK 内不同机制） |

→ 结果是要**长期维护两套机制**。这不是不能接受，但必须明知。

---

## 5. 两条实现路线

### 路线 1：引入 `web-auth/webauthn-lib`（不推荐）

- ✅ 经过审计、覆盖完整（含 attestation 解析、多种算法）
- ❌ 需要 composer + 20 个包 + §4.1 的部署改造
- ❌ 需要 PHP 8.2+（满足），但把版本下限抬高了

### 路线 2：手写最小 ES256 验证（**推荐**）

关键洞察：如果注册时请求 `attestation: "none"`，**可以完全跳过 CBOR 的 attestationObject**，
只需处理两个结构：

1. **`authenticatorData`（纯二进制，非 CBOR）**，布局固定：
   `rpIdHash(32) | flags(1) | signCount(4) | [aaguid(16) | credIdLen(2) | credId | COSE公钥]`
2. **COSE 公钥**：一个**极小且结构固定**的 CBOR map
   `{1: kty, 3: alg, -1: crv, -2: x, -3: y}`，其中 x/y 是 32 字节 bstr

→ 因此不需要完整 CBOR 实现，一个只认「整数键 → 整数/bstr」的迷你读取器约 **40 行**。
再 + COSE→PEM 转换（约 40 行）+ `openssl_verify(..., OPENSSL_ALGO_SHA256)`。

**总量约 250–400 行**，零新依赖，且 dev/prod 行为一致（只用 openssl）。

> 手写密码学通常不该做，但这里的范围**窄到几乎没有犯错空间**：
> 我们只接受 ES256 + `attestation=none`，不做算法协商、不解析 attestation 证书链。
> 反过来说，**如果将来要支持 RS256 / 完整 attestation，就该改用路线 1**。

---

## 6. 需要新增的东西

### 6.1 表

```sql
CREATE TABLE `webauthn_credential` (
  `id`            bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_type`     enum('owner','user','member') NOT NULL,
  `user_id`       int NOT NULL,
  `credential_id` varbinary(255) NOT NULL,     -- authenticator 给的凭据 ID
  `public_key_pem` text NOT NULL,              -- COSE 转好的 PEM
  `sign_count`    int unsigned NOT NULL DEFAULT 0,  -- 防克隆计数器
  `device_name`   varchar(100) DEFAULT NULL,
  `created_at`    datetime NOT NULL DEFAULT current_timestamp(),
  `last_used_at`  datetime DEFAULT NULL,
  `revoked_at`    datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_credential` (`credential_id`),
  KEY `idx_user` (`user_type`,`user_id`,`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 6.2 端点（都在 `api/session/`）

| 端点 | 作用 |
|---|---|
| `webauthn_register_options_api.php` | 已登录时下发 challenge + rp 信息 |
| `webauthn_register_verify_api.php` | 校验注册响应，存公钥 |
| `webauthn_login_options_api.php` | 下发登录 challenge（**未登录**可访问） |
| `webauthn_login_verify_api.php` | 验证断言 → 建会话 → 返回与 `login_api.php` 同构的响应 |
| `webauthn_credentials_api.php` | 列出 / 吊销 passkey |

**`webauthn_login_verify_api.php` 可以直接复用现有资产**：
- 会话建立用 `device_token.php` 里已有的**快照机制**（`device_token_capture_session` 不适用，
  但「重建会话」这件事已有 `device_token_restore_session` 的思路可借鉴）
- 二级密码判定直接调 `device_token_secondary_password_redirect()`
- **仍必须 `unset($_SESSION['secondary_password_verified'])`** —— 与指纹方案同一条安全底线

### 6.3 Challenge 存储

challenge 必须一次性、短时效、服务端存储。用 `$_SESSION` 即可（无需新表），
但要注意 `api/session/current_user_api.php` 的 bootstrap 会重建会话 —— **注册/登录的 challenge
必须存在独立于身份会话的键**，否则会被覆盖。

---

## 7. 安全注意点（容易漏）

1. **challenge 一次性**：验证后立即失效，否则可重放
2. **验证 `rpIdHash`**：必须等于 `sha256('count168.com')`，防跨域钓鱼
3. **验证 `origin`**：`clientDataJSON.origin` 必须等于本站 origin
4. **验证 `type`**：注册是 `webauthn.create`，登录是 `webauthn.get`，不可混用
5. **`signCount` 单调性**：新值 ≤ 旧值（且非 0）→ 可能被克隆，应告警/吊销
6. **`user verification`**：请求 `userVerification: "required"`，否则可能只验"设备在场"而非"本人"
7. **二级密码仍要**：passkey 替代的是密码，不是二级密码
8. **`allowCredentials` 为空时**：账号枚举风险（可发现式凭据）—— 建议登录时先让用户输入账号，再带 `allowCredentials`

---

## 8. 工作量估算

| 阶段 | 内容 | 人日 |
|---|---|---|
| W1 | 迷你 CBOR + COSE→PEM + ES256 验签 + **单元测试**（关键：用已知向量测） | 1.5 |
| W2 | 表 + 注册两端点 + 凭据管理 | 1.0 |
| W3 | 登录两端点 + 复用二级密码判定 + 会话建立 | 1.0 |
| W4 | 前端：`navigator.credentials` 封装 + 登录页入口 + 设置页注册 | 1.5 |
| W5 | 真机/多浏览器回归（Safari、Chrome、iPad、桌面） | 1.0 |
| **合计** | | **~6 人日**（比引库路线的 ~8–10 人日更省，且无部署改造） |

对比 C 阶段的 ~1 人日 —— 这是 C 的 6 倍。

---

## 9. 推荐

**暂缓 B。** 按这个顺序：

1. **先做 §10 的零成本验证**（今天就能做，5 分钟）
2. 如果 §10 的结果不够好，再决定要不要投 ~6 人日
3. 真要做的两个前提：① 明确"独立 PWA 里也能刷脸"是硬需求；② 接受长期维护两套机制

**不建议**为了"顺便提升安全性"而做 B —— 安全收益真实但用户感知弱，
而成本（6 人日 + 两套机制 + RP ID 三域隔离的解释成本）是可见的。

---

## 10. 更便宜的替代（已部分实施）

### 10.1 ⚠️ 先纠正一个我之前的错误结论

我最初写的是「Safari 密码自动填充本身就是 Face ID 保护的，零开发成本」。**这个结论不完整。**

用户实测反馈：**iOS 只保存 username 和 password，不保存公司 ID。**

原因在 iOS 钥匙串的模型：一个凭据就是
`(origin, username, password)` —— **只有两个槽位**。而本项目的登录表单有**三个**字段：

| 字段 | 当前 `autoComplete` | iOS 行为 |
|---|---|---|
| 公司 / 集团 ID | `organization` | ❌ 不保存、不填充 |
| 用户名 / 账号 | `username` | ✅ 保存 + 填充 |
| 密码 | `current-password` | ✅ 保存 + 填充 |

→ 所以光靠自动填充，用户**每次仍要手输公司 ID**，便利性大打折扣。
为此新增 `lib/lastLoginPrefs.js`（**已上线**）：

- 登录**成功后**把公司 ID 写入 `localStorage`（只存成功值，不存输错的）
- 下次加载自动带入输入框
- 公司 ID **不是机密**（设置页、`login_identifier` 里都显示），本地记住无安全影响

⚠️ **注意**：`autoComplete="organization"` 我**没有改**。
语义上它是错的（那是给联系人/地址填的），但 iOS 现在能正确识别 username 与 password，
改成别的值有**反而把 iOS 启发式弄乱**的风险。既然当前行为是可用的，就不动它。

### 10.2 实施后的实际体验（Safari）

1. 公司 ID：自动带入 ✅
2. 用户名 + 密码：点输入框 → **Face ID** → 自动填入 ✅
3. 点登录

→ **零手输**，这已经是你要的效果。

### 10.3 这个发现反而抬高了 B 的价值

因为 B（Passkey）**根本没有表单** —— 它一次性消除了全部三个字段，
包括公司 ID 这个 iOS 钥匙串天生处理不了的字段。这比我最初评估时更有份量。

所以现在判断 B 值不值，就扫到一个问题上：

> **你用的是 Safari，还是「添加到主屏幕」的独立 PWA？**
> - Safari → §10.2 已经够用，**不用做 B**
> - 独立 PWA → 自动填充历史支持较差，且公司 ID 的本地记忆虽然生效，
>   但用户名/密码可能要手输 → **这种情况下 B 才真的值 6 人日**

### 10.4 还有一条未做的路（需你拍板）

如果想让公司 ID 也进钥匙串，唯一办法是**把它折进「用户名」**，例如允许在账号框里写
`C168\alice`（类似 Windows 的 `DOMAIN\user`），后端在缺 `company_id` 时解析它。

- ✅ 钥匙串存的就是完整标识，真正零手输
- ❌ 改变用户习惯（需输一次新格式）、后端要加解析、要处理歧义

**比 localStorage 方案麻烦得多，收益却重叠** —— 不建议。

### 10.5 另一条可选优化

同一个 `lastLoginPrefs.js` 可以顺便记住**登录后的角色 Tab**（admin / member），
但会与 URL 上的 `?role=` 参数产生互动（切回 admin 时会删掉该参数），
分支会变多。当前没做 —— 如果你的账号是 member、每次都要手动切 Tab，告诉我，我加上。

---

## 11. 需要你确认的问题

1. **你要的是 Safari 里刷脸，还是「添加到主屏幕」的独立 PWA 里刷脸？**
   - 前者 → §10 大概率够用，**不用做 B**
   - 后者 → 只能做 B
2. 桌面端登录要不要一起升级成 Passkey？（这是 B 的额外价值）
3. 能不能接受"com 注册的 passkey 在 org/site 上无效、需各自注册"？

---

## 12. 实施记录（已完成）

> 本文档的 §9「建议暂缓」已被产品方决定推翻：**做了**。
> 采用 §5 的**路线 2（手写最小 ES256）**，未引入 composer。

### 交付物

| 文件 | 说明 |
|---|---|
| \`includes/webauthn.php\` | 密码学核心：base64url、迷你 CBOR、COSE→PEM、签名归一化、rpId/origin 推导、authData 解析、一次性 challenge、凭据存储 |
| \`api/session/webauthn_register_options_api.php\` | 注册第 1 步：下发 challenge + rp + excludeCredentials |
| \`api/session/webauthn_register_verify_api.php\` | 注册第 2 步：验 attestationObject（**fmt 必须是 none**）→ 存公钥 |
| \`api/session/webauthn_login_options_api.php\` | 登录第 1 步：下发 challenge（未登录可访问） |
| \`api/session/webauthn_login_verify_api.php\` | 登录第 2 步：验签 → 建会话（响应与 login_api 同构） |
| \`api/session/webauthn_credentials_api.php\` | 查询 / 账号级移除 |
| \`database/migrations/20261006_add_webauthn_credential.sql\` | 建表 |
| \`scripts/test-webauthn.php\` | **73 项断言**，不需要浏览器与数据库 |
| \`c168_mobile/frontend/src/lib/webauthn.js\` | 前端封装（base64url↔ArrayBuffer、两次 ceremony） |

### 为什么敢手写密码学（范围被刻意收窄）

- 注册请求 \`attestation: "none"\` → **完全不解析 attestation 证书链**
- **只接受 ES256**，不做算法协商；\`pubKeyCredParams\` 也只声明 -7
- 因此 CBOR 只需读两个小结构：attestationObject 顶层 map + COSE 公钥 map

### 测试为什么不是自证

签名由 **openssl 独立生成**，被测代码只负责验。如果 CBOR / COSE→PEM / 签名归一化 /
\`authData || sha256(clientDataJSON)\` 拼接有任何一处写错，验签就会失败。
其中「裸 r||s → DER」的用例是：先用 openssl 签出 DER，反解成裸 64 字节，
再用被测函数转回 DER，最后交给 openssl 验通 —— 真正验证了转换器。

### 安全要点（逐条实现并测试）

| 项 | 实现 |
|---|---|
| challenge 一次性 | \`wa_challenge_consume()\` **取出即 unset**，且校验 purpose，注册/登录不能互用 |
| origin 精确匹配 | 只与推导出的允许集合逐字节比对；**钓鱼子域、前缀假域、其它域名全部拒绝**（有专门断言） |
| rpIdHash | 必须等于 \`sha256(rp_id)\` |
| UP / UV | 都必须置位（我们请求 \`userVerification: required\`） |
| AT | 注册时必须有；登录时不需要 |
| attStmt | **\`fmt !== none\` 一律拒绝** —— 因为不校验它，接受就等于把未验证的声明当真 |
| signCount | 单调性检查（新旧都为 0 时放行，因平台验证器恒返回 0） |
| 二级密码 | 复用 \`DEVICE_TOKEN_TRUSTED_SKIPS_SECONDARY\`，与指纹解锁同一策略 |
| 维护模式 / 公司过期 / 账号停用 | 与 \`login_api\`、\`device_login_api\` 同语义 |

### 与手机 App 的关系（两套机制并存）

| 客户端 | 机制 |
|---|---|
| 安卓 APK | \`device_token\`（本地凭据 + 生物识别门禁）—— **WebAuthn 在安卓 WebView 里不可用** |
| iPhone Safari / PWA | WebAuthn（本次新增） |
| 桌面浏览器 | WebAuthn（本次新增） |

前端用 \`webauthnSupported() && platformAuthenticatorAvailable()\` 决定是否显示入口，
所以 APK 内不会出现这个按钮。

### 遗留 / 已知限制

- **RP ID 按域名隔离**：com 注册的 passkey 在 org/site 上无效，需各自注册（与三库独立一致）
- \`excludeCredentials\` 已用于阻止同一验证器重复注册
- 未做「任意吊销单条凭据」，只有账号级移除（多一个入口就多一份越权面）