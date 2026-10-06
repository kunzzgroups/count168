<?php
// 会话超时配置（单位：秒，这里为 1 小时，与dashboard.php保持一致）
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

// 超过指定时长未操作则销毁会话，要求重新登录
if (isset($_SESSION['last_activity']) && (time() - (int) $_SESSION['last_activity']) > $sessionTimeout) {
    session_unset();
    session_destroy();
    session_set_cookie_params($cookieOptions);
    session_start();
}

// 设置错误处理，确保返回 JSON
header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

// 开启输出缓冲，防止意外输出（必须在 header 之后）
ob_start();

try {
require_once __DIR__ . '/../../includes/config.php';
require_once __DIR__ . '/../../includes/password_hashing.php';
require_once __DIR__ . '/../../includes/session_user_payload_cache.php';
    require_once __DIR__ . '/../../includes/maintenance_gate.php';
    require_once __DIR__ . '/../../includes/login_scope.php';
    require_once __DIR__ . '/../../includes/group_company_access.php';
    require_once __DIR__ . '/../../includes/group_tenant_v2.php';
    require_once __DIR__ . '/../../includes/company_expiration.php';
    require_once __DIR__ . '/../../includes/auth_invalidation.php';
    require_once __DIR__ . '/../../includes/device_token.php';
} catch (Throwable $e) {
    ob_clean();
    echo json_encode(['status' => 'error', 'message' => 'Database connection failed']);
    exit;
}

// 检查 $pdo 是否已定义
if (!isset($pdo) || !$pdo) {
    ob_clean();
    echo json_encode(['status' => 'error', 'message' => 'Database connection failed']);
    exit;
}

/**
 * @deprecated Use gc_is_company_expiration_blocking()
 */
function isCompanyExpiredOrUnset($expirationDate, $companyCode = null, $groupId = null): bool
{
    return gc_is_company_expiration_blocking($expirationDate, $companyCode, $groupId);
}

