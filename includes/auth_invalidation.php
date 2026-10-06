<?php
/**
 * Password-change auth invalidation: remember-me tokens and session password fingerprints.
 */

function auth_password_fingerprint(string $storedPassword): string
{
    return substr((string) $storedPassword, 0, 32);
}

function auth_store_password_fingerprint(string $storedPassword): void
{
    if ($storedPassword === '') {
        return;
    }
    $_SESSION['password_fingerprint'] = auth_password_fingerprint($storedPassword);
}

function invalidate_user_remember_token(PDO $pdo, int $userId): void
{
    if ($userId <= 0) {
        return;
    }
    try {
        $stmt = $pdo->prepare(
            'UPDATE user SET remember_token = NULL, remember_token_expires = NULL WHERE id = ?'
        );
        $stmt->execute([$userId]);
    } catch (Throwable $e) {
        error_log('invalidate_user_remember_token failed: ' . $e->getMessage());
    }
}

function auth_cookie_secure_flag(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['HTTP_X_FORWARDED_PROTO'])
            && strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https');
}

/**
 * 改密码后吐销该账号**全部**设备令牌（移动端指纹解锁）。
 *
 * 与 invalidate_user_remember_token() 并列，但覆盖面不同：
 * remember_token 只存在于 user 表，而 device_token 覆盖 owner / user / member
 * 三种身份 —— 只调 remember 那个会漏掉 owner 和 member 的指纹解锁。
 *
 * @param string $userType 'owner' | 'user' | 'member'
 */
function invalidate_device_tokens(PDO $pdo, string $userType, int $userId): void
{
    $userId = (int) $userId;
    if ($userId <= 0) {
        return;
    }

    $userType = strtolower(trim($userType));
    if (!in_array($userType, ['owner', 'user', 'member'], true)) {
        return;
    }

    try {
        // 懒加载：绝大多数请求不需要设备令牌功能，不拉进主链路
        require_once __DIR__ . '/device_token.php';
        device_token_revoke($pdo, $userType, $userId, null);
    } catch (Throwable $e) {
        error_log('invalidate_device_tokens failed: ' . $e->getMessage());
    }
}

/**
 * 写 remember_token cookie（免登录）。
 *
 * 为什么必须集中在这一处：原先 api/session/login_api.php 有 3 处内联 setcookie，
 * 参数是 (..., "/", "", false, true) —— 第 6 个参数就是 Secure，三处全传了 false。
 * 结果：HTTPS 站点上的免登录 cookie 会被任何 http:// 请求明文带走。
 *
 * Secure 用 auth_cookie_secure_flag() 动态判断，因此本地 http 开发仍可写入，
 * 生产 HTTPS 上自动带上 Secure。
 */
function auth_set_remember_token_cookie(string $token, int $ttlSeconds = 2592000): void
{
    $cookieParams = session_get_cookie_params();

    setcookie('remember_token', $token, [
        'expires' => time() + $ttlSeconds,
        'path' => '/',
        'domain' => $cookieParams['domain'] ?: '',
        'secure' => auth_cookie_secure_flag(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function clear_remember_token_cookie(): void
{
    $cookieParams = session_get_cookie_params();
    $secure = auth_cookie_secure_flag();

    setcookie('remember_token', '', [
        'expires' => time() - 42000,
        'path' => '/',
        'domain' => $cookieParams['domain'] ?: '',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

function auth_session_password_stale(PDO $pdo): bool
{
    if (!isset($_SESSION['user_id'])) {
        return false;
    }

    $userId = (int) $_SESSION['user_id'];
    if ($userId <= 0) {
        return false;
    }

    $userType = strtolower((string) ($_SESSION['user_type'] ?? ''));
    if ($userType === '') {
        $userType = isset($_SESSION['role']) && strtolower((string) $_SESSION['role']) === 'owner'
            ? 'owner'
            : 'user';
    }

    $storedPassword = null;

    try {
        if ($userType === 'member') {
            $stmt = $pdo->prepare('SELECT password FROM account WHERE id = ? LIMIT 1');
            $stmt->execute([$userId]);
            $storedPassword = $stmt->fetchColumn();
        } elseif ($userType === 'owner') {
            $stmt = $pdo->prepare('SELECT password FROM owner WHERE id = ? LIMIT 1');
            $stmt->execute([$userId]);
            $storedPassword = $stmt->fetchColumn();
        } else {
            $stmt = $pdo->prepare('SELECT password FROM user WHERE id = ? LIMIT 1');
            $stmt->execute([$userId]);
            $storedPassword = $stmt->fetchColumn();
        }
    } catch (Throwable $e) {
        error_log('auth_session_password_stale lookup failed: ' . $e->getMessage());
        return false;
    }

    if ($storedPassword === false || $storedPassword === null || $storedPassword === '') {
        return true;
    }

    $storedPassword = (string) $storedPassword;

    if (!isset($_SESSION['password_fingerprint'])) {
        auth_store_password_fingerprint($storedPassword);
        return false;
    }

    return auth_password_fingerprint($storedPassword) !== (string) $_SESSION['password_fingerprint'];
}

/**
 * Destroy session and remember-me cookie after password change elsewhere.
 */
function auth_force_logout_session(?PDO $pdo, bool $isApiRequest): void
{
    if ($pdo instanceof PDO && isset($_SESSION['user_id'])) {
        $userType = strtolower((string) ($_SESSION['user_type'] ?? ''));
        if ($userType === 'user' || $userType === '') {
            invalidate_user_remember_token($pdo, (int) $_SESSION['user_id']);
        }

        // 密码已变 → 指纹解锁凭据一并作废，否则旧密码换来的设备令牌仍能开门
        $deviceUserType = $userType;
        if ($deviceUserType === '') {
            $deviceUserType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
        }
        invalidate_device_tokens($pdo, $deviceUserType, (int) $_SESSION['user_id']);
    }

    if (function_exists('session_user_payload_cache_clear')) {
        session_user_payload_cache_clear();
    }

    $cookieParams = session_get_cookie_params();
    $secure = auth_cookie_secure_flag();

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

    clear_remember_token_cookie();

    $message = 'Password was changed. Please login again.';

    if ($isApiRequest) {
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
        }
        http_response_code(401);
        echo json_encode([
            'success' => false,
            'status' => 'error',
            'message' => $message,
            'redirect' => '/login',
            'data' => null,
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    header('Location: /login');
    exit;
}
