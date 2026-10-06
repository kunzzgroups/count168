<?php
/**
 * 设备令牌换会话（移动端指纹解锁的核心端点）。
 *
 * 契约与 api/session/login_api.php 同构，前端可直接复用 resolvePostLoginPath()。
 * 与 login_api.php 的两点关键差异：
 *   1. 不设置 remember_token cookie —— 设备令牌与网页端免登录是两套并行机制，互不干扰。
 *   2. 不设置 $_SESSION['secondary_password_verified'] —— 指纹解锁后必须重新验二级密码。
 *
 * 失败路径不写库（见 includes/device_token.php 的 device_token_note_on_rate_limit 说明）。
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
function device_login_fail(string $code, string $message): void
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
    require_once __DIR__ . '/../../includes/company_expiration.php';
    require_once __DIR__ . '/../../includes/session_user_payload_cache.php';
    require_once __DIR__ . '/../../includes/group_tenant_v2.php';
} catch (Throwable $e) {
    error_log('device_login_api bootstrap failed: ' . $e->getMessage());
    device_login_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    device_login_fail('SERVER_ERROR', 'Database connection failed');
}

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')) !== 'POST') {
    device_login_fail('BAD_REQUEST', 'POST required');
}

$token = trim((string) ($_POST['token'] ?? ''));
$deviceId = trim((string) ($_POST['device_id'] ?? ''));

device_token_ensure_table($pdo);

$resolved = device_token_resolve($pdo, $token, $deviceId);
if (!$resolved['ok']) {
    $messages = [
        'TOKEN_INVALID' => 'This device is no longer signed in. Please login again.',
        'TOKEN_EXPIRED' => 'Device unlock has expired. Please login again.',
        'TOKEN_REVOKED' => 'Device unlock was turned off. Please login again.',
        'SERVER_ERROR'  => 'Server error',
    ];
    device_login_fail($resolved['code'], $messages[$resolved['code']] ?? 'Device unlock failed');
}

$row = $resolved['row'];
$userType = device_token_normalize_user_type((string) $row['user_type']);
$userId = (int) $row['user_id'];

if ($userType === '' || $userId <= 0) {
    device_login_fail('TOKEN_INVALID', 'This device is no longer signed in. Please login again.');
}

$snapshot = json_decode((string) ($row['session_snapshot'] ?? ''), true);
if (!is_array($snapshot)) {
    $snapshot = [];
}
if ((int) ($snapshot['user_id'] ?? 0) !== $userId) {
    device_login_fail('TOKEN_INVALID', 'Device credential is damaged. Please login again.');
}

// 1) 身份是否仍然有效
$principal = device_token_fetch_principal($pdo, $userType, $userId);
if ($principal === null || strtolower($principal['status']) !== 'active') {
    device_login_fail('USER_DISABLED', 'Account is not active. Please login again.');
}

// 2) 公司 / 组是否过期
if (device_token_company_expired($pdo, $snapshot)) {
    device_login_fail('COMPANY_EXPIRED', 'Company or Group has expired.');
}

// 3) 维护模式（语义对齐 login_api.php:77-84：member 一律拒绝，其他需在白名单）
if (maintenance_gate_is_enabled($pdo)) {
    if ($userType === 'member' || !maintenance_gate_is_active_user_login($pdo, $principal['login_id'])) {
        $payload = maintenance_gate_build_login_reject_payload($pdo);
        if (ob_get_level() > 0) {
            ob_clean();
        }
        echo json_encode([
            'status'  => 'error',
            'code'    => 'MAINTENANCE',
            'message' => (string) ($payload['message'] ?? 'System under maintenance'),
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }
}

// 4) 还原会话（内部会 unset secondary_password_verified）
device_token_restore_session($snapshot);

if ((int) ($_SESSION['user_id'] ?? 0) !== $userId) {
    device_login_fail('TOKEN_INVALID', 'Device credential is damaged. Please login again.');
}
if ((string) ($_SESSION['user_type'] ?? '') !== $userType) {
    device_login_fail('TOKEN_INVALID', 'Device credential is damaged. Please login again.');
}

session_user_payload_cache_clear();

// 5) 二级密码（owner 一律需要；C168 的 user 且已设二级密码则需要）
$redirect = device_token_secondary_password_redirect($pdo, $userType, $userId, $snapshot);

// 受信任凭据放行二级密码。这一行是**唯一**让 owner 跳过
// /owner-secondary-password 的地方，故意写在这里以便审计。
// 策略与理由见 includes/device_token.php 的 DEVICE_TOKEN_TRUSTED_SKIPS_SECONDARY。
if ($redirect !== null && DEVICE_TOKEN_TRUSTED_SKIPS_SECONDARY) {
    $_SESSION['secondary_password_verified'] = true;
    $redirect = null;
}

if ($redirect === null) {
    $redirect = $userType === 'member' ? '/member' : '/dashboard';
}

// 6) 记录一次成功使用
device_token_touch($pdo, (int) $row['id']);

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'status'           => 'success',
    'redirect'         => $redirect,
    'user_type'        => $userType,
    'company_id'       => (int) ($_SESSION['company_id'] ?? 0) ?: null,
    'login_scope'      => (string) ($_SESSION['login_scope'] ?? 'company'),
    'login_identifier' => (string) ($_SESSION['login_identifier'] ?? ($_SESSION['company_code'] ?? '')),
], JSON_UNESCAPED_UNICODE);