try {
    if ($_POST) {
        session_unset();
        session_user_payload_cache_clear();

        $password = trim($_POST['password']);
        $company_id = strtoupper(trim($_POST['company_id'])); // 转换为大写，不区分大小写
        $login_role = isset($_POST['login_role']) ? trim($_POST['login_role']) : 'admin'; // 获取登录角色
        $login_id_input = trim($_POST['login_id'] ?? '');
        $forceC168ForSystemIt = ($login_role !== 'member') && maintenance_gate_is_allowlisted_login($login_id_input);
        if ($forceC168ForSystemIt) {
            // System IT users are hard-fixed to C168 regardless of submitted company/group.
            $company_id = 'C168';
        }

        if (maintenance_gate_is_enabled($pdo)) {
            if ($login_role === 'member') {
                echo json_encode(maintenance_gate_build_login_reject_payload($pdo), JSON_UNESCAPED_UNICODE);
                exit;
            }
            if (!maintenance_gate_is_active_user_login($pdo, $login_id_input)) {
                echo json_encode(maintenance_gate_build_login_reject_payload($pdo), JSON_UNESCAPED_UNICODE);
                exit;
            }
        }
    
    // 如果选择的是 member，从 account 表验证
    if ($login_role === 'member') {
        // Member 使用 account_id 字段
        $account_id = trim($_POST['account_id'] ?? '');
        
        if (empty($account_id)) {
            echo json_encode(['status' => 'error', 'message' => 'Please enter account ID']);
            exit;
        }
        
        // 从 account 表验证：验证公司、账号、密码、状态
        // 修改条件，允许匹配 company_id 或者 group_id
        $stmt = $pdo->prepare("
            SELECT a.*, c.id AS company_numeric_id, c.company_id AS company_code, c.group_id, c.expiration_date 
            FROM account a
            INNER JOIN account_company ac ON a.id = ac.account_id
            INNER JOIN company c ON ac.company_id = c.id
            WHERE UPPER(a.account_id) = UPPER(?) 
            AND (UPPER(c.company_id) = ? OR UPPER(c.group_id) = ?)
            AND a.status = 'active'
        ");
        $stmt->execute([$account_id, $company_id, $company_id]);
        $matched_accounts = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        $account = null;
        $has_expired = false;
        $password_match = false;
        $account_record_to_update = null;

        foreach ($matched_accounts as $row) {
            if (empty($row['password'])) {
                continue;
            }
            $is_pwd_valid = false;
            $stored = (string) $row['password'];
            if (verify_secure_password($password, $stored)) {
                $is_pwd_valid = true;
            } elseif ($password === $stored) {
                $is_pwd_valid = true;
                $account_record_to_update = $row;
            }
            if (!$is_pwd_valid) {
                continue;
            }
            $password_match = true;
            if (isCompanyExpiredOrUnset($row['expiration_date'] ?? null, $row['company_code'] ?? null, $row['group_id'] ?? null)) {
                $has_expired = true;
            } else {
                $account = $row;
                break;
            }
        }
        
        // 检查账户是否存在且密码匹配
        if ($account) {
            // Member 登录成功（保留 member_login_account_id 供 Win/Loss 刷新后恢复所选被连接方）
            $_SESSION['member_login_account_id'] = $account['id'];
            $_SESSION['member_winloss_view_account_id'] = $account['id'];
            $_SESSION['user_id'] = $account['id'];
            session_user_payload_cache_clear();
            $_SESSION['login_id'] = $account['account_id'];
            $_SESSION['name'] = $account['name'];
            $_SESSION['role'] = $account['role'];
            $_SESSION['user_type'] = 'member';
            $_SESSION['account_id'] = $account['account_id'];
            // 使用 match 到的第一家 company 的数字 ID
            $_SESSION['company_id'] = $account['company_numeric_id'];
            $_SESSION['last_activity'] = time();

            $passwordForFingerprint = (string) ($account['password'] ?? '');
            // 明文密码登录成功时升级为哈希（与 owner 一致）
            if ($account_record_to_update && (int) $account['id'] === (int) $account_record_to_update['id']) {
                $hashed_password = secure_hash_password($password);
                $update_stmt = $pdo->prepare('UPDATE account SET password = ? WHERE id = ?');
                $update_stmt->execute([$hashed_password, $account['id']]);
                $passwordForFingerprint = $hashed_password;
            } else {
                $rehashed = maybe_rehash_password($password, $passwordForFingerprint);
                if ($rehashed !== null) {
                    $update_stmt = $pdo->prepare('UPDATE account SET password = ? WHERE id = ?');
                    $update_stmt->execute([$rehashed, $account['id']]);
                    $passwordForFingerprint = $rehashed;
                }
            }
            auth_store_password_fingerprint($passwordForFingerprint);

            // 更新最后登录时间
            $stmt = $pdo->prepare("UPDATE account SET last_login = NOW() WHERE id = ?");
            $stmt->execute([$account['id']]);

            persist_login_filter_scope($pdo, $company_id);
            $loginFilter = resolve_login_identifier_scope($pdo, $company_id);
            device_token_web_remember_issue($pdo, 'member', (int) $account['id']);
            echo json_encode([
                'status' => 'success',
                'redirect' => '/member',
                'user_type' => 'member',
                'company_id' => (int) ($_SESSION['company_id'] ?? 0) ?: null,
                'login_scope' => $loginFilter['scope'],
                'login_identifier' => $loginFilter['identifier'],
            ]);
            exit;
        } else {
            if ($password_match && $has_expired) {
                echo json_encode(['status' => 'error', 'message' => 'Company or Group has expired.']);
            } else {
                echo json_encode(['status' => 'error', 'message' => 'Account ID, Company ID or password is incorrect']);
            }
            exit;
        }
    }
    
    // 如果不是 member，则从 user 表验证（Admin）
    // Admin 使用 login_id 字段
    $login_id = $login_id_input;
    
    if (empty($login_id)) {
        echo json_encode(['status' => 'error', 'message' => 'Please enter username']);
        exit;
    }
    
    $isGroupTenantLogin = function_exists('gt_v2_is_active_group_tenant_code')
        && gt_v2_is_active_group_tenant_code($pdo, $company_id);

    // Phase 7: first-class group tenant → prefer user_group_map auth (no subsidiary pin).
    if ($isGroupTenantLogin) {
        $gtUserEarly = function_exists('gt_v2_try_authenticate_user')
            ? gt_v2_try_authenticate_user($pdo, $login_id, $password, $company_id)
            : ['ok' => false];
        if (!empty($gtUserEarly['ok']) && !empty($gtUserEarly['user']) && !empty($gtUserEarly['group'])) {
            $user = $gtUserEarly['user'];
            $groupRow = $gtUserEarly['group'];
            $_SESSION['user_id'] = $user['id'];
            session_user_payload_cache_clear();
            $_SESSION['login_id'] = $user['login_id'];
            $_SESSION['name'] = $user['name'];
            $_SESSION['role'] = $user['role'];
            $_SESSION['user_type'] = 'user';
            $_SESSION['company_id'] = null;
            $_SESSION['company_code'] = gt_v2_normalize_group_code((string) ($groupRow['group_code'] ?? $company_id));
            $_SESSION['last_activity'] = time();
            $_SESSION['read_only'] = isset($user['read_only']) ? (int) $user['read_only'] : 1;
            $_SESSION['secondary_password_verified'] = true;

            $remember_me = isset($_POST['remember_me']) ? $_POST['remember_me'] : false;
            if ($remember_me) {
                $remember_token = bin2hex(random_bytes(32));
                $stmt = $pdo->prepare("UPDATE user SET remember_token = ?, remember_token_expires = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?");
                $stmt->execute([$remember_token, $user['id']]);
                auth_set_remember_token_cookie($remember_token);
            } else {
                invalidate_user_remember_token($pdo, (int) $user['id']);
                clear_remember_token_cookie();
            }

            auth_store_password_fingerprint((string) ($user['password'] ?? ''));
            $userStoredPassword = (string) ($user['password'] ?? '');
            $userRehashed = maybe_rehash_password($password, $userStoredPassword);
            if ($userRehashed !== null) {
                $pdo->prepare('UPDATE user SET password = ? WHERE id = ?')->execute([$userRehashed, $user['id']]);
                auth_store_password_fingerprint($userRehashed);
            }
            $pdo->prepare("UPDATE user SET last_login = NOW() WHERE id = ?")->execute([$user['id']]);

            gt_v2_apply_group_login_session($groupRow, $company_id);
            if (function_exists('gc_hydrate_session_assigned_tenants')) {
                gc_hydrate_session_assigned_tenants($pdo);
            }
            $loginFilter = resolve_login_identifier_scope($pdo, $company_id);
            echo json_encode([
                'status' => 'success',
                'redirect' => '/dashboard',
                'company_id' => null,
                'login_scope' => $loginFilter['scope'],
                'login_identifier' => $loginFilter['identifier'],
            ]);
            exit;
        }
        if (!empty($gtUserEarly['password_match']) && !empty($gtUserEarly['expired'])) {
            echo json_encode(['status' => 'error', 'message' => 'Company or Group has expired.']);
            exit;
        }
    }

    // Group-tenant login: match company_id only (never pin via c.group_id → first subsidiary).
    if ($isGroupTenantLogin) {
        $stmt = $pdo->prepare("
            SELECT 
                u.*,
                c.id AS company_numeric_id,
                c.company_id AS company_code,
                c.group_id,
                c.expiration_date
            FROM user u
            INNER JOIN user_company_map ucm ON u.id = ucm.user_id
            INNER JOIN company c ON ucm.company_id = c.id
            WHERE UPPER(u.login_id) = UPPER(?) AND UPPER(c.company_id) = ? AND u.status = 'active'
        ");
        $stmt->execute([$login_id, $company_id]);
    } else {
        $stmt = $pdo->prepare("
            SELECT 
                u.*,
                c.id AS company_numeric_id,
                c.company_id AS company_code,
                c.group_id,
                c.expiration_date
            FROM user u
            INNER JOIN user_company_map ucm ON u.id = ucm.user_id
            INNER JOIN company c ON ucm.company_id = c.id
            WHERE UPPER(u.login_id) = UPPER(?) AND (UPPER(c.company_id) = ? OR UPPER(c.group_id) = ?) AND u.status = 'active'
        ");
        $stmt->execute([$login_id, $company_id, $company_id]);
    }
    $matched_users = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    $user = null;
    $user_has_expired = false;
    $user_password_match = false;
    
    foreach ($matched_users as $row) {
        if (verify_secure_password($password, (string) $row['password'])) {
            $user_password_match = true;
            if (isCompanyExpiredOrUnset($row['expiration_date'] ?? null, $row['company_code'] ?? null, $row['group_id'] ?? null)) {
                $user_has_expired = true;
            } else {
                $user = $row;
                break;
            }
        }
    }
    
    if ($user) {
        // User 登录成功
        $_SESSION['user_id'] = $user['id'];
        session_user_payload_cache_clear();
        $_SESSION['login_id'] = $user['login_id'];
        $_SESSION['name'] = $user['name'];
        $_SESSION['role'] = $user['role'];
        $_SESSION['user_type'] = 'user';
        $_SESSION['company_id'] = $user['company_numeric_id'];
        $_SESSION['company_code'] = $user['company_code'];
        $_SESSION['last_activity'] = time();
        $_SESSION['read_only'] = isset($user['read_only']) ? (int)$user['read_only'] : 1; // Partnership read-only state
        if (maintenance_gate_is_allowlisted_login((string) ($user['login_id'] ?? ''))) {
            maintenance_gate_force_it_c168_session($pdo);
            $company_id = strtoupper(trim((string) ($_SESSION['company_code'] ?? $company_id)));
        }

        // 处理Remember Me
        $remember_me = isset($_POST['remember_me']) ? $_POST['remember_me'] : false;
        if ($remember_me) {
            $remember_token = bin2hex(random_bytes(32)); // 生成安全的token
            
            // 将token存储到数据库
            $stmt = $pdo->prepare("UPDATE user SET remember_token = ?, remember_token_expires = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?");
            $stmt->execute([$remember_token, $user['id']]);
            
            // 设置cookie，30天过期
            auth_set_remember_token_cookie($remember_token);
        } else {
            invalidate_user_remember_token($pdo, (int) $user['id']);
            clear_remember_token_cookie();
        }

        auth_store_password_fingerprint((string) ($user['password'] ?? ''));

        $userStoredPassword = (string) ($user['password'] ?? '');
        $userRehashed = maybe_rehash_password($password, $userStoredPassword);
        if ($userRehashed !== null) {
            $pdo->prepare('UPDATE user SET password = ? WHERE id = ?')->execute([$userRehashed, $user['id']]);
            auth_store_password_fingerprint($userRehashed);
        }

        // 更新最后登录时间
        $stmt = $pdo->prepare("UPDATE user SET last_login = NOW() WHERE id = ?");
        $stmt->execute([$user['id']]);

        // 检查是否是c168公司的用户，且已设置二级密码，则需要二级密码验证
        $needs_secondary_password = false;
        if (strtoupper($user['company_code']) === 'C168') {
            // 检查用户是否设置了二级密码
            $stmt = $pdo->prepare("SELECT secondary_password FROM user WHERE id = ?");
            $stmt->execute([$user['id']]);
            $user_secondary = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($user_secondary && !empty($user_secondary['secondary_password'])) {
                $needs_secondary_password = true;
            }
        }

        persist_login_filter_scope($pdo, $company_id);
        if (function_exists('gc_hydrate_session_assigned_tenants')) {
            gc_hydrate_session_assigned_tenants($pdo);
        }
        $loginFilter = resolve_login_identifier_scope($pdo, $company_id);

        if ($needs_secondary_password) {
            // 需要二级密码验证，跳转到二级密码验证页面
            echo json_encode([
                'status' => 'success',
                'redirect' => '/user-secondary-password',
                'company_id' => (int) ($_SESSION['company_id'] ?? 0) ?: null,
                'login_scope' => $loginFilter['scope'],
                'login_identifier' => $loginFilter['identifier'],
            ]);
        } else {
            // 不需要二级密码验证，直接跳转到dashboard
            $_SESSION['secondary_password_verified'] = true; // 标记为已验证（对于不需要二级密码的用户）
            echo json_encode([
                'status' => 'success',
                'redirect' => '/dashboard',
                'company_id' => (int) ($_SESSION['company_id'] ?? 0) ?: null,
                'login_scope' => $loginFilter['scope'],
                'login_identifier' => $loginFilter['identifier'],
            ]);
        }
        exit;
        
    } else {
        if ($user_password_match && $user_has_expired) {
            echo json_encode(['status' => 'error', 'message' => 'Company or Group has expired.']);
            exit;
        }

        // Phase 1 (group tenant v2): Admin via user_group_map when no company under group
        $gtUser = function_exists('gt_v2_try_authenticate_user')
            ? gt_v2_try_authenticate_user($pdo, $login_id, $password, $company_id)
            : ['ok' => false];
        if (!empty($gtUser['ok']) && !empty($gtUser['user']) && !empty($gtUser['group'])) {
            $user = $gtUser['user'];
            $groupRow = $gtUser['group'];
            $_SESSION['user_id'] = $user['id'];
            session_user_payload_cache_clear();
            $_SESSION['login_id'] = $user['login_id'];
            $_SESSION['name'] = $user['name'];
            $_SESSION['role'] = $user['role'];
            $_SESSION['user_type'] = 'user';
            $_SESSION['company_id'] = null;
            $_SESSION['company_code'] = gt_v2_normalize_group_code((string) ($groupRow['group_code'] ?? $company_id));
            $_SESSION['last_activity'] = time();
            $_SESSION['read_only'] = isset($user['read_only']) ? (int) $user['read_only'] : 1;
            $_SESSION['secondary_password_verified'] = true;

            $remember_me = isset($_POST['remember_me']) ? $_POST['remember_me'] : false;
            if ($remember_me) {
                $remember_token = bin2hex(random_bytes(32));
                $stmt = $pdo->prepare("UPDATE user SET remember_token = ?, remember_token_expires = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?");
                $stmt->execute([$remember_token, $user['id']]);
                auth_set_remember_token_cookie($remember_token);
            } else {
                invalidate_user_remember_token($pdo, (int) $user['id']);
                clear_remember_token_cookie();
            }

            auth_store_password_fingerprint((string) ($user['password'] ?? ''));
            $userStoredPassword = (string) ($user['password'] ?? '');
            $userRehashed = maybe_rehash_password($password, $userStoredPassword);
            if ($userRehashed !== null) {
                $pdo->prepare('UPDATE user SET password = ? WHERE id = ?')->execute([$userRehashed, $user['id']]);
                auth_store_password_fingerprint($userRehashed);
            }
            $pdo->prepare("UPDATE user SET last_login = NOW() WHERE id = ?")->execute([$user['id']]);

            gt_v2_apply_group_login_session($groupRow, $company_id);
            if (function_exists('gc_hydrate_session_assigned_tenants')) {
                gc_hydrate_session_assigned_tenants($pdo);
            }
            $loginFilter = resolve_login_identifier_scope($pdo, $company_id);
            echo json_encode([
                'status' => 'success',
                'redirect' => '/dashboard',
                'company_id' => null,
                'login_scope' => $loginFilter['scope'],
                'login_identifier' => $loginFilter['identifier'],
            ]);
            exit;
        }
        if (!empty($gtUser['password_match']) && !empty($gtUser['expired'])) {
            echo json_encode(['status' => 'error', 'message' => 'Company or Group has expired.']);
            exit;
        }

        // User 表找不到，尝试从 owner 表验证
        // Phase 7: active groups.group_code → Owner group session (no subsidiary pin via c.group_id).
        $isGroupTenantOwnerLogin = function_exists('gt_v2_is_active_group_tenant_code')
            && gt_v2_is_active_group_tenant_code($pdo, $company_id);

        if ($isGroupTenantOwnerLogin) {
            $gtOwnerEarly = function_exists('gt_v2_try_authenticate_owner')
                ? gt_v2_try_authenticate_owner($pdo, $login_id, $password, $company_id)
                : ['ok' => false];
            if (!empty($gtOwnerEarly['ok']) && !empty($gtOwnerEarly['owner']) && !empty($gtOwnerEarly['group'])) {
                $owner = $gtOwnerEarly['owner'];
                $groupRow = $gtOwnerEarly['group'];
                $passwordForFingerprint = (string) ($owner['password'] ?? '');
                if (!empty($gtOwnerEarly['upgrade_plain'])) {
                    $hashed_password = secure_hash_password($password);
                    $pdo->prepare('UPDATE owner SET password = ? WHERE id = ?')->execute([$hashed_password, $owner['id']]);
                    $passwordForFingerprint = $hashed_password;
                } else {
                    $ownerRehashed = maybe_rehash_password($password, $passwordForFingerprint);
                    if ($ownerRehashed !== null) {
                        $pdo->prepare('UPDATE owner SET password = ? WHERE id = ?')->execute([$ownerRehashed, $owner['id']]);
                        $passwordForFingerprint = $ownerRehashed;
                    }
                }

                $_SESSION['user_id'] = $owner['id'];
                session_user_payload_cache_clear();
                $_SESSION['login_id'] = $owner['owner_code'];
                $_SESSION['name'] = $owner['name'];
                $_SESSION['role'] = 'owner';
                $_SESSION['user_type'] = 'owner';
                $_SESSION['owner_id'] = $owner['id'];
                $_SESSION['real_owner_id'] = $owner['id'];
                $_SESSION['owner_code'] = $owner['owner_code'];
                $_SESSION['company_id'] = null;
                $_SESSION['company_code'] = gt_v2_normalize_group_code((string) ($groupRow['group_code'] ?? $company_id));
                $_SESSION['last_activity'] = time();
                unset($_SESSION['secondary_password_verified']);

                auth_store_password_fingerprint($passwordForFingerprint);
                gt_v2_apply_group_login_session($groupRow, $company_id);
                $loginFilter = resolve_login_identifier_scope($pdo, $company_id);
                device_token_web_remember_issue($pdo, 'owner', (int) $owner['id']);
                echo json_encode([
                    'status' => 'success',
                    'redirect' => '/owner-secondary-password',
                    'user_type' => 'owner',
                    'company_id' => null,
                    'login_scope' => $loginFilter['scope'],
                    'login_identifier' => $loginFilter['identifier'],
                ]);
                exit;
            }
            if (!empty($gtOwnerEarly['password_match']) && !empty($gtOwnerEarly['expired'])) {
                echo json_encode(['status' => 'error', 'message' => 'Company or Group has expired.']);
                exit;
            }
        }

        // 通过 company 表关联查询 owner（group-tenant：仅 company_id，禁止 group_id pin）
        if ($isGroupTenantOwnerLogin) {
            $stmt = $pdo->prepare("
                SELECT o.*, c.id AS company_numeric_id, c.company_id AS company_code, c.group_id, c.expiration_date
                FROM owner o
                INNER JOIN company c ON c.owner_id = o.id
                WHERE UPPER(o.owner_code) = UPPER(?) AND UPPER(c.company_id) = ?
            ");
            $stmt->execute([$login_id, $company_id]);
        } else {
            $stmt = $pdo->prepare("
                SELECT o.*, c.id AS company_numeric_id, c.company_id AS company_code, c.group_id, c.expiration_date
                FROM owner o
                INNER JOIN company c ON c.owner_id = o.id
                WHERE UPPER(o.owner_code) = UPPER(?) AND (UPPER(c.company_id) = ? OR UPPER(c.group_id) = ?)
            ");
            $stmt->execute([$login_id, $company_id, $company_id]);
        }
        $matched_owners = $stmt->fetchAll(PDO::FETCH_ASSOC);
        
        $owner = null;
        $owner_has_expired = false;
        $owner_password_match = false;
        $owner_record_to_update = null;
        
        foreach ($matched_owners as $row) {
            $is_pwd_valid = false;
            // 先尝试哈希验证（标准方式）
            if (verify_secure_password($password, (string) $row['password'])) {
                $is_pwd_valid = true;
            } 
            // 如果哈希验证失败，检查是否是明文密码（兼容旧数据）
            elseif ($password === $row['password']) {
                $is_pwd_valid = true;
                $owner_record_to_update = $row;
            }

            if ($is_pwd_valid) {
                $owner_password_match = true;
                if (isCompanyExpiredOrUnset($row['expiration_date'] ?? null, $row['company_code'] ?? null, $row['group_id'] ?? null)) {
                    $owner_has_expired = true;
                } else {
                    $owner = $row;
                    break;
                }
            }
        }
        
        if ($owner) {
            $passwordForFingerprint = (string) ($owner['password'] ?? '');
            // 如果使用明文密码验证成功，自动升级为哈希密码
            if ($owner_record_to_update && $owner['id'] == $owner_record_to_update['id']) {
                $hashed_password = secure_hash_password($password);
                $update_stmt = $pdo->prepare("UPDATE owner SET password = ? WHERE id = ?");
                $update_stmt->execute([$hashed_password, $owner['id']]);
                $passwordForFingerprint = $hashed_password;
            } else {
                $ownerRehashed = maybe_rehash_password($password, $passwordForFingerprint);
                if ($ownerRehashed !== null) {
                    $update_stmt = $pdo->prepare('UPDATE owner SET password = ? WHERE id = ?');
                    $update_stmt->execute([$ownerRehashed, $owner['id']]);
                    $passwordForFingerprint = $ownerRehashed;
                }
            }

            $_SESSION['user_id'] = $owner['id'];
            session_user_payload_cache_clear();
            $_SESSION['login_id'] = $owner['owner_code'];
            $_SESSION['name'] = $owner['name'];
            $_SESSION['role'] = 'owner';
            $_SESSION['user_type'] = 'owner';
            $_SESSION['owner_id'] = $owner['id'];
            $_SESSION['real_owner_id'] = $owner['id'];
            $_SESSION['owner_code'] = $owner['owner_code'];
            $_SESSION['company_id'] = $owner['company_numeric_id']; // 使用数字 ID
            $_SESSION['company_code'] = $owner['company_code']; // 保存字符串编码供显示用
            $_SESSION['last_activity'] = time();
            unset($_SESSION['secondary_password_verified']);

            // remember-me 统一在响应前由 device_token_web_remember_issue() 处理（原先是空壳分支）

            auth_store_password_fingerprint($passwordForFingerprint);

            persist_login_filter_scope($pdo, $company_id);
            $loginFilter = resolve_login_identifier_scope($pdo, $company_id);
            device_token_web_remember_issue($pdo, 'owner', (int) $owner['id']);
            echo json_encode([
                'status' => 'success',
                'redirect' => '/owner-secondary-password',
                'user_type' => 'owner',
                'company_id' => (int) ($_SESSION['company_id'] ?? 0) ?: null,
                'login_scope' => $loginFilter['scope'],
                'login_identifier' => $loginFilter['identifier'],
            ]);
        } else {
            // Phase 1: Owner owns groups row with zero companies
            $gtOwner = function_exists('gt_v2_try_authenticate_owner')
                ? gt_v2_try_authenticate_owner($pdo, $login_id, $password, $company_id)
                : ['ok' => false];
            if (!empty($gtOwner['ok']) && !empty($gtOwner['owner']) && !empty($gtOwner['group'])) {
                $owner = $gtOwner['owner'];
                $groupRow = $gtOwner['group'];
                $passwordForFingerprint = (string) ($owner['password'] ?? '');
                if (!empty($gtOwner['upgrade_plain'])) {
                    $hashed_password = secure_hash_password($password);
                    $pdo->prepare('UPDATE owner SET password = ? WHERE id = ?')->execute([$hashed_password, $owner['id']]);
                    $passwordForFingerprint = $hashed_password;
                } else {
                    $ownerRehashed = maybe_rehash_password($password, $passwordForFingerprint);
                    if ($ownerRehashed !== null) {
                        $pdo->prepare('UPDATE owner SET password = ? WHERE id = ?')->execute([$ownerRehashed, $owner['id']]);
                        $passwordForFingerprint = $ownerRehashed;
                    }
                }

                $_SESSION['user_id'] = $owner['id'];
                session_user_payload_cache_clear();
                $_SESSION['login_id'] = $owner['owner_code'];
                $_SESSION['name'] = $owner['name'];
                $_SESSION['role'] = 'owner';
                $_SESSION['user_type'] = 'owner';
                $_SESSION['owner_id'] = $owner['id'];
                $_SESSION['real_owner_id'] = $owner['id'];
                $_SESSION['owner_code'] = $owner['owner_code'];
                $_SESSION['company_id'] = null;
                $_SESSION['company_code'] = gt_v2_normalize_group_code((string) ($groupRow['group_code'] ?? $company_id));
                $_SESSION['last_activity'] = time();
                unset($_SESSION['secondary_password_verified']);

                auth_store_password_fingerprint($passwordForFingerprint);
                gt_v2_apply_group_login_session($groupRow, $company_id);
                $loginFilter = resolve_login_identifier_scope($pdo, $company_id);
                device_token_web_remember_issue($pdo, 'owner', (int) $owner['id']);
                echo json_encode([
                    'status' => 'success',
                    'redirect' => '/owner-secondary-password',
                    'user_type' => 'owner',
                    'company_id' => null,
                    'login_scope' => $loginFilter['scope'],
                    'login_identifier' => $loginFilter['identifier'],
                ]);
            } elseif (!empty($gtOwner['password_match']) && !empty($gtOwner['expired'])) {
                echo json_encode(['status' => 'error', 'message' => 'Company or Group has expired.']);
            } elseif ($owner_password_match && $owner_has_expired) {
                echo json_encode(['status' => 'error', 'message' => 'Company or Group has expired.']);
            } else {
                echo json_encode(['status' => 'error', 'message' => 'Username or password is incorrect']);
            }
        }
    }
    } else {
        echo json_encode(['status' => 'error', 'message' => 'Invalid request']);
    }
} catch (PDOException $e) {
    // 数据库错误
    error_log("Login PDO Error: " . $e->getMessage());
    echo json_encode(['status' => 'error', 'message' => 'Database error, please try again later']);
} catch (Exception $e) {
    // 其他错误
    error_log("Login Error: " . $e->getMessage());
    echo json_encode(['status' => 'error', 'message' => 'An error occurred during login: ' . $e->getMessage()]);
}

// 清除输出缓冲并发送输出
ob_end_flush();
?>
