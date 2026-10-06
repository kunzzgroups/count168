<?php
/**
 * WebAuthn 注册 —— 第 2 步：校验凭据并保存公钥。
 *
 * 服务端**从不**信任客户端传来的公钥：公钥是从 attestationObject 里的
 * authenticatorData 解出来的（客户端无法伪造，因为它被签名覆盖 —— 注册阶段
 * 由验证器保证），客户端另外传的 credential_id 只用来跟解析结果做一致性比对。
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
function wa_regver_fail(string $code, string $message): void
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
    wa_install_error_handler('webauthn_register_verify');
    require_once __DIR__ . '/../../includes/device_token.php';
} catch (Throwable $e) {
    error_log('webauthn_register_verify bootstrap failed: ' . $e->getMessage());
    wa_regver_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    wa_regver_fail('SERVER_ERROR', 'Database connection failed');
}

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')) !== 'POST') {
    wa_regver_fail('BAD_REQUEST', 'POST required');
}

$userId = (int) ($_SESSION['user_id'] ?? 0);
if ($userId <= 0) {
    wa_regver_fail('NOT_LOGGED_IN', 'Not logged in');
}

$userType = device_token_normalize_user_type((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = strtolower((string) ($_SESSION['role'] ?? '')) === 'owner' ? 'owner' : 'user';
}
if ($userType !== 'member'
    && device_token_secondary_password_pending($pdo, $userType, $userId, $_SESSION)) {
    wa_regver_fail('SECONDARY_PASSWORD_REQUIRED', 'Please verify your secondary password first.');
}

$clientCredentialId = trim((string) ($_POST['credential_id'] ?? ''));
$clientDataJson = trim((string) ($_POST['client_data_json'] ?? ''));
$attestationObject = trim((string) ($_POST['attestation_object'] ?? ''));
$deviceName = trim((string) ($_POST['device_name'] ?? ''));

if ($clientCredentialId === '' || $clientDataJson === '' || $attestationObject === '') {
    wa_regver_fail('BAD_REQUEST', 'Missing credential data');
}

// ① 取出并作废一次性 challenge（无论成败都不复用）
$challenge = wa_challenge_consume('register');
if ($challenge === null) {
    wa_regver_fail('CHALLENGE_EXPIRED', 'This request expired. Please try again.');
}

// ② clientDataJSON：type / challenge / origin 三项都必须对
if (wa_check_client_data($clientDataJson, 'webauthn.create', $challenge) === null) {
    wa_regver_fail('CLIENT_DATA_INVALID', 'Could not verify this request.');
}

// ③ 从 attestationObject 解出 authData 与公钥（同时校验 rpIdHash / UP / UV / AT）
$parsed = wa_parse_attestation_none($attestationObject);
if ($parsed === null) {
    wa_regver_fail('ATTESTATION_INVALID', 'Could not verify this device.');
}

// ④ 客户端报的 credential_id 必须与服务端从 authData 里解出的一致
$serverCredentialId = (string) $parsed['credential_id'];
if (!hash_equals($serverCredentialId, (string) (wa_b64url_decode($clientCredentialId) ?? ''))) {
    wa_regver_fail('CREDENTIAL_MISMATCH', 'Could not verify this device.');
}

wa_ensure_table($pdo);

$saved = wa_credential_save(
    $pdo,
    $userType,
    $userId,
    $serverCredentialId,
    (string) $parsed['public_key_pem'],
    (int) $parsed['sign_count'],
    $deviceName !== '' ? $deviceName : 'Biometric device',
    device_token_capture_session()
);

if (!$saved['ok']) {
    if ($saved['code'] === 'CREDENTIAL_LIMIT') {
        wa_regver_fail('CREDENTIAL_LIMIT', 'Too many biometric credentials. Remove one first.');
    }
    wa_regver_fail($saved['code'], 'Could not save this device.');
}

if (ob_get_level() > 0) {
    ob_clean();
}
echo json_encode([
    'success' => true,
    'message' => 'Registered',
], JSON_UNESCAPED_UNICODE);
