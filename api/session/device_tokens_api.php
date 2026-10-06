<?php
/**
 * 列出本账号已授权的登录设备（「我的登录设备」页）。
 *
 * 多设备是确认需求，所以这是 P0：设备数达上限时用户必须能自查并下线，
 * 否则没有任何自助手段。
 *
 * 可选入参 device_id：用于标记哪一台是当前设备，前端可加「本机」标签。
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

$pdo = null;
try {
    require_once __DIR__ . '/../../includes/config.php';
    require_once __DIR__ . '/../../includes/device_token.php';
} catch (Throwable $e) {
    error_log('device_tokens_api bootstrap failed: ' . $e->getMessage());
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(['status' => 'error', 'code' => 'SERVER_ERROR', 'message' => 'Database connection failed'], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(['status' => 'error', 'code' => 'SERVER_ERROR', 'message' => 'Database connection failed'], JSON_UNESCAPED_UNICODE);
    exit;
}

$userId = (int) ($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(['status' => 'error', 'code' => 'NOT_LOGGED_IN', 'message' => 'Not logged in'], JSON_UNESCAPED_UNICODE);
    exit;
}

$userType = device_token_normalize_user_type((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}

$currentDeviceId = trim((string) ($_GET['device_id'] ?? ''));

device_token_ensure_table($pdo);

$devices = [];
foreach (device_token_list($pdo, $userType, $userId) as $row) {
    $isActive = (int) ($row['is_active'] ?? 0) === 1;
    $devices[] = [
        'device_id'    => (string) $row['device_id'],
        'device_name'  => (string) ($row['device_name'] ?? ''),
        'is_active'    => $isActive,
        'is_current'   => $currentDeviceId !== '' && hash_equals((string) $row['device_id'], $currentDeviceId),
        'created_at'   => (string) ($row['created_at'] ?? ''),
        'expires_at'   => (string) ($row['expires_at'] ?? ''),
        'last_used_at' => (string) ($row['last_used_at'] ?? ''),
        'revoked_at'   => (string) ($row['revoked_at'] ?? ''),
    ];
}

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'status'    => 'success',
    'max'       => DEVICE_TOKEN_MAX_DEVICES,
    'active'    => device_token_count_active($pdo, $userType, $userId),
    'devices'   => $devices,
], JSON_UNESCAPED_UNICODE);
