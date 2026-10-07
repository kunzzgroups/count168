# 桌面版 ↔ 电话版 功能对齐台账

> 桌面版（`frontend/`）与电话版（`c168_mobile/frontend/`）是**两个独立前端，零共享源码**。
> 桌面修完的 bug 必须**人工同步**到电话版，否则电话版会一直停留在旧行为。
> 本文是这份同步的台账 + 约定：哪里已对齐、哪里还没、怎么复现核查。

---

## 1. 为什么需要这份台账（实测数据）

自电话版出现（首个前端提交 `685e744b67`，2026-07-02）以来：

| 指标 | 数量 |
|---|---|
| 桌面源码提交（非 merge） | **1015**（去重主题 791） |
| 其中**同时**改了电话版的 | **64**（≈6%） |
| 电话版自己的提交 | **461**（几乎全是手机端本身的工作：生物识别/锁屏/登录/UI） |

只看近期客户可见窗口（2026-09-01 起）：桌面功能修复 **43 条**，其中同时改电话版的只有 **3 条**。

**结论：电话版是桌面的「子集重写版」，不是镜像。** 桌面改完不会自动流到电话版，靠人记。

---

## 2. 约定：桌面在共有功能区修 bug 时必须打标记

改了 `frontend/src` 里**电话版也有对应页面**的功能（见第 4 节表），提交信息末尾加：

```
[mobile: 需同步]
```

- 同步完成后，把这条登记到第 5 节表格里（桌面提交 → 电话版提交）。
- 只改桌面专属结构（侧边栏 `public/css/sidebar.css`、`components/AuthenticatedLayout.jsx`、`utils/date/dateRangePicker.js` 等）**不用**打标记。
- 电话版没有的页面（第 4 节「电话版没有」）不用打标记。

这样以后不必再整体审计，`git log --grep "\[mobile: 需同步\]"` 就能列出待办。

---

## 3. 怎么复现核查（不改代码，只读）

```bash
# 电话版首个前端提交时间（审计起点）
git log --reverse --date=short --pretty='%ad %h' -- c168_mobile/frontend/src | head -1

# 桌面提交里有多少同时改了电话版（注意：给了 pathspec 时 --name-only 只会列该路径，必须不带 pathspec）
python - <<'PY'
import subprocess, re
def sh(*a): return subprocess.run(["git"]+list(a),capture_output=True,text=True,encoding="utf-8",errors="replace").stdout
out=sh("log","--no-merges","--name-only","--date=short","--pretty=@%h|%ad|%s","--since","2026-07-02")
rows=[];cur=None
for line in out.splitlines():
    if line.startswith("@"):
        p=line[1:].split("|",2); cur={"sha":p[0],"subj":p[2] if len(p)>2 else "","files":[]}; rows.append(cur)
    elif cur is not None and line.strip(): cur["files"].append(line.strip())
desk=[r for r in rows if any(f.startswith("frontend/src") for f in r["files"])]
both=[r for r in desk if any(f.startswith("c168_mobile") for f in r["files"])]
print("桌面源码提交", len(desk), "其中同时改电话版", len(both))
PY
```

逐条核验某条桌面提交是否已被电话版镜像：`git show --unified=6 <sha>` 看根因与改动行，
再拿关键标识符去 `c168_mobile/frontend/src` 搜等价实现（两边常换变量名/实现方式，要比行为，不能只比文件名）。

常见对应关系：

| 桌面 | 电话版 |
|---|---|
| `pages/transaction/hooks/useTransactionForm.js` | `pages/transaction/AddTransactionSheet.jsx` |
| `pages/transaction/hooks/useTransactionSearch.js` | `hooks/useMobileTransaction.js` |
| `pages/transaction/lib/*` | `lib/*`（同名文件，手工同步） |
| `components/AuthenticatedLayout.jsx` + `public/css/sidebar.css` | `components/layout/MobileShell.jsx` + `MobileAppBar.jsx` |
| `hooks/useAnnouncementUnread.js` | `hooks/useAnnouncementUnread.js`（同名副本，手工同步） |
| `components/AnnouncementUpdateCard.jsx` 等会员壳 | `MobileShell.jsx` 里的通知面板 |

---

## 4. 页面覆盖（桌面 29 个 pageKey → 电话版 15 条路由）

