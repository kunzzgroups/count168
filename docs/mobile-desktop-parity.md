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

## 7. 2026-07~08 窗口审计记录（进行中）

2026-09 之前的桌面提交也已按同一方法筛过一遍：

| 阶段 | 条数 |
|---|---|
| 窗口内桌面源码提交 | 941（其中 193 条是同一修复的 cherry-pick 重复） |
| 落在电话版**没有的页面** → 跳过 | 317 |
| 能对上电话版提交（其提交信息引用了桌面 sha / 同主题）→ 已对齐 | 304 |
| 剩下候选 | 127 |
| 再剔除桌面专属「面板绘制/动画/性能/侧栏」类 | 58 → 剩 **69** |
| 从 69 里挑出「像业务行为」的派单核验（transaction 10 / dashboard 9 / account 等 12） | 31 |
| 核验结论：真缺口 | **7**（见下） |

### 本轮已修（3）

| 桌面提交 | 内容 | 电话版改动 |
|---|---|---|
| `6061c29ba5` | accounts 实时事件后重拉 TX 的 To/From 选项 | `hooks/useMobileTransaction.js`：新增 `REALTIME_DOMAINS.ACCOUNTS` 订阅 + `accountsNonce`，**只重拉选项**（不重搜列表，与桌面同思路） |
| `6f1c39f5e7` | 提交后汇率被清空 | `AddTransactionSheet.jsx` 的 `resetForm` 不再清 `rateExchangeRateRaw`（sheet 由 `open` 控制、组件不卸载，状态会保留） |
| `b59f77174f` | contra 拒结用 `window.confirm` | `ContraInboxSheet.jsx` 改为应用内确认面板（复用现有类，不加 CSS）：点 Reject → 面板出来、列表收起 → 确认才 `onReject(id)`；两个 hook 都放在 `if (!open) return null` **之前**，避免 hooks 顺序错误；关闭 sheet 时清掉待确认状态 |

### 已核实但尚未修（1）——下一批

| 桌面提交 | 内容 | 为什么缓一步 |
|---|---|---|
| `5b0455a06e` | group tenant：currency order 缺 group 维度 + 空 group 启动早退 | 涉及 `transactionApi.js` 加 `group_id` 参数与缓存键改 `g:<id>`，影响面较大 |

> 原先与它同列、缓一步的 `19349a3611` / `276125d07f` 已于本轮修完（见下表）。

### 第二轮：dashboard 独立公司（本轮，两条连体）

| 桌面提交 | 内容 | 电话版改动 |
|---|---|---|
| `276125d07f` | 独立公司（不属任何 group）无 group 时 Company All 不可用 | `lib/dashboardScope.js` 新增 `independentCompaniesForPicker()`（镜像桌面 `resolveIndependentAllMergeCompanyList`：未分组、非组实体、非链接行，按 code 去重）；`lib/dashboardLoad.js` 合并范围由 `: resolveGroupAllCompanyList(companies, null)`（= 空集）改为 `: independentCompaniesForPicker(companies)`；`FilterSheet.jsx` + `FilterChips.jsx` 的 Company All pill 放开禁用（改为按有无独立公司判断） |
| `19349a3611` | 独立公司币种来源应对齐「单独选这家公司」的接口 | `lib/dashboardCurrencies.js` 新增 `fetchCompanyAccountCurrencyCodes()`（`get_scope_account_currencies_api?company_id=`），两处换用它：① 独立公司单公司范围 ② 独立公司 All（逐公司 account 码并集）；并且**币种集合与合并集合同源**（否则组内公司的币种会混进独立 All）；排序锚点同步改为独立集合首家 |
| `276125d07f` 附带 | 面包屑没有「无组 All」的样子 | `pages/dashboard/ScopeBreadcrumb.jsx` 加 `groupAllMode` 无 group 分支 → 只显示 "All"（原先会落到底部的 "Filter"）；`FilterChips.jsx` 的 `scopeShortLabel` 同修（不再拼出空组前缀 ` › All`） |

两处电话版有意偏离（理由留底）：

- **没拄桌面的「空列表也 commit」**（桌面用它清掉 Currency Setting 暖缓存留下的幻影 MYR pill）。电话版没有那种暖缓存（`dashboardCurrencies.js` 无 cacheRef），全局规则是空集合回退 `["MYR"]`（KPI/图表同步走 MYR），改成空列表反而多一个无 pill 的状态。
- **pill 多一道守卫**：电话版无 group 时 `companiesForPicker` 列的是**全部**公司（桌面只列独立公司），所以「有 ≥2 家公司」不等于「独立 All 有内容」，若一个独立公司都没有则合并集合为空 → 加载报错。因此无 group 分支额外要求 `independentCompaniesForPicker(dash.companies).length > 0`。

验证（dev harness，真模块 + stub fetch 记录请求）：

- 合并范围：Company All 无 group → 只查 2 家独立公司（组内公司不进来，`capital` = 两家之和）；组内 All 仍只查该组；单公司（独立/组内）分支各自不变。
- 币种：独立 All → 只调 account 接口（无 Currency Setting 请求、无 `JPY` 残留）；独立单公司 → account 接口；组内单公司 → 仍带 `subsidiary_accounts_only=1&view_group=AP`；组内 All → 仍走 Currency Setting。
- UI：有独立公司时 All pill 可点且点后 draft 变 `groupAllMode:true / companyId:null`；只有组内公司时仍禁用；面包屑无 group 显示 "All"。
- 未验证：真机/真库上的数字（合并后的 KPI）——需要独立公司账号登录才能看到，未做。
| `5b0455a06e` | group tenant：currency order 缺 group 维度 + 空 group 启动早退 | 涉及 `transactionApi.js` 加 `group_id` 参数与缓存键改 `g:<id>`，影响面较大 |

### 已核实为「不适用 / 已对齐」的典型例子

- `ba8d61e3ec` / `88c83b283d`（Rate-Mul 负数规则）：该规则后来又被 `0dbecde1ca` 改过；用 `diff` 比对 `transactionSubmitHelpers.js` 两边**除 import 行外逐字节相同** → 已对齐。
- `29dc57b5bb`（payment history 按 DMY 分月）：`lib/transactionHistoryProgressive.js` 两边 diff 为空 → 已对齐。
- `d235813173`（aктивe/inactive 状态过滤）：改动主体在后端 `api/accounts/accountlistapi.php`（两端共用）；电话版账号页只有一个 Show Inactive 开关，其请求与新后端语义一致 → 无需同步（电话版没有「Active + Inactive 并列」的开关）。
- `156f3e80cf` / `ab5b7684b8` 等：改动在后端 / 部署配置，两端共用，天然对齐。

### 未逐条核的部分（诚实声明）

69 条里剩下的 ~38 条尚未逐条核实（大部分看名字仍是 dashboard 面板绘制/动画/实时总线内部实现，已被归为不适用，但没有逐条验证）。如需继续，按同样流程分批（每批 ~30 条）推进。

---

## 8. 踩坑

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
