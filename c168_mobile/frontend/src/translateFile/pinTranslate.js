/**
 * PIN 解锁的全部文案（锁屏 / 键盘 / 设置 / 开启引导共用一份）。
 *
 * 为何单独一个文件而不是塞进 authTranslate / moreTranslate：
 * 同一句话在**三个地方**出现（锁屏说「用 PIN 解锁」、设置说「PIN 解锁」、
 * 引导说「设置 PIN」），散在两份字典里必然出现一处改了一处没改。
 *
 * 与全站一致：只有 zh / en，读不到就退回 en。
 */

export const PIN_I18N = {
  en: {
    // ── 锁屏 ────────────────────────────────────────────────
    pinTitle: "PIN Unlock",
    pinHint: "Enter your {len}-digit PIN to unlock EazyCount",
    pinBusy: "Unlocking…",
    usePin: "Use PIN",
    useBiometric: "Use fingerprint or face",
    backToLogin: "Back to login",
    usePassword: "Use password",
    /** 错码：给出**还能试几次**，否则用户不知道自己离被清还有多远 */
    pinWrong: "Wrong PIN. {left} attempt(s) left.",
    pinWrongLast: "Wrong PIN. This is your last attempt — after that PIN unlock turns off.",
    pinLockedOut:
      "Too many wrong PINs. PIN unlock has been turned off — please sign in with your password.",
    pinNoPin: "PIN unlock is not set up on this device. Please sign in with your password.",
    pinCorrupt:
      "The PIN saved on this device is damaged. Please sign in with your password and set it up again.",
    pinExpired:
      "This device is no longer signed in. Please sign in with your password and set up the PIN again.",

    // ── 键盘 ────────────────────────────────────────────────
    keyDelete: "Delete",
    keyAria: "PIN digit {digit}",

    // ── 设置 / 引导（同一个键盘组件）─────────────────────────
    setupTitle: "Set up PIN unlock",
    setupBody:
      "Choose 4 or 6 digits. You will use this PIN to unlock EazyCount on this device — for example when a fingerprint is not recognised.",
    setupBodyNoBiometric:
      "This phone has no fingerprint or face set up for apps. A PIN still lets you open EazyCount without typing your full password.",
    setupLength: "PIN length",
    len4: "4 digits",
    len6: "6 digits",
    setupEnter: "Enter your new PIN",
    setupConfirm: "Enter it again to confirm",
    setupMismatch: "The two PINs do not match. Please start again.",
    setupTooSimple: "That PIN is too easy to guess. Please choose another one.",
    setupBadFormat: "Use digits only.",
    setupSaveFailed: "Could not save the PIN. Please check your connection and try again.",
    setupDeviceLimit: "Could not set up the PIN. Please try again.",
    setupNoCrypto: "This device cannot store a PIN safely, so PIN unlock is unavailable.",
    setupSaved: "PIN unlock is on.",
    cancel: "Cancel",
    retry: "Try again",

    // ── 设置页那一行 ────────────────────────────────────────
    settingLabel: "PIN Unlock",
    settingChange: "Change",
    /** 只写“开着的 PIN 是几位”——产品要求不写多余说明，这一句是必要信息 */
    settingHint4: "On · 4 digits",
    settingHint6: "On · 6 digits",
    changeTitle: "Change PIN",
    /** 开启生物识别时 PIN 被自动关掉：不是报错，是必须说清楚的取舍 */
    clearedByBiometric:
      "Biometric unlock is on, so PIN unlock was turned off — this device can only hold one credential. Set the PIN up again if you still want it.",
  },

  zh: {
    // ── 锁屏 ────────────────────────────────────────────────
    pinTitle: "PIN 解锁",
    pinHint: "输入 {len} 位 PIN 解锁 EazyCount",
    pinBusy: "正在解锁…",
    usePin: "用 PIN 解锁",
    useBiometric: "用指纹 / 人脸解锁",
    backToLogin: "返回登录",
    usePassword: "用密码登录",
    pinWrong: "PIN 不对，还可以试 {left} 次。",
    pinWrongLast: "PIN 不对。这是最后一次机会，再错就关闭 PIN 解锁。",
    pinLockedOut: "PIN 连错太多次，已关闭 PIN 解锁。请用密码登录。",
    pinNoPin: "这台设备还没有设置 PIN，请用密码登录。",
    pinCorrupt: "本机保存的 PIN 已损坏。请用密码登录，然后重新设置。",
    pinExpired: "此设备已失效。请用密码登录，然后重新设置 PIN。",

    // ── 键盘 ────────────────────────────────────────────────
    keyDelete: "删除",
    keyAria: "PIN 第 {digit} 位",

    // ── 设置 / 引导 ─────────────────────────────────────────
    setupTitle: "设置 PIN 解锁",
    setupBody:
      "选 4 位或 6 位数字。以后用这个 PIN 就能在本机解锁 EazyCount —— 比如指纹没认出来的时候。",
    setupBodyNoBiometric:
      "这台手机里没有可供 App 使用的指纹或人脸。设一个 PIN，同样不用每次输完整密码就能进入。",
    setupLength: "PIN 位数",
    len4: "4 位",
    len6: "6 位",
    setupEnter: "输入新的 PIN",
    setupConfirm: "再输入一次确认",
    setupMismatch: "两次输入不一致，请重新设置。",
    setupTooSimple: "这个 PIN 太容易被猜到，请换一个。",
    setupBadFormat: "只能输入数字。",
    setupSaveFailed: "保存 PIN 失败，请检查网络后重试。",
    setupDeviceLimit: "设置 PIN 失败，请重试。",
    setupNoCrypto: "这台设备无法安全保存 PIN，暂时不能用 PIN 解锁。",
    setupSaved: "PIN 解锁已开启。",
    cancel: "取消",
    retry: "重试",

    // ── 设置页那一行 ────────────────────────────────────────
    settingLabel: "PIN 解锁",
    settingChange: "修改",
    settingHint4: "已开启 · 4 位",
    settingHint6: "已开启 · 6 位",
    changeTitle: "修改 PIN",
    clearedByBiometric:
      "已开启生物识别解锁，PIN 解锁已关闭 —— 同一台设备只能留一把凭据。仍想用 PIN 请重新设置。",
  },
};

export function pinText(lang) {
  return PIN_I18N[lang] || PIN_I18N.en;
}

/** 极简占位替换：{len} / {left} / {digit} */
export function pinFormat(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (whole, key) =>
    vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
  );
}
