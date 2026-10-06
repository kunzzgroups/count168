<?php
/**
 * Log out: clear remember-me, SPA session payload cache, and destroy PHP session.
 */
session_start();
header('Content-Type: application/json; charset=utf-8');

require_once __DIR__ . '/../../includes/config.php';
require_once __DIR__ . '/../../includes/session_user_payload_cache.php';

$userId = isset($_SESSION['user_id']) ? (int) $_SESSION['user_id'] : 0;

// 只在 user_type='user' 时清 user.remember_token。
// 旧代码不看 user_type 就直接 UPDATE user —— 但 owner / member 会话的 user_id 是
// owner / account 表的 id，会误清同号码的 staff 用户的记住我。
$sessionUserType = strtolower((string) ($_SESSION['user_type'] ?? ''));
if ($sessionUserType === '') {
    $sessionUserType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}

if ($userId > 0 && $pdo instanceof PDO && $sessionUserType === 'user') {
    try {
        $stmt = $pdo->prepare('UPDATE user SET remember_token = NULL, remember_token_expires = NULL WHERE id = ?');
        $stmt->execute([$userId]);
    } catch (Throwable $e) {
        error_log('logout_api token cleanup failed: ' . $e->getMessage());
    }
}

// 网页端记住我（device_token kind='web'）—— 只吐销**当前 cookie 对应的那一条**，
// 不让在一个浏览器登出把其它浏览器的记住我一起干掉。
if ($pdo instanceof PDO && isset($_COOKIE['remember_token'])) {
    try {
        require_once __DIR__ . '/../../includes/device_token.php';
        device_token_revoke_by_token(
            $pdo,
            (string) $_COOKIE['remember_token'],
            DEVICE_TOKEN_KIND_WEB
        );
    } catch (Throwable $e) {
        error_log('logout_api device token revoke failed: ' . $e->getMessage());
    }
}

session_user_payload_cache_clear();

$cookieParams = session_get_cookie_params();
$secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https');

if (session_status() === PHP_SESSION_ACTIVE) {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        setcookie(session_name(), '', [
            'expires' => time() - 42000,
            'path' => $cookieParams['path'] ?: '/',
            'domain' => $cookieParams['domain'] ?: '',
            'secure' => $secure,
            'httponly' => (bool) ($cookieParams['httponly'] ?? true),
            'samesite' => $cookieParams['samesite'] ?? 'Lax',
        ]);
    }
    session_destroy();
}

if (isset($_COOKIE['remember_token'])) {
    setcookie('remember_token', '', [
        'expires' => time() - 42000,
        'path' => '/',
        'domain' => $cookieParams['domain'] ?: '',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

echo json_encode([
    'success' => true,
    'message' => 'Logged out',
], JSON_UNESCAPED_UNICODE);
