# 手机版：安卓输入法相关的「丢字 / 删除延迟」通案

> 状态：登录页 + 全站搜索框已修（2026-10-12）；本文记录**这一类**问题的机制与约束，避免再犯。
> 关联：`components/KeyboardOwnedInput.jsx`、`dev-harness/login-loop.mjs`、`dev-harness/picker-loop.mjs`。

## 1. 现象（都是同一类）

- 登录页：打了字**字消失/跳**；用英文键盘敲完再按删除**「延迟一下」**
- 搜索框：输入后**搜不到**，要**删掉一个字**才出现；列表显示的匹配和输入框里的字**不是同一个查询**
- 报告过的设备：**旧安卓机 + 搜狗输入法**为主（也有 Gboard）

## 2. 两个机制（都要堵）

### 2.1 受控输入被 React 回写 → 字被吃掉

`<input value={x} onChange={...}>`：安卓输入法是**自己把字写进 DOM** 的，React 看不见；
下一次渲染（任何 state 变化：列表窗口增长、父组件刷新）React 就把自己手里的**旧值写回** →
刚打的字消失、列表按旧查询过滤，**只有删一个字**（产生一个 React 看得见的事件）才重新对齐。

### 2.2 每键重渲染把输入法拖住 → 删除"延迟"

搜狗会**长期持有一个组合（composition）**：中文输入法里敲英文字母先进候选/下划线状态，
**第一次按删除删的是输入法缓冲里的那一位**（看起来像"没反应"）。
如果这时候我们还**每次组合更新都重渲染列表**，旧机上就是输入法在等我们 → 明显卡顿。

## 3. 解法：一个共享组件

`src/components/KeyboardOwnedInput.jsx`

| 做法 | 原因 |
|---|---|
| **不受控**（`defaultValue`，绝不写 `value=`） | React 永不回写键盘拥有的文字（堵 2.1） |
| **原生 `input` / `compositionend` 监听** | React 会去重它"已见过"的 `input` 事件，原生监听一定收到 |
| `value` 只在**外部刻意变更**时采纳（预填 / blur 归一化 / 程序化清空） | 普通渲染一律不写，堵 2.1 又不丢功能 |
| `composeThrottleMs`（搜索框用 80ms）：组合期间合并更新 + **尾随补发** | 堵 2.2；尾随补发保证"用户停手、组合没 commit"时列表仍会追上，不会回到"搜不到" |
| 更新走 `startTransition`（仅 `composeThrottleMs > 0` 时） | 列表渲染变低优先级，React 可以先处理按键/删除 |
| ✕ 由组件自己渲染并自己清 DOM | 文字状态不会和 DOM 脱节 |

## 4. 铺开范围（2026-10-12）

登录页（公司ID/用户名经 `useUppercaseField`、密码经 `PasswordInput`，后者覆盖**二级密码页**与账号/Admin/域名表单共 8 处调用点）；
`MobileSubpageHeader`（两个报告页）、`MaintenanceSearchBar`、AccountPage、AutoRenewPage、DomainPage、
`AdminUserSheets` ×2、`AccountSheets`、交易页 AccountPicker。

## 5. 硬约束（别踩）

1. **不要在 `onChange` 里改写值**（转大写、去符号、格式化）——那就是 2.1 的变体。
   要归一化就**归一化 state / 提交值**，不要动 DOM：见 `DomainPage` 的 `forceSearchValue`。
2. **表单字段不要开 `composeThrottleMs`**：提交要读 state，节流会让它慢一拍（登录页/密码框=0）。
3. 搜索框的列表必须继续**窗口化**（`OPTION_WINDOW_STEP`）：一次挂几千行会让删除卡几秒（已修）。
4. **登录页打字时不得重渲染**：公司ID/用户名/密码都存在 ref（`useUppercaseField` / `passwordRef`），
   `onSubmit` 读 `ref.current`；state 只在 blur 时追上（顺便做大写归一化）。
   理由：每键重渲染整个登录页，在旧机上就是输入法要等的那段时间。
   改这里必须跑 `login-loop.mjs` 的「submitted body carries exactly what was typed」——
   它截获登录请求体，证明**最后一个没 blur 的字段**也一字不差地进了请求。
