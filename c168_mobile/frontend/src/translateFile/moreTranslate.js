import { DASHBOARD_I18N } from "./dashboardTranslate.js";

export const MORE_I18N = {
  en: {
    ...DASHBOARD_I18N.en,
    biometric: "Biometric Unlock",
    bioOn: "On",
    bioOff: "Off",
    bioUnsupported: "Not supported here",
    bioUnsupportedNativeHint:
      "No fingerprint or face is available on this device. Enrol biometrics in your phone settings first.",
    bioUnsupportedStandaloneHint:
      "You opened this from a home-screen app. iOS does not support passkeys there — please open this page in Safari.",
    bioUnsupportedWebHint:
      "This browser cannot use passkey sign-in. On iPhone this needs Safari 16 or newer.",
    bioEnabledHint: "Signs you in with Face ID or your fingerprint",
    bioDisabledHint:
      "Turn on to sign in with Face ID or your fingerprint instead of typing the password.",
    bioEnableFailed: "Could not enable biometric unlock.",
    bioDeviceLimit: "Could not enable biometric unlock. Please try again.",
    // resolver 给出的“当前为什么用不了”—— 必须是用户能行动的一句话
    bioReasonNotEnrolled:
      "No fingerprint or face is set up for apps on this phone. Add one in your phone's settings first.",
    bioReasonLocked: "Biometrics are temporarily locked after too many attempts. Try again shortly.",
    bioReasonFingerprintGone:
      "Fingerprint is no longer set up on this phone. Choose face instead, or add a fingerprint back.",
    bioReasonFaceGone:
      "Face is no longer available on this phone. Choose fingerprint instead, or set face up again.",
    bioPasskeys: "Passkeys",
    // 安卓专用：让用户选指纹还是人脸（见 lib/biometricSettings.js 的 readBiometricSettings）
    //
    // 标签必须诚实：选人脸时安卓仍可能弹指纹（平台无「只用人脸」开关），
    // 写成单纯的 “Face” 就是承诺了做不到的事。
    bioModalityFingerprint: "Fingerprint",
    bioModalityFace: "Face or fingerprint",
    bioModality: "Unlock with",
    rememberDevice: "Stay signed in",
    rememberDeviceOnHint: "This device stays signed in for 30 days",
    rememberDeviceExpires: "until",
    rememberDeviceOffHint:
      "Turn on to stay signed in on this device for 30 days — no password to type.",
    bioSafariHint: "To use Face ID on iPhone, open this page in Safari:",
    bioOpenInSafari: "Open in Safari",
    more: "More",
    moreSubtitle: "Tools and settings",
    report: "Report",
    reportDescription: "View financial and operational reports.",
    userManagement: "Admin",
    userManagementDescription: "Manage users, roles and permissions.",
    domain: "Domain",
    domainDescription: "C168 domain list, fees and renewals.",
    announcement: "Announcement",
    announcementDescription: "Create, edit and delete announcements.",
    autoRenew: "Auto Renew",
    autoRenewDescription: "Approve company and group renewals.",
    ownership: "Ownership",
    ownershipDescription: "Set company and group ownership percentages.",
    settings: "Settings",
    settingsDescription: "Profile, language, appearance and logout.",
    appearance: "Appearance",
    themeLight: "Light",
    themeDark: "Dark",
    back: "Back",
    noTools: "No additional tools are available for your account.",
    open: "Open",
  },
  zh: {
    ...DASHBOARD_I18N.zh,
    biometric: "生物识别解锁",
    bioOn: "已开启",
    bioOff: "已关闭",
    bioUnsupported: "此环境不支持",
    bioUnsupportedNativeHint:
      "这台设备没有可用的指纹 / 人脸。安卓 App 需要先在系统里录入生物识别。",
    bioUnsupportedStandaloneHint:
      "你是从「添加到主屏幕」打开的吧？iOS 的独立 App 里不支持 passkey，请用 Safari 打开本页。",
    bioUnsupportedWebHint:
      "此浏览器不支持 passkey 登录。iPhone 需要 Safari 16 以上。",
    rememberDevice: "保持登录",
    rememberDeviceOnHint: "本设备 30 天内不必再输密码",
    rememberDeviceExpires: "至",
    rememberDeviceOffHint: "开启后本设备 30 天内不必再输密码。",
    bioSafariHint: "iPhone 上要用 Face ID，请改用 Safari 打开本页：",
    // 安卓专用：让用户选指纹还是人脸。
    // 标签必须诚实：选人脸时安卓仍可能弹指纹（平台无「只用人脸」开关）。
    bioModalityFingerprint: "指纹",
    bioModalityFace: "人脸或指纹",
    bioModality: "解锁方式",
    // resolver 给出的“当前为什么用不了”—— 必须是用户能行动的一句话
    bioReasonNotEnrolled:
      "这台手机里还没有可供 App 使用的指纹或人脸，请先在系统设置里添加一个。",
    bioReasonLocked: "系统已临时锁定生物识别（失败次数过多），请稍后再试。",
    bioReasonFingerprintGone: "这台手机已经没有指纹了。可以改用人脸，或重新录入指纹。",
    bioReasonFaceGone: "这台手机已经没有人脸识别了。可以改用指纹，或重新录入人脸。",
    bioOpenInSafari: "在 Safari 中打开",
    bioEnabledHint: "用指纹 / 人脸直接登录",
    bioDisabledHint: "开启后用指纹 / 人脸登录，不必再输密码。",
    bioEnableFailed: "开启生物识别解锁失败。",
    bioPasskeys: "已保存 passkey",
    bioDeviceLimit: "开启生物识别解锁失败，请重试。",
    more: "更多",
    moreSubtitle: "工具与设置",
    report: "报表",
    reportDescription: "查看财务与营运报表。",
    userManagement: "管理",
    userManagementDescription: "管理用户、角色与权限。",
    domain: "Domain",
    domainDescription: "C168 Domain 列表、费用与续期。",
    announcement: "公告",
    announcementDescription: "创建、编辑与删除公告。",
    autoRenew: "自动续费",
    autoRenewDescription: "审批公司与集团续费申请。",
    ownership: "Ownership",
    ownershipDescription: "设置公司与分组的归属比例。",
    settings: "设置",
    settingsDescription: "资料、语言、外观与退出登录。",
    appearance: "外观",
    themeLight: "浅色",
    themeDark: "深色",
    back: "返回",
    noTools: "你的账户暂无其他可用工具。",
    open: "打开",
  },
};
