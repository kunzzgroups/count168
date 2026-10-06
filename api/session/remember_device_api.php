<?php
/**
 * 「保持登录」（本设备 30 天免密）的开关。
 *
 * 为什么需要它：iOS 的「添加到主屏幕」独立 App 里**没有 WebAuthn**，
 * 所以那个环境永远做不了 Face ID。但用户真正想要的结果是「不必再输密码」，
 * 而这个用免登录凭据就能做到 —— 于是那个环境下的开关就落到这里。
 *
 * 复用的是已经过测试的 device_token_web_remember_issue()：
 * 它按 $_POST['remember_me'] 决定签发还是吐销，并负责写/清 cookie。
 * 这里只是把它包装成一个显式的 enabled 参数。
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
function remember_device_fail(string $code, string $message): void
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
    require_once __DIR__ . '/../../includes/device_token.php';
    require_once __DIR__ . '/../../includes/auth_invalidation.php';
} catch (Throwable $e) {
    error_log('remember_device_api bootstrap failed: ' . $e->getMessage());
    remember_device_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    remember_device_fail('SERVER_ERROR', 'Database connection failed');
}

$userId = (int) ($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    remember_device_fail('NOT_LOGGED_IN', 'Not logged in');
}

$userType = device_token_normalize_user_type((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')) !== 'POST') {
    // GET = 查当前状态（设置页首次渲染时用）
    $expires = remember_device_expires_at($pdo, $userType, $userId);
    if (ob_get_level() > 0) {
        ob_clean();
    }
    echo json_encode([
        'success'    => true,
        'enabled'    => $expires !== null,
        'expires_at' => $expires,
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$enabled = trim((string) ($_POST['enabled'] ?? ''));
if ($enabled !== '0' && $enabled !== '1') {
    remember_device_fail('BAD_REQUEST', 'enabled=0 or enabled=1 required');
}

// 复用已测过的签发/吐销逻辑：它读 $_POST['remember_me']
$_POST['remember_me'] = $enabled === '1' ? '1' : '';
device_token_web_remember_issue($pdo, $userType, $userId);

// 回读真实状态（写 cookie 后当前请求的 $_COOKIE 不会更新，
// 所以开启时直接按刚签发的到期时间回报，关闭时明确为 null）
$expiresAt = $enabled === '1'
    ? date('Y-m-d H:i:s', time() + DEVICE_TOKEN_WEB_TTL_DAYS * 86400)
    : null;

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'success'    => true,
    'enabled'    => $enabled === '1',
    'expires_at' => $expiresAt,
], JSON_UNESCAPED_UNICODE);