5. **别在登录页加无限动画**：光晕曾动画 `filter: blur()`、激活文字曾动画 `text-shadow`、扫光曾用
   `mix-blend-mode`，都是每帧重绘。`body.is-typing`（输入框有焦点时）会把它们全部停掉，
   但新加的动画也要遵守这个约定。

## 6. 验证（无需后端）

```bash
cd c168_mobile/frontend
npm run dev -- --port 5174 --strictPort
node dev-harness/login-loop.mjs --throttle=20   # 8 项：字存活 / 眼睛开关 / type=password / 逐次删除延迟 / 构建标记 / 提交体
npm run dev -- --port 5200 --strictPort   # 另开一个 shell
node dev-harness/picker-loop.mjs --n=2000 --throttle=6   # 13 项：含组合突发与 z-index 劫持
node dev-harness/search-sweep.mjs    # 其它页面接线（无后端时会如实标 skipped）
```

`login-loop` 还会报**逐次删除延迟**（按键 → 输入框内容变化）与「关掉全部动画」的对照；
在模拟 x30 的 CPU 上，攻击线从 304ms → 103ms（逐层修复后）。改前对照：stash 掉源码改动再跑，
会看到三个字段 `afterRerender` 全变空、删除延迟 300ms 级。

## 7. 构建标记 + 真机打字体检（判定用户是否拿到新代码 / 量化他的实际卡顿）

登录页角落一行 9px 灰字：`build <git sha>[+] · MM-DD HH:mm`（由 `vite.config.js` 构建时注入）。

- **手机版是远程 SPA**：不整体重载就一直是内存里那份旧 JS（APK 只是 resume 更明显）→
  「修了没改善」很多时候是「还是旧 bundle」
- `+` 表示构建时工作区还有未提交改动（本仓库 dist 与源码同批提交，属常态）
- **点这行字** → 展开本机体检（`lib/typingProbe.js`）：
  WebView/Chrome 版本、Android 版本、核心数、本次会话的按键数、**每次按键的绘制延迟
  （avg / p90 / max）**、主线程阻塞总时长。空闲零开销，只在有输入框获得焦时录制。
- 让报障用户**截图这一块**发给客服 —— 这是唯一能反映“他那台旧机 + 搜狗”真实负担的数据。

怎么读这份数据：

| 现象 | 结论 |
|---|---|
| `paint latency avg` 正常（< 50ms）但用户仍说卡 | 延迟在输入法/系统层（搜狗自己的进程、WebView 编辑层），不在我们页面 |
| `max`/`p90` 很高（> 150ms）、`main-thread blocks` 很大 | 页面主线程仍被占（或设备确实极慢），需按这条轨迹继续挖 |
| `webview` 版本很旧（如 Chrome/7x 以下） | 先让用户更新 **Android System WebView** / Chrome（APK 的渲染引擎就是这个） |

## 8. 现场排查顺序

1. 让用户**换输入法**（Gboard/系统）做同样操作 → 立刻不卡 = 主因在输入法+旧机
2. 让用户**杀掉 App 重开**再试（确保拿到新 bundle），**点开 build 标记截图体检数据**
3. 让用户在 **Chrome 里打开同一个站点**做同样操作（同一个 Blink/WebView 引擎）→
   Chrome 顺、APK 卡 = 壳层（WebView 版本 / `captureInput` / 键盘模式）；两边都卡 = 设备+输入法
4. 记录：机型 / 安卓版本 / 输入法名+版本 / 哪个字段 / APK 还是浏览器 / 是否只在弱网、低电量、后台多时出现
