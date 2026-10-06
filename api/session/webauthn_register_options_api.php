<?php
/**
 * WebAuthn 注册 —— 第 1 步：下发 challenge 与 rp 信息。
 *
 * 前置：必须已登录，且二级密码已通过（与设备令牌签发同一条门槛，
 * 否则用户可以在 /owner-secondary-password 页面就注册 passkey）。
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
function wa_regopt_fail(string $code, string $message): void
{
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(['success' => false, 'code' => $code, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

$pdo = null;
try {
    require_once __DIR__ . '/../../includes/config.php';
    require_once __DIR__ . '/../../includes/webauthn.php';
    require_once __DIR__ . '/../../includes/device_token.php';
    require_once __DIR__ . '/../../includes/auth_invalidation.php';
} catch (Throwable $e) {
    error_log('webauthn_register_options bootstrap failed: ' . $e->getMessage());
    wa_regopt_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    wa_regopt_fail('SERVER_ERROR', 'Database connection failed');
}

$userId = (int) ($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    wa_regopt_fail('NOT_LOGGED_IN', 'Not logged in');
}

$userType = device_token_normalize_user_type((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}

// 与 device_token_register_api.php 同一门槛：member 无二级密码概念，其余必须已通过
if ($userType !== 'member' && ($_SESSION['secondary_password_verified'] ?? null) !== true) {
    wa_regopt_fail('SECONDARY_PASSWORD_REQUIRED', 'Please verify your secondary password first.');
}

if (!wa_rp_id_valid()) {
    wa_regopt_fail('BAD_RP', 'Cannot determine relying party id');
}

wa_ensure_table($pdo);

$challenge = wa_challenge_issue('register');

$loginId = (string) ($_SESSION['login_id'] ?? '');
$name = (string) ($_SESSION['name'] ?? $loginId);

$exclude = [];
foreach (wa_credential_ids($pdo, $userType, $userId) as $cid) {
    $exclude[] = ['type' => 'public-key', 'id' => wa_b64url_encode((string) $cid)];
}

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'success'   => true,
    'challenge' => $challenge,
    'rp'        => ['id' => wa_rp_id(), 'name' => 'EazyCount'],
    'user'      => [
        // user.id 必须是稳定且不敏感的字节串
        'id'          => wa_b64url_encode(wa_user_handle($userType, $userId)),
        'name'        => $loginId !== '' ? $loginId : (string) $userId,
        'displayName' => $name !== '' ? $name : $loginId,
    ],
    // 只提供 ES256 —— 核心库也只接受它，不提供就不该声明支持
    'pubKeyCredParams' => [['type' => 'public-key', 'alg' => -7]],
    'timeout'     => 60000,
    // 不做 attestation 校验，所以必须明确要求 none，否则等于把未验证的声明当真
    'attestation' => 'none',
    'authenticatorSelection' => [
        'userVerification'  => 'required',
        'residentKey'       => 'preferred',
        // 故意不传 requireResidentKey（已弃用的遗留字段）。
        // 它和 residentKey 同时存在时，部分 Safari 版本会直接拒绝整个请求。
    ],
    'excludeCredentials' => $exclude,
], JSON_UNESCAPED_UNICODE);
