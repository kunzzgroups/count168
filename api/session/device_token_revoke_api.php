<?php
/**
 * 吊销设备令牌。
 *
 * 三种用法：
 *   - device_id=<id>  吊销指定设备（「我的登录设备」页下线别的设备）
 *   - 本机 = 调用方自己传自己的 device_id
 *   - all=1           吊销该账号全部设备（关闭指纹解锁 / 退出登录）
 *
 * 只做软吊销（写 revoked_at），保留历史供「我的登录设备」页展示。
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
function device_revoke_fail(string $code, string $message): void
{
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(['status' => 'error', 'code' => $code, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

$pdo = null;
try {
    require_once __DIR__ . '/../../includes/config.php';
    require_once __DIR__ . '/../../includes/device_token.php';
} catch (Throwable $e) {
    error_log('device_token_revoke_api bootstrap failed: ' . $e->getMessage());
    device_revoke_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    device_revoke_fail('SERVER_ERROR', 'Database connection failed');
}

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')) !== 'POST') {
    device_revoke_fail('BAD_REQUEST', 'POST required');
}

$userId = (int) ($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    device_revoke_fail('NOT_LOGGED_IN', 'Not logged in');
}

$userType = device_token_normalize_user_type((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}

$all = trim((string) ($_POST['all'] ?? '')) === '1';
$deviceId = trim((string) ($_POST['device_id'] ?? ''));

if (!$all && $deviceId === '') {
    device_revoke_fail('BAD_REQUEST', 'device_id or all=1 required');
}

device_token_ensure_table($pdo);

$affected = device_token_revoke($pdo, $userType, $userId, $all ? null : $deviceId);

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'status'   => 'success',
    'revoked'  => $affected,
    'scope'    => $all ? 'all' : 'device',
], JSON_UNESCAPED_UNICODE);
