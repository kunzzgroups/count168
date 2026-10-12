# 移动端 PIN 解锁（4 / 6 位）——设计、边界与验证

需求来源：锁屏截图反馈 —— **没有用指纹 / 人脸的用户**打开 App 只能每次重输账号密码。
要求：让他们用一个 4 位或 6 位 PIN 解锁；锁屏上把原来的「Use password」换成「Use PIN」，
并在下方单独给一个「Back to login」。本次实现范围与时机由产品确认：
**完整 App 自带 PIN（设置页可设/改/关 + 登录后引导）/ 始终提供（有生物识别的人也能改用 PIN）**。

状态：已实现（纯前端）。涉及文件见 §6。

位数：**默认 6 位，4 位可选**（`lib/pinStore.js` 的 `PIN_LENGTHS = [6, 4]`，
**第一项即设置界面的初始选中值**；改默认只改这个数组的顺序，不要另处再写一个数字）。

---

## 1. 一句话设计

**PIN 不是“另存一个哈希后放行”，而是用 PIN 派生出的密钥把那把设备令牌加密起来**：

```
PIN ──PBKDF2-SHA256(salt, 250k)──► AES-256-GCM key
                                     │
device_token ────────────────────────┴──► ct（唯一能换会话的东西）
```

- 「校验 PIN」与「拿到令牌」是**同一个动作**（GCM 认证标签对不上就解不开）→
  不存在「校验通过但没凭据」这种中间态。
- 明文令牌**不落地**：PIN 用户的令牌只存在于密文里，不回写 Keystore。
- PIN 记录里既没有 PIN 本身，也没有明文令牌（单测有断言）。

## 2. 状态模型

| 键 | 内容 | 判据 |
|---|---|---|
| `ec_pin_unlock` | `{v,len,iterations,salt,iv,ct,updated}` | **只有一条完整记录才算“开着”** |
| `ec_pin_fails` | 已连错次数（数字） | 与 PIN 本身分开：它属于“这一次猜的过程” |

不另存 `enabled: true` —— 与 `lib/biometricSettings.js` 同一条原则：
**不存可以互相矛盾的量**。残缺记录（缺 salt/iv/ct、位数非法）一律当成关闭，绝不猜。

「门禁锁不锁」的判据因此变成两个条件之一：

```
锁上 ⇔ Keystore 里有生物识别凭据  ∨  ec_pin_unlock 是一份完整记录
```

⚠️ 这是本次最容易写错的一处：只按“有没有凭据”判断的话，
**只设了 PIN 的用户冷启动后完全没有门禁**（`loadToken()` 是 null）。

## 3. 失败与生命周期

位数默认 6（见开头）；下面所有重试/清空策略与位数无关。
| 情况 | 行为 | 为什么 |
|---|---|---|
| PIN 错 | 留在锁屏，提示「还可以试 N 次」 | 用户需要知道自己离被关还有多远 |
| 连错 5 次（`PIN_MAX_ATTEMPTS`） | **清掉 PIN**，只剩「用密码登录」 | 不用“锁一段时间”：客户端时间可改，锁等于没锁 |
| 记录被改坏 / 解出来不是令牌 | 清掉 PIN 并说明 | 留着只会每次启动都白跑一次 250k 次 PBKDF2 |
| 服务端说令牌已废（`TOKEN_INVALID/EXPIRED/REVOKED`） | 清 PIN + 清 Keystore，回密码登录 | 与生物识别同一条永久失败分支 |
| 服务端暂时不可用（维护 / 网络） | 留在锁屏，保留 PIN 与凭据 | 维护公告之类的信息原样透出 |
| 在设置里关掉 PIN | 清 PIN；**若本机没有生物识别凭据**，顺手吐销那张设备令牌 | 否则它会以“谁也解不开的记录”留在服务端直到过期 |

「返回登录」按钮**不清任何凭据**（与原来「用密码登录」一致）：
这一次用密码 ≠ 把解锁关掉。

## 4. 与生物识别的共用关系（重要）

PIN 与指纹/人脸**共用同一张设备令牌**（服务端 `device_token`，kind=`biometric`）：

- 设 PIN 时本机已有令牌（指纹用户在用）→ **复用**；
- 本机没有（没指纹/人脸）→ 走 `device_token_register_api.php` 新签一张。

⚠️ **绝不在已有令牌时重新签发**：服务端按 `(user, device_id, kind)` 唯一
（`ON DUPLICATE KEY UPDATE`，见 `includes/device_token.php` 的 `device_token_issue`），
重新签发会把正在用的那把换掉 —— 用户下次用指纹会拿到「此设备已失效」。

