<?php
/**
 * 已注册的 passkey：查询（GET）与移除（POST revoke_all=1）。
 *
 * 只提供**账号级**移除：passkey 通常只有一两把，逐条吊销的界面价值很低，
 * 而多一个"任意吊销单条"的入口就多一份越权面。要单独移除某台设备，
 * 用户在该设备上重新注册即可覆盖（uk_credential）。
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
function wa_creds_fail(string $code, string $message): void
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
    wa_install_error_handler('webauthn_credentials');
    require_once __DIR__ . '/../../includes/device_token.php';
} catch (Throwable $e) {
    error_log('webauthn_credentials bootstrap failed: ' . $e->getMessage());
    wa_creds_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    wa_creds_fail('SERVER_ERROR', 'Database connection failed');
}

$userId = (int) ($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    wa_creds_fail('NOT_LOGGED_IN', 'Not logged in');
}

$userType = device_token_normalize_user_type((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')) === 'POST') {
    if (trim((string) ($_POST['revoke_all'] ?? '')) !== '1') {
        wa_creds_fail('BAD_REQUEST', 'revoke_all=1 required');
    }
    // 与注册同门槛：二级密码必须先通过
    if ($userType !== 'member' && ($_SESSION['secondary_password_verified'] ?? null) !== true) {
        wa_creds_fail('SECONDARY_PASSWORD_REQUIRED', 'Please verify your secondary password first.');
    }
    wa_ensure_table($pdo);
    $removed = wa_credential_revoke_all($pdo, $userType, $userId);

    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode(['success' => true, 'removed' => $removed], JSON_UNESCAPED_UNICODE);
    exit;
}

wa_ensure_table($pdo);
$rows = wa_credential_list($pdo, $userType, $userId);
$active = 0;
$devices = [];
foreach ($rows as $row) {
    $isActive = (int) ($row['is_active'] ?? 0) === 1;
    if ($isActive) {
        $active++;
    }
    $devices[] = [
        'device_name'  => (string) ($row['device_name'] ?? ''),
        'is_active'    => $isActive,
        'created_at'   => (string) ($row['created_at'] ?? ''),
        'last_used_at' => (string) ($row['last_used_at'] ?? ''),
    ];
}

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'success' => true,
    'count'   => $active,
    'max'     => WA_MAX_CREDENTIALS,
    'devices' => $devices,
], JSON_UNESCAPED_UNICODE);