| 桌面 pageKey | 电话版 |
|---|---|
| login / member / dashboard / domain / announcement / ownership | 同名页面 |
| account-list + add-account | 合并为 `/account` |
| userlist | `/more/users` |
| process-list / games-process-list / bank-process-list | **无**（bank process 是 v0.6 有意移除） |
| datacapture / datacapturesummary | **无** |
| transaction / transaction-payment-history | `/transaction`、`/transaction/history` |
| customer-report / domain-report | `/report/customer`、`/report/domain`（电话版另有 ReportHub） |
| capture/transaction/formula/bankprocess-maintenance | **无**（维护中心在电话版被拍平，只剩 `/maintenance/payment`） |
| payment-maintenance | `/maintenance/payment` |
| useraccess / deleted-log | **无** |
| auto-renew | `/more/auto-renew` |
| reset-password | 仅 `StubPage` 占位（桌面有真页面） |

**电话版完全没有的页面**：process-list、games-process-list、bank-process-list、datacapture、datacapturesummary、capture-maintenance、transaction-maintenance、formula-maintenance、bankprocess-maintenance、useraccess、deleted-log。
这些页面上的桌面修复**天然不适用**，不需要同步。

---

## 5. 已对齐登记（桌面提交 → 电话版）

> 电话版落地位置以「文件 + 行为」记录；具体提交用 `git log -- c168_mobile/frontend/src/<那个文件>` 查。

### 2026-10-07 首批（登录页/铃铛/reverse/日期/rate 口径）

| 桌面提交 | 内容 | 电话版落地 |
|---|---|---|
| `25a9f1616a` | transaction 账号搜索只挂载一页 | 同一提交同时改了电话版（4 个文件） |
| `a8161adc04` | RATE divide 模式大金额精度丢失 | `lib/transactionFormat.js` 的 `computeRateGrossAmount`、`lib/transactionSubmitHelpers.js` |
| `b8227ad6fd` | 切 RATE 类型时日期=今天 | 电话版 rate 与普通类型**共用一个日期字段**（`AddTransactionSheet.jsx` 的 `rateDate = txDate`），天然无此 bug |
| `fe9b21cea9` / `5d8e398d1e` | RATE to-amount 预览口径 | 同一提交同时改了电话版 |
| `b4d0447c04` | 铃铛红点改服务端未读 | `hooks/useAnnouncementUnread.js`（新建）+ `MobileShell.jsx` 改用它，删掉 `lib/notifySeenStore.js` |
| `c74e21dc84` | RATE 账号反转不再连带翻转金额 | `AddTransactionSheet.jsx` 的 accounts-reverse 只换账号 |
| `3b72ae8a49` | 提交后 capture date 范围锚定今天 | `hooks/useMobileTransaction.js` 的 `resolveSubmitFocusRangeYmd` + DMY→YMD 归一 |
| `a46a89adfc` | RATE to 预览扣 Middle-Man | `AddTransactionSheet.jsx` 改用 `finalFeeDec` |

### 2026-10-07 第二批（公告/autorenew/PDF/报告回退）

| 桌面提交 | 内容 | 电话版落地 |
|---|---|---|
| `5ce426c1f9` | 公告列表里的链接被显示成文字 | `components/announcements/parseAnnouncementCard.js`（items 内部变 `{text, html}`）+ `AnnouncementUpdateCard.jsx` 用 `dangerouslySetInnerHTML`；折叠预览单独去标签 |
| `22b5a3124a` | auto renew 状态筛选（all/pending/approved/rejected） | `pages/autorenew/AutoRenewPage.jsx` 补上缺失的 **Show All** chip（`counts.total`）+ `translateFile/autoRenewTranslate.js` 文案；后端 `auto_renew.php` 本就支持 `status=all` |
| `5554c6921a` / `82eb85d220` | PDF 里的中文变细/渲染异常 | `lib/paymentHistoryExport.js` 增加 CJK 字体嵌入（照搬桌面实现），**手机端两处调整见第 6 节** |
| `d9f2e3e845` / `0d2499e032` | PDF 中文颜色 | 同上文件：页脚 `textColor` 改 `[0,0,0]` |
| `36495fb2fc` | 后端拒绝 group ledger 时报告页卡在错误态 | `lib/reportApi.js` 新增 `isGroupLedgerDeniedError`，两个报告页的 `loadList` catch 命中后 `applyScope` 回退到该组内有权限的子公司并重载 |

---

## 6. 已知未对齐 / 不适用（连同原因）

### 不适用（桌面专属结构或电话版本就没有该页面）

