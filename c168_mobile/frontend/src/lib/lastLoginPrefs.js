/**
 * 记住上次成功登录用的公司 / 集团 ID，下次自动带入。
 *
 * 为什么需要这个：
 *   iOS 钥匙串（以及 Android 的密码管理器）的模型是
 *   「一个 origin + 一个 username + 一个 password」—— **只有两个槽位**。
 *   公司 ID 这种多出来的第三个字段，系统不会保存也不会自动填。
 *   结果是 iPhone 用户每次登录都要手输公司 ID，这是最烦的一步。
 *
 * 安全上没问题：公司 ID 不是机密 —— 它在界面上（设置/个人资料）到处都显示，
 * 也出现在 login_identifier 里。它不是密码，也不是二级密码。
 *
 * 只在**登录成功后**写入，避免把输错的值记下来。
 */

const COMPANY_KEY = "ec_last_login_company";

/** @returns {string} 已大写化的公司 ID，无记录或不可用时返回空串 */
export function readLastCompanyId() {
  try {
    return (localStorage.getItem(COMPANY_KEY) || "").toUpperCase();
  } catch {
    // 隐私模式下 localStorage 不可用
    return "";
  }
}

/** @param {string} companyId */
export function writeLastCompanyId(companyId) {
  const value = String(companyId || "").toUpperCase().trim();
  if (!value) return;
  try {
    localStorage.setItem(COMPANY_KEY, value);
  } catch {
    /* 写不进去就算了，不影响登录 */
  }
}

/**
 * 清除记住的公司 ID。
 *
 * 产品要求：**退出登录时清掉**。代价是下次登录要重新输公司 ID ——
 * 这是明确选择的结果（共用设备上不想让下一个人看到上一个账号的公司 ID）。
 */
export function clearLastCompanyId() {
  try {
    localStorage.removeItem(COMPANY_KEY);
  } catch {
    /* 忽略 */
  }
}
