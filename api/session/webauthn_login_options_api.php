<?php
/**
 * WebAuthn 登录 —— 第 1 步：下发 challenge。
 *
 * 这个端点**必须能在未登录时访问**（它本身就是登录入口）。
 *
 * 用「可发现凭据」（empty allowCredentials）：验证器自己挑一把已注册的 passkey，
 * 所以用户不需要先输账号。代价是理论上存在账号枚举面，但凭据 ID 不可猜测，
 * 且响应里不含任何用户信息，所以实际风险可忽略。
 */

$sessionTimeout = 3600;
session_set_cookie_params([
    'lifetime' => $sessionTimeout,
    'path' => '/',
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_start();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

ob_start();

/** @return never */
function wa_logopt_fail(string $code, string $message): void
{
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(['success' => false, 'code' => $code, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    require_once __DIR__ . '/../../includes/webauthn.php';
    wa_install_error_handler('webauthn_login_options');
} catch (Throwable $e) {
    error_log('webauthn_login_options bootstrap failed: ' . $e->getMessage());
    wa_logopt_fail('SERVER_ERROR', 'Server error');
}

if (!wa_rp_id_valid()) {
    wa_logopt_fail('BAD_RP', 'Cannot determine relying party id');
}

$challenge = wa_challenge_issue('login');

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'success'   => true,
    'challenge' => $challenge,
    'rpId'      => wa_rp_id(),
    'timeout'   => 60000,
    'userVerification' => 'required',
    // 空数组 = 让验证器自己挑凭据（可发现凭据），用户无需先输账号
    'allowCredentials' => [],
], JSON_UNESCAPED_UNICODE);