反向也成立：**开启生物识别会顶掉 PIN 密文里那把旧令牌** → 因此
`SettingsPage.toggleBiometric`（以及登录后引导的 `enable()`）在开启成功后会
`clearPin()` 并给出一句说明（`pinTranslate.clearedByBiometric`），让用户知道要重设。

本次**没有**改后端：不新增 `kind=pin`（那会让同一台设备出现两行、配额与去重都变复杂），
也不新增端点 —— PIN 解锁走的仍然是 `device_login_api.php`，与指纹完全同一条链路。

## 5. 界面

**锁屏（`BiometricLockGate.jsx`）**——三种呈现，由**设备实情**决定，不靠用户猜：

| 设备状态 | 呈现 |
|---|---|
| 有生物识别凭据（安卓） | 生物识别卡片：`[重试]` + `[用 PIN 解锁]`（没设 PIN 时是 `[用密码登录]`）+ `[返回登录]` |
| 只有 PIN（安卓没指纹 / **iOS 全部**） | 直接是 PIN 键盘（标题「PIN 解锁」），下方 `[返回登录]` |
| 生物识别刚被证明不可用（没录入 / 系统里删了） | 自动切到 PIN 键盘；还能回生物识别（有凭据时） |
| iOS / 网页且**没设 PIN** | **不锁**（与改动前完全一致：passkey 那条路归 LoginPage 管） |

自动切换用**三态** `pinChoice`（未表态 / 要看 PIN / 要回生物识别）：
只在“未表态”时自动判断，否则用户点回指纹后会被自动逻辑立刻弹回 PIN（实机上就是死循环）。
自动判断只依据**真实证据**（失败码 + 探测结果），不把能力探测当门槛（沿用 BUG-3 的结论）。

**设置页**——新增一行「PIN 解锁」（on/off + 已开启时的「修改」「已开启 · 4/6 位」）。
判据是 `isPinSupported()`（有 WebCrypto + 本地存储）——**安卓与 iOS 都有**。

> 第一版这里写的是 `isNative() && isPinSupported()`，把 iOS 直接排掉了（理由是那边没有启动锁），
> 结果用户实机看到的就是“iOS 设置里还是旧的”。判据只该看“能不能安全地存 PIN”，
> 而不是“我当初以为哪里用得上”。

**登录成功引导**——原来只引导生物识别；现在按设备实情二选一：
有生物识别引导生物识别，**没有则引导设置 PIN** —— 这正是需求里那批用户唯一的入口。

## 6. 文件

| 文件 | 作用 |
|---|---|
| `c168_mobile/frontend/src/lib/pinStore.js` | **新增**：权威状态 + PBKDF2/AES-GCM + 失败计数（纯逻辑，可在 node 里测） |
| `c168_mobile/frontend/src/lib/biometricLogin.js` | `nativePinLogin()`：与 `nativeBiometricLogin()` 并列，只换掉第一步 |
| `c168_mobile/frontend/src/hooks/useBiometricUnlock.js` | 多出 `bioCredential / pin / pinTries / unlockWithPin`；门禁判据改为“凭据 ∨ PIN” |
| `c168_mobile/frontend/src/components/lock/PinPad.jsx` | **新增**：PIN 键盘（三处共用） |
| `c168_mobile/frontend/src/components/lock/PinSetupModal.jsx` | **新增**：`usePinSetup`（令牌复用/签发 + 落库）+ 设置面板 + 弹窗 |
| `c168_mobile/frontend/src/components/lock/BiometricLockGate.jsx` | PIN 视图 + `[返回登录]` + 文案中性化 |
| `c168_mobile/frontend/src/components/lock/BiometricEnrolModal.jsx` | 引导分两种方式（生物识别 / PIN） |
| `c168_mobile/frontend/src/components/lock/biometric-lock.css` | PIN 键盘 / 设置弹窗样式 |
| `c168_mobile/frontend/src/pages/more/SettingsPage.jsx` + `more.css` | PIN 那一行 |
| `c168_mobile/frontend/src/translateFile/pinTranslate.js` | **新增**：三处共用的文案（zh/en） |
| `c168_mobile/frontend/scripts/test-pin-unlock.mjs` | **新增**：16 条单元断言 |
| `c168_mobile/frontend/dev-harness/pin-lock*.{html,jsx,mjs}` | **新增**：真浏览器里的 14 条端到端检查 + 截图 |

## 7. 安全边界（必须诚实写下来）

- **4 位 PIN 只有 1 万种组合**，而密文就在本机。PBKDF2 250k 次迭代只能拖慢、
  拖不住有 GPU 的攻击者（量级：秒）。**迭代次数不是防线**，别指望调大它就安全。