| 桌面提交 | 内容 | 原因 |
|---|---|---|
| `ae1cd0c599` / `56e3620654` | capture date 相关（进页/刷新） | 改的是桌面共享 DOM 日期控件（`useTransactionDateRange.js` + `#calendar-popup` 脚本）；电话版是 React 状态 + 原生日期控件，没有「脚本 init 时机」这一层 |
| `9a3c94308a` | capture date 列表绑定 | 同上，改的是 `utils/date/dateRangePicker.js` |
| `37d9dc0b31` | return capture 金额截 2 位 | 改的是 `datacapture/`，电话版无抓单页 |
| `b12c09b0bf` / `f0d5e412ff` / `59f9185264` | 公告/通知 alert | 桌面侧边栏专属结构；电话版对应行为在 `MobileShell.jsx`（且已改用服务端未读，见上表） |
| `0a16587fad` + `7a38b4b218` | 桌面登录页加 App 下载入口 | 已 revert |
| `78c3d32d43` / `1f28b6801a` | rate leg-2 描述交叉指涉 | 前端部分已随 `transactionSubmitHelpers.js` 同步；后端 hunk 已被 `5cd96c5f65` 整体 revert，属桌面/后端自身遗留 |

### 有意不移植（手机上不值得 / 会扩大影响面）

| 桌面提交 | 内容 | 决定 |
|---|---|---|
| `5554c6921a` / `82eb85d220` 里的字体策略 | 桌面用 34.5MB 的 NotoSansCJKsc-VF.ttf，并额外下载 2.4MB 静态 Bold | 电话版：**只在报告真的含中文时**才下载（纯英文报告 0 请求、31ms 出 8KB PDF）；**不注册 Bold 面**（电话版表格中文不加粗，且 CJK 单元格已强制 `fontStyle: normal`，否则 jsPDF 会去查不存在的粗体而报错）。实测含中文报告：字体 1 次请求、PDF 761KB（jsPDF 会做子集） |
| `ec3f557b47` | 报告页公司列表 sessionStorage 缓存（刷新即出 pills） | 未移植：电话版这份状态在 `useMaintenanceSession`（所有维护页共用），加缓存影响面超出报告页；且不是报错类 bug，只是首屏快一点 |
| `57267405a1` / `e1c96d78eb` | 冷加载时 companies 还空着 → 记录拒绝、等到达后重试 | 未移植：电话版报告页要求 `scopeReady`（由 companies 推导）才会加载，命中「公司列表为空时被拒」的场景基本不存在；已保留 `pick` 为空时照旧显示错误，不回归 |
| `33ef12adc1` 的 `+1` 语义 | 侧边栏铃铛叠加「到期提醒 +1」 | 电话版没有到期提醒模块（无 `useExpirationReminder` 等价物），无处可加；记为已知差异 |
| `a8161adc04` 的后端部分等 | — | 两端共用同一个后端，不需要「同步到电话版」 |

---

## 7. 踩坑

1. **`git log --name-only` 带 pathspec 时只会列该 pathspec 下的文件** —— 想统计「桌面提交有没有同时改电话版」时不能写 `-- frontend/src`，否则永远统计出 0。正确做法：不带 pathspec，取回全部文件名后在脚本里过滤。
2. **桌面历史里同一修复常有 2–4 个 cherry-pick 副本**（com/org/site 三线合并导致），统计时要按提交主题去重，否则数量翻倍。
3. **不能靠「文件名相同」判已对齐**：电话版同名文件是手工复制出来的副本，会各自漂移；必须比行为。
   - 但对**逐字节复制**的 helper，一条 `diff` 就能定案，比逐行读快得多：
     ```bash
     diff <(sed 's#\.\./\.\./\.\./utils/money/moneyDecimal.js#MONEY#' \
       frontend/src/pages/transaction/lib/transactionSubmitHelpers.js) \
       <(sed 's#\./money/moneyDecimal.js#MONEY#' \
       c168_mobile/frontend/src/lib/transactionSubmitHelpers.js)
     ```
     目前两边这个文件除 import 行外完全一致，所以落在这个文件里的桌面修复都算已对齐。
4. **只对齐 bug，不要顺带搬视觉漂移**：两边的排版参数已经各自演化（例如 PDF 的字号/底色/行高一大堆不同）。搬“样式”会把改动面放大到无法审查；只改与具体 bug 相关的那几行，其余留给以后。
5. **插代码前先看那个作用域有没有同名声明**：本本新增 `const list` 时函数下方已有一个同名声明，一跑就 `Identifier 'list' has already been declared`。构建/浏览器能拓到，但在真浏览器里跑一次能在第一现场拓到（比读 diff 靠谱）。
