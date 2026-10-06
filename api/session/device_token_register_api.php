<?php
/**
 * 签发设备令牌（用户开启「指纹解锁」时调用）。
 *
 * 前置条件（缺一不可）：
 *   1. 已有有效登录会话
 *   2. 二级密码已通过 —— 否则用户可以在 /owner-secondary-password 页面上就开启指纹，
 *      等于绕过二级密码。详见下方 secondary_password_verified 检查。
 *
 * 明文令牌**只在本响应里出现一次**，服务端仅存 sha256；客户端须交给
 * Android Keystore（原生插件 setCredentials），严禁进 localStorage。
 */

$sessionTimeout = 3600;
$cookieOptions = [
    'lifetime' => $sessionTimeout,
    'path' => '/',
    'httponly' => true,
    'samesite' => 'Lax',
];

ini_set('session.gc_maxlifetime', (string) $sessionTimeout);
session_set_cookie_params($cookieOptions);
session_start();

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

ob_start();

/** @return never */
function device_register_fail(string $code, string $message): void
{
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(
        ['status' => 'error', 'code' => $code, 'message' => $message],
        JSON_UNESCAPED_UNICODE
    );
    exit;
}

$pdo = null;
try {
    require_once __DIR__ . '/../../includes/config.php';
    require_once __DIR__ . '/../../includes/device_token.php';
    require_once __DIR__ . '/../../includes/auth_invalidation.php';
    require_once __DIR__ . '/../../includes/maintenance_gate.php';
    require_once __DIR__ . '/../../includes/session_user_payload_cache.php';
} catch (Throwable $e) {
    error_log('device_token_register_api bootstrap failed: ' . $e->getMessage());
    device_register_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    device_register_fail('SERVER_ERROR', 'Database connection failed');
}

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')) !== 'POST') {
    device_register_fail('BAD_REQUEST', 'POST required');
}

$userId = (int) ($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    device_register_fail('NOT_LOGGED_IN', 'Not logged in');
}

// 与 current_user_api.php:102 同款兜底：老会话可能没有 user_type
$userType = device_token_normalize_user_type((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}

// 改过密码的会话先踢掉，避免用旧会话换出新令牌
if (auth_session_password_stale($pdo)) {
    auth_force_logout_session($pdo, true);
    device_register_fail('SESSION_STALE', 'Password was changed. Please login again.');
}

// 二级密码门槛：member 无此概念；其余看**是否真的需要**。
// 不能直接看标记是否置位 —— 非 C168 的用户本来就不需要二级密码，
// 会话被恢复后标记为空是正常的，不应拦住他。
if ($userType !== 'member'
    && device_token_secondary_password_pending($pdo, $userType, $userId, $_SESSION)) {
    device_register_fail('SECONDARY_PASSWORD_REQUIRED', 'Please verify your secondary password first.');
}

$deviceId = trim((string) ($_POST['device_id'] ?? ''));
$deviceName = trim((string) ($_POST['device_name'] ?? ''));

if (!device_token_is_valid_device_id($deviceId)) {
    device_register_fail('BAD_DEVICE_ID', 'Invalid device id');
}

device_token_ensure_table($pdo);

$issued = device_token_issue(
    $pdo,
    $userType,
    $userId,
    $deviceId,
    $deviceName,
    device_token_capture_session()
);

if (!$issued['ok']) {
    if ($issued['code'] === 'DEVICE_LIMIT') {
        device_register_fail(
            'DEVICE_LIMIT',
            'Too many devices. Please remove one under Login devices first.'
        );
    }
    device_register_fail($issued['code'], 'Could not enable fingerprint unlock.');
}
if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'status'     => 'success',
    'token'      => $issued['token'],
    'expires_at' => $issued['expires_at'],
    'user_type'  => $userType,
], JSON_UNESCAPED_UNICODE);