- 真实防线是**手机自己的锁屏**：攻击者得先有一台解锁并取得本机文件的手机。
- 与现有生物识别**同级**，不更低：插件的 Keystore 键没有
  `setUserAuthenticationRequired`，所以今天任何一段跑在 App 里的 JS
  本来就 `loadToken()` 拿到明文令牌 —— 生物识别一直是**界面门**，
  而 PIN 用户在此之上还多了一层“明文不落地”。
- 要真正抬高上限，只能上原生：Keystore 键 + `setUserAuthenticationRequired(true)`
  （把尝试次数交给系统锁定），需要**重新打 APK**，不在本次（纯 Web）范围内。
- 默认位数已按产品要求定为 **6 位**（穷举成本是 4 位的 100 倍）；4 位仍可选，
  但不建议作为默认 —— 改默认只需改 `PIN_LENGTHS` 的顺序。
- 还可以做的量变：把密文改存 SecureStorage、把 PBKDF2 迭代调大。都不是质变。

## 8. 验证

```bash
cd c168_mobile/frontend
node scripts/test-pin-unlock.mjs                      # 17/17：默认位数、加解密、失败计数、坏记录
npm run dev -- --port 5174 --strictPort               # 另开一个 shell
CHROME_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" \
  node dev-harness/pin-lock-loop.mjs --shots=1        # 17/17：锁屏三态、错码、连错清 PIN、设置弹窗、4 位、iOS 路径
```

`dev-harness/pin-lock.html` 也可以直接手动打开看：`?bio=1` 模拟“同时有指纹”，
`?setup=1` 只看设置 PIN 的弹窗，`?pin=4821&len=4` 看 4 位 PIN 的锁屏，
`?web=1` 模拟 iOS/普通网页（不注入原生桥）——**iOS 的两个回归都在这条路上测**：
设过 PIN 必须锁、没设 PIN 必须不锁。harness 只伪造两件事：原生桥、`device_login_api.php`；
PIN 的加解密、localStorage、门禁与键盘都是真代码。

真机上仍需人工确认（浏览器给不了）：系统生物识别弹窗时序、Keystore 失效场景、
以及「没有指纹的老机型」首次设置 PIN 的完整流程。

第 8 节末尾的那条“只在原生壳里”已移除：**iOS 现在也能用 PIN**。

## 9. 平台差异（iOS 与安卓）

两个平台共用同一套 `pinStore` / `PinPad` / 设置行，差别只有“什么时候锁”：

| | 安卓 APK | iOS（Safari / 加到主屏幕） |
|---|---|---|
| 启动锁的判据 | 有生物识别凭据 **或** 设过 PIN | **只**看有没有设 PIN |
| 生物识别 | 系统弹窗（Keystore 凭据） | 无（`loadToken()` 恒为 null，passkey 走登录页） |
| PIN 设置入口 | 设置页那一行（+ 登录后引导，见下） | 设置页那一行 |
| PIN 用途 | 没指纹/人脸的用户；有指纹的人也能改用 | 同一批用户**唯一的**快捷入口（独立 App 里 passkey 用不了） |

共享的东西：同一张设备令牌类型（kind=biometric）、同一个换会话端点、同一份密文格式 ——
**iOS 上设的 PIN 和安卓上设的 PIN 是同一套逻辑，不是两套代码。**

## 10. 本次留下的尾巴

- `LoginPage.jsx` 的 `<BiometricEnrolModal>` 仍没传 `mode` / `onEnablePin`
  （该文件当时被另一个并行改动占用）。`BiometricEnrolModal.jsx` 里用一个模块级
  `pendingOffer` 兜住了它，所以登录页上的 PIN 引导**功能是通的**；
  等那个改动落地后补上这两个 prop，并把 `pendingOffer` 删掉（文件里有 TODO）。
- PIN 记录随 App 数据一起被清（清 localStorage / 重装）→ 用户重设即可，
  Keystore 里若无凭据，服务端那张令牌会在 TTL 到期后自然失效。
- **iOS 目前没有“登录后引导设 PIN”**（只有设置页那一行）。安卓那边有引导，
  因为安卓本来就有这个弹窗；iOS 今天对 passkey 也是“只在设置里开”，
  凭空多一个登录后弹窗会改变所有 iOS 用户的登录体验，需要产品明确点头再加。
- iOS 的旧包会被主屏幕 App 缓存：部署后要**完全关掉再从主屏幕打开**，
  或者在 Safari 里清一次网站数据，否则看到的还是旧界面（`dist/index.html` 里引用的是带 hash 的
  文件，HTML 本身一变就全变，所以清一次就够）。
