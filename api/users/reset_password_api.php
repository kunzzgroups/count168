<?php
/**
 * 重置密码 - 验证 TAC 并更新密码
 * POST: company_id (string, 公司 ID 或 Owner Code), email, tac, new_password
 * 先按公司查 user，若无则按 owner_code + email 查 owner，验证 TAC 后更新对应密码
 */
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

require_once __DIR__ . '/../../includes/config.php';
require_once __DIR__ . '/../../includes/password_hashing.php';
require_once __DIR__ . '/../../includes/email_validation.php';
require_once __DIR__ . '/../../includes/auth_invalidation.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

try {
    $input = json_decode(file_get_contents('php://input'), true) ?: [];
    $company_id_raw = trim($input['company_id'] ?? $_POST['company_id'] ?? '');
    $emailValidation = validate_email($input['email'] ?? $_POST['email'] ?? '');
    $tac = trim($input['tac'] ?? $_POST['tac'] ?? '');
    $new_password = $input['new_password'] ?? $_POST['new_password'] ?? '';

    if (!$company_id_raw || !$emailValidation['normalized'] || !$tac || $new_password === '' || $new_password === null) {
        echo json_encode(['success' => false, 'message' => 'Company ID, email, TAC and new password are required']);
        exit;
    }
    if (!$emailValidation['ok']) {
        echo json_encode(['success' => false, 'message' => 'Invalid email format']);
        exit;
    }

    $company_id_upper = strtoupper($company_id_raw);
    $email = $emailValidation['normalized'];
    $email_lower = $email;

    // 1) 尝试验证普通用户的 TAC（支持 Company ID 或 Group ID）
    $stmt = $pdo->prepare("
        SELECT u.id AS user_id, c.id AS numeric_company_id
        FROM user u
        INNER JOIN user_company_map ucm ON u.id = ucm.user_id
        INNER JOIN company c ON ucm.company_id = c.id
        WHERE u.email = ? AND (UPPER(c.company_id) = ? OR UPPER(c.group_id) = ?) AND u.status = 'active'
        ORDER BY c.id ASC
        LIMIT 1
    ");
    $stmt->execute([$email, $company_id_upper, $company_id_upper]);
    $user_info = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($user_info) {
        $user_id = $user_info['user_id'];
        $company_numeric_id = $user_info['numeric_company_id'];

        // 用户重置：验证 password_reset_tac
        $stmt = $pdo->prepare("
            SELECT email, company_id, code, expires_at
            FROM password_reset_tac
            WHERE email = ? AND company_id = ? AND code = ? AND expires_at > NOW()
            LIMIT 1
        ");
        $stmt->execute([$email, $company_numeric_id, $tac]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        
        if (!$row) {
            echo json_encode(['success' => false, 'message' => 'Invalid or expired TAC. Please request a new code.']);
            exit;
        }

        $hashed = secure_hash_password($new_password);
        $pdo->prepare("UPDATE user SET password = ? WHERE id = ?")->execute([$hashed, $user_id]);
        invalidate_user_remember_token($pdo, (int) $user_id);
        // 指纹解锁凭据同步作废（device_token 覆盖 owner/user/member，比 remember_token 广）
        invalidate_device_tokens($pdo, 'user', (int) $user_id);
        $pdo->prepare("DELETE FROM password_reset_tac WHERE email = ? AND company_id = ?")->execute([$email, $company_numeric_id]);
        echo json_encode(['success' => true, 'message' => 'Password reset successful']);
        exit;
    }

    // 2) 如果未找到匹配的普通用户，按 Owner Code + email 查 owner，验证 password_reset_tac_owner
    $stmt = $pdo->prepare("
        SELECT id FROM owner
        WHERE UPPER(owner_code) = ? AND LOWER(TRIM(email)) = ?
        LIMIT 1
    ");
    $stmt->execute([$company_id_upper, $email_lower]);
    $owner_id = $stmt->fetchColumn();
    if (!$owner_id) {
        echo json_encode(['success' => false, 'message' => 'No active user found for this email in the selected company/group. For owner reset, enter your Owner Code in the Company ID field.']);
        exit;
    }

    $stmt = $pdo->prepare("
        SELECT email, owner_id, code, expires_at
        FROM password_reset_tac_owner
        WHERE LOWER(email) = ? AND owner_id = ? AND code = ? AND expires_at > NOW()
        LIMIT 1
    ");
    $stmt->execute([$email_lower, $owner_id, $tac]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        echo json_encode(['success' => false, 'message' => 'Invalid or expired TAC. Please request a new code.']);
        exit;
    }

    $hashed = secure_hash_password($new_password);
    $pdo->prepare("UPDATE owner SET password = ? WHERE id = ?")->execute([$hashed, $owner_id]);
    // owner 没有 remember_token，但可能有指纹解锁令牌
    invalidate_device_tokens($pdo, 'owner', (int) $owner_id);
    $pdo->prepare("DELETE FROM password_reset_tac_owner WHERE email = ? AND owner_id = ?")->execute([$email_lower, $owner_id]);
    echo json_encode(['success' => true, 'message' => 'Password reset successful']);
} catch (Exception $e) {
    error_log("reset_password_api: " . $e->getMessage());
    echo json_encode(['success' => false, 'message' => 'Failed to reset password. Please try again or contact support.']);
}
