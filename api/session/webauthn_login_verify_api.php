<?php
/**
 * WebAuthn 登录 —— 第 2 步：验签并建立会话。
 *
 * 响应与 api/session/login_api.php **同构**（status/redirect/user_type/login_scope），
 * 前端可以直接复用既有的落地路由逻辑。
 *
 * 本端点未登录即可访问（它就是登录入口）；失败不回写任何库，避免被刷。
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
function wa_logver_fail(string $code, string $message): void
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
    require_once __DIR__ . '/../../includes/webauthn.php';
    wa_install_error_handler('webauthn_login_verify');
    require_once __DIR__ . '/../../includes/device_token.php';
    require_once __DIR__ . '/../../includes/company_expiration.php';
    require_once __DIR__ . '/../../includes/session_user_payload_cache.php';
    require_once __DIR__ . '/../../includes/maintenance_gate.php';
} catch (Throwable $e) {
    error_log('webauthn_login_verify bootstrap failed: ' . $e->getMessage());
    wa_logver_fail('SERVER_ERROR', 'Database connection failed');
}

if (!isset($pdo) || !$pdo instanceof PDO) {
    wa_logver_fail('SERVER_ERROR', 'Database connection failed');
}

if (strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? '')) !== 'POST') {
    wa_logver_fail('BAD_REQUEST', 'POST required');
}

$clientCredentialId = trim((string) ($_POST['credential_id'] ?? ''));
$clientDataJson = trim((string) ($_POST['client_data_json'] ?? ''));
$authenticatorDataB64 = trim((string) ($_POST['authenticator_data'] ?? ''));
$signatureB64 = trim((string) ($_POST['signature'] ?? ''));
$userHandleB64 = trim((string) ($_POST['user_handle'] ?? ''));

if ($clientCredentialId === '' || $clientDataJson === '' || $authenticatorDataB64 === '' || $signatureB64 === '') {
    wa_logver_fail('BAD_REQUEST', 'Missing assertion data');
}

// ① 一次性 challenge：取出即作废，防重放
$challenge = wa_challenge_consume('login');
if ($challenge === null) {
    wa_logver_fail('CHALLENGE_EXPIRED', 'This request expired. Please try again.');
}

// ② clientDataJSON：type=webauthn.get、challenge 逐字节一致、origin 精确匹配
$clientData = wa_check_client_data($clientDataJson, 'webauthn.get', $challenge);
if ($clientData === null) {
    wa_logver_fail('CLIENT_DATA_INVALID', 'Could not verify this request.');
}

// ③ 按凭据 ID 反查身份
$credentialIdBin = wa_b64url_decode($clientCredentialId);
if ($credentialIdBin === null || $credentialIdBin === '') {
    wa_logver_fail('CREDENTIAL_UNKNOWN', 'This passkey is not registered here.');
}
$credential = wa_credential_find($pdo, $credentialIdBin);
if ($credential === null) {
    wa_logver_fail('CREDENTIAL_UNKNOWN', 'This passkey is not registered here.');
}

// ④ 解析 authenticatorData（校验 rpIdHash / UP / UV）
$authDataBin = wa_b64url_decode($authenticatorDataB64);
if ($authDataBin === null) {
    wa_logver_fail('ASSERTION_INVALID', 'Could not verify this passkey.');
}
$authData = wa_parse_auth_data($authDataBin, false);
if ($authData === null) {
    wa_logver_fail('ASSERTION_INVALID', 'Could not verify this passkey.');
}

// ⑤ 验签：覆盖 authenticatorData || SHA256(clientDataJSON)
$signatureBin = wa_b64url_decode($signatureB64);
if ($signatureBin === null || !wa_verify_assertion(
    $authDataBin,
    (string) $clientData['raw'],
    $signatureBin,
    (string) $credential['public_key_pem']
)) {
    wa_logver_fail('SIGNATURE_INVALID', 'Could not verify this passkey.');
}

// ⑥ 身份与凭据的一致性
$userType = device_token_normalize_user_type((string) $credential['user_type']);
$userId = (int) $credential['user_id'];
if ($userType === '' || $userId <= 0) {
    wa_logver_fail('CREDENTIAL_UNKNOWN', 'This passkey is not registered here.');
}

// 验证器回传的 userHandle（若有）必须与凭据归属一致
if ($userHandleB64 !== '') {
    $handle = wa_b64url_decode($userHandleB64);
    if ($handle === null || !hash_equals(wa_user_handle($userType, $userId), $handle)) {
        wa_logver_fail('ASSERTION_INVALID', 'Could not verify this passkey.');
    }
}

// ⑦ signCount 单调性（平台验证器恒为 0，此时跳过）
$receivedCount = (int) $authData['sign_count'];
if (!wa_sign_count_ok((int) $credential['sign_count'], $receivedCount)) {
    error_log(sprintf(
        'webauthn signCount regression: credential=%d stored=%d received=%d',
        (int) $credential['id'],
        (int) $credential['sign_count'],
        $receivedCount
    ));
    wa_logver_fail('ASSERTION_INVALID', 'Could not verify this passkey.');
}

// ⑧ 身份仍然有效 + 公司/组未过期
$principal = device_token_fetch_principal($pdo, $userType, $userId);
if ($principal === null || strtolower($principal['status']) !== 'active') {
    wa_logver_fail('USER_DISABLED', 'Account is not active. Please login again.');
}

$snapshot = json_decode((string) ($credential['session_snapshot'] ?? ''), true);
if (!is_array($snapshot) || (int) ($snapshot['user_id'] ?? 0) !== $userId) {
    wa_logver_fail('ASSERTION_INVALID', 'Could not verify this passkey.');
}
if (device_token_company_expired($pdo, $snapshot)) {
    wa_logver_fail('COMPANY_EXPIRED', 'Company or Group has expired.');
}

// ⑨ 维护模式（语义对齐 login_api / device_login_api：member 一律拒绝）
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

// ⑩ 建立会话（复用设备令牌那套经过测试的快照还原）
device_token_restore_session($snapshot);
if ((int) ($_SESSION['user_id'] ?? 0) !== $userId
    || (string) ($_SESSION['user_type'] ?? '') !== $userType) {
    wa_logver_fail('ASSERTION_INVALID', 'Could not verify this passkey.');
}
session_user_payload_cache_clear();

// ⑪ 二级密码策略（与指纹解锁同一开关，见 device_token.php 的常量说明）
$redirect = device_token_secondary_password_redirect($pdo, $userType, $userId, $snapshot);
if ($redirect !== null && DEVICE_TOKEN_TRUSTED_SKIPS_SECONDARY) {
    $redirect = null;
}
device_token_apply_trusted_secondary_policy($pdo, $userType, $userId, $snapshot);
if ($redirect === null) {
    $redirect = $userType === 'member' ? '/member' : '/dashboard';
}

wa_credential_touch($pdo, (int) $credential['id'], $receivedCount);

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
