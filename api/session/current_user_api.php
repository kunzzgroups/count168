<?php
/**
 * Current session user (SPA bootstrap). Read-only; releases session lock quickly.
 */
session_start();
header('Content-Type: application/json; charset=utf-8');

$pdo = null;
try {
    require_once __DIR__ . '/../../includes/config.php';
    require_once __DIR__ . '/../c168/c168_domain_access.php';
    require_once __DIR__ . '/../includes/partnership_audit_readonly.php';
    require_once __DIR__ . '/../includes/member_linked_closure.php';
    require_once __DIR__ . '/../../includes/expiration_status.php';
    require_once __DIR__ . '/../../includes/group_company_access.php';
    require_once __DIR__ . '/../../includes/group_tenant_v2.php';
    require_once __DIR__ . '/../../includes/session_user_payload_cache.php';
    require_once __DIR__ . '/../../includes/auth_invalidation.php';
    require_once __DIR__ . '/../../includes/maintenance_gate.php';
    require_once __DIR__ . '/../../includes/company_expiration.php';
    require_once __DIR__ . '/../../includes/device_token.php';
} catch (Throwable $e) {
    // Do not fail bootstrap because of DB wiring errors; session data is still enough for routing.
    error_log('current_user_api config load failed: ' . $e->getMessage());
}

if (!isset($_SESSION['user_id']) && isset($_COOKIE['remember_token']) && $pdo instanceof PDO) {
    try {
        $rememberToken = (string) $_COOKIE['remember_token'];
        $stmt = $pdo->prepare("SELECT * FROM user WHERE remember_token = ? AND remember_token_expires > NOW() AND status = 'active'");
        $stmt->execute([$rememberToken]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($user) {
            $_SESSION['user_id'] = (int) $user['id'];
            $_SESSION['login_id'] = (string) ($user['login_id'] ?? '');
            $_SESSION['name'] = (string) ($user['name'] ?? '');
            $_SESSION['role'] = (string) ($user['role'] ?? '');
            $_SESSION['user_type'] = 'user';

            $companyStmt = $pdo->prepare("
                SELECT c.id, c.company_id
                FROM company c
                INNER JOIN user_company_map ucm ON c.id = ucm.company_id
                WHERE ucm.user_id = ?
                ORDER BY c.company_id ASC
                LIMIT 1
            ");
            $companyStmt->execute([(int) $user['id']]);
            $company = $companyStmt->fetch(PDO::FETCH_ASSOC);

            $companyId = $company['id'] ?? ($user['company_id'] ?? null);
            $_SESSION['company_id'] = $companyId ? (int) $companyId : null;
            $_SESSION['company_code'] = isset($company['company_id']) ? (string) $company['company_id'] : (string) ($_SESSION['company_code'] ?? '');
            $_SESSION['last_activity'] = time();

            $updateStmt = $pdo->prepare("UPDATE user SET last_login = NOW() WHERE id = ?");
            $updateStmt->execute([(int) $user['id']]);
            $_SESSION['read_only'] = isset($user['read_only']) ? (int) $user['read_only'] : 1;
            session_user_payload_cache_clear();
            if (!empty($user['password'])) {
                auth_store_password_fingerprint((string) $user['password']);
            }
        }
        // 查不到 user 时**不在这里清 cookie** —— owner / member 还要靠同一个
        // cookie 走下面的 device_token 回退（见 ② ）。清了回退就拿不到 cookie 了。
    } catch (Throwable $e) {
        error_log('current_user_api remember token failed: ' . $e->getMessage());
    }

    // ── ② 回退：owner / member 的 device_token（kind='web'）──────────────────
    // 这两种身份此前完全没有可用的记住我：owner 是空壳分支
    // （login_api.php 里 if ($remember_me) { /* 注释 */ }），account 表根本没有
    // remember_token 那一列。放在旧路径**之后**，user 身份行为完全不变。
    if (!isset($_SESSION['user_id'])) {
        try {
            device_token_try_restore_from_cookie($pdo);
        } catch (Throwable $e) {
            error_log('current_user_api device token restore failed: ' . $e->getMessage());
        }
    }

    // ── ③ 两个机制都没认出来，才清 cookie ───────────────────────────
    if (!isset($_SESSION['user_id']) && isset($_COOKIE['remember_token'])) {
        setcookie('remember_token', '', time() - 3600, "/", "", false, true);
    }
}

if (!isset($_SESSION['user_id'])) {
    session_write_close();
    echo json_encode(['success' => false, 'message' => 'Not logged in', 'data' => null], JSON_UNESCAPED_UNICODE);
    exit;
}

if ($pdo instanceof PDO && auth_session_password_stale($pdo)) {
    auth_force_logout_session($pdo, true);
}

if ($pdo instanceof PDO) {
    maintenance_gate_enforce_active_session($pdo, true);
    maintenance_gate_force_it_c168_session($pdo);
}

$cachedPayload = function_exists('session_user_payload_cache_get')
    ? session_user_payload_cache_get(45)
    : null;
if ($cachedPayload !== null) {
    session_write_close();
    echo json_encode([
        'success' => true,
        'message' => '',
        'data' => $cachedPayload,
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$userType = strtolower((string) ($_SESSION['user_type'] ?? ''));
if ($userType === '') {
    $userType = isset($_SESSION['role']) && strtolower((string) $_SESSION['role']) === 'owner' ? 'owner' : 'user';
}

$needsOwnerSecondary = ($userType === 'owner')
    && (!isset($_SESSION['secondary_password_verified']) || $_SESSION['secondary_password_verified'] !== true);
$needsUserSecondary = false;

$companyId = isset($_SESSION['company_id']) ? (int) $_SESSION['company_id'] : null;
$expirationHint = 'No expiration date';
$expirationStatus = 'normal';
$companyExpirationDateRaw = null;
$daysUntilExpiration = null;
$companyCodeForResponse = strtoupper(trim((string) ($_SESSION['company_code'] ?? '')));
$permissions = [];
$isCurrentCompanyC168 = false;
$hasC168DomainPageAccess = false;
$hasC168AutoRenewAccess = false;
$pendingAutoRenewCount = 0;
$companyHasGambling = false;
$companyHasBank = false;
$companyPermissionsList = [];
$readOnlyForClient = isset($_SESSION['read_only']) ? (int) $_SESSION['read_only'] : 0;

if ($pdo instanceof PDO && isset($_SESSION['user_id']) && function_exists('get_partnership_audit_read_only_flag')) {
    try {
        $readOnlyForClient = get_partnership_audit_read_only_flag($pdo);
    } catch (Throwable $e) {
        error_log('current_user_api read_only: ' . $e->getMessage());
    }
}

if ($companyId && $pdo instanceof PDO) {
    try {
        if ($userType !== 'member') {
            $stmtPerm = $pdo->prepare("SELECT permissions FROM user WHERE id = ?");
            $stmtPerm->execute([$_SESSION['user_id']]);
            $userPermissions = $stmtPerm->fetchColumn();
            $permissions = $userPermissions ? (json_decode((string) $userPermissions, true) ?: []) : [];
        }

        $companyCode = $companyCodeForResponse;
        if ($companyCode === '') {
            $stmtCode = $pdo->prepare('SELECT company_id FROM company WHERE id = ? LIMIT 1');
            $stmtCode->execute([$companyId]);
            $companyCode = strtoupper(trim((string) $stmtCode->fetchColumn()));
            $companyCodeForResponse = $companyCode;
        }
        if ($companyCode === 'C168') {
            $isCurrentCompanyC168 = true;
        } else {
            $stmtC168 = $pdo->prepare("SELECT COUNT(*) FROM company WHERE id = ? AND UPPER(company_id) = 'C168'");
            $stmtC168->execute([$companyId]);
            $isCurrentCompanyC168 = ((int) $stmtC168->fetchColumn()) > 0;
        }
        $hasC168DomainPageAccess = $isCurrentCompanyC168
            && userHasC168DomainPageAccess(strtolower((string) ($_SESSION['role'] ?? '')));
        $hasC168AutoRenewAccess = userHasC168AutoRenewAccess(
            $pdo,
            strtolower((string) ($_SESSION['role'] ?? '')),
            $userType
        );
        if ($hasC168AutoRenewAccess) {
            require_once __DIR__ . '/../includes/auto_renew.php';
            try {
                // Do not call auto_renew_ensure_request_table / sync_window here:
                // Hostinger metadata locks from ALTER/SHOW freeze the whole site.
                $pendingAutoRenewCount = auto_renew_count_pending_fast($pdo);
            } catch (Throwable $e) {
                error_log('current_user_api pending_auto_renew_count: ' . $e->getMessage());
            }
        }

        if ($userType === 'user' && $isCurrentCompanyC168) {
            $stmtUserSecondary = $pdo->prepare("SELECT secondary_password FROM user WHERE id = ?");
            $stmtUserSecondary->execute([$_SESSION['user_id']]);
            $secondaryPassword = $stmtUserSecondary->fetchColumn();
            $needsUserSecondary = !empty($secondaryPassword)
                && (!isset($_SESSION['secondary_password_verified']) || $_SESSION['secondary_password_verified'] !== true);
        }

        // Group login: fixed Games only for pure Group / group-entity.
        // Real subsidiary (e.g. Bank C2) uses that company's category so sidebar Report hides.
        if (
            function_exists('gt_v2_enabled')
            && gt_v2_enabled()
            && function_exists('gc_is_group_login')
            && gc_is_group_login()
            && function_exists('gt_v2_resolve_active_category_flags')
        ) {
            $flags = gt_v2_resolve_active_category_flags($pdo, (int) $companyId);
        } else {
            $flags = gc_resolve_company_category_flags($pdo, (int) $companyId);
        }
        $companyHasGambling = (bool) ($flags['has_gambling'] ?? false);
        $companyHasBank = (bool) ($flags['has_bank'] ?? false);
        $companyPermissionsList = is_array($flags['permissions'] ?? null)
            ? array_values($flags['permissions'])
            : [];

        $stmt = $pdo->prepare('SELECT expiration_date FROM company WHERE id = ?');
        $stmt->execute([$companyId]);
        $companyExpirationDate = $stmt->fetchColumn();
        $companyExpirationDateRaw = $companyExpirationDate ? (string) $companyExpirationDate : null;

        if ($companyExpirationDate) {
            $now = new DateTime();
            $now->setTime(0, 0, 0);
            $expiration = new DateTime((string) $companyExpirationDate);
            $expiration->setTime(0, 0, 0);

            $diff = $now->diff($expiration);
            $diffDays = (int) $diff->format('%r%a');
            $daysUntilExpiration = $diffDays;

            if ($diffDays < 0) {
                $expirationHint = 'Expired';
                $expirationStatus = 'expired';
            } elseif ($diffDays === 0) {
                $expirationHint = 'Expires today';
                $expirationStatus = company_expiration_status(0);
            } elseif ($diffDays <= 30) {
                $expirationHint = $diffDays . ' day' . ($diffDays > 1 ? 's' : '') . ' left';
                $expirationStatus = company_expiration_status($diffDays);
            } else {
                $months = (int) floor($diffDays / 30);
                $days = $diffDays % 30;
                if ($days === 0) {
                    $expirationHint = $months . ' month' . ($months > 1 ? 's' : '') . ' left';
                } else {
                    $expirationHint = $months . 'm ' . $days . 'd left';
                }
                $expirationStatus = 'normal';
            }
        }
    } catch (Throwable $e) {
        error_log('current_user_api expiration: ' . $e->getMessage());
        $expirationHint = 'No expiration date';
    }
} elseif (
    $pdo instanceof PDO
    && function_exists('gt_v2_enabled')
    && gt_v2_enabled()
    && function_exists('gc_is_group_login')
    && gc_is_group_login()
) {
    // Empty group login: no company_id — still expose Games flags + group expiry
    try {
        if ($userType === 'user') {
            $stmtPerm = $pdo->prepare('SELECT permissions FROM user WHERE id = ?');
            $stmtPerm->execute([$_SESSION['user_id']]);
            $userPermissions = $stmtPerm->fetchColumn();
            $permissions = $userPermissions ? (json_decode((string) $userPermissions, true) ?: []) : [];
        }
        $flags = gt_v2_fixed_games_category_flags();
        $companyHasGambling = true;
        $companyHasBank = false;
        $companyPermissionsList = $flags['permissions'];
        $ident = function_exists('gc_session_login_identifier')
            ? (string) (gc_session_login_identifier() ?? '')
            : (string) ($_SESSION['login_identifier'] ?? $_SESSION['company_code'] ?? '');
        if ($companyCodeForResponse === '' && $ident !== '') {
            $companyCodeForResponse = strtoupper(trim($ident));
        }
        $groupRow = gt_v2_fetch_active_group_row($pdo, $ident !== '' ? $ident : $companyCodeForResponse);
        if ($groupRow) {
            $expPayload = gt_v2_group_expiration_payload($groupRow);
            $companyExpirationDateRaw = $expPayload['expiration_date'];
            $daysUntilExpiration = $expPayload['days_until_expiration'];
            $expirationHint = $expPayload['expiration_hint'];
            $expirationStatus = $expPayload['expiration_status'];
        }
    } catch (Throwable $e) {
        error_log('current_user_api group-only flags: ' . $e->getMessage());
        $companyHasGambling = true;
        $companyHasBank = false;
        $companyPermissionsList = ['Games'];
    }
}

$memberLoginId = null;
$memberViewId = null;
$memberViewCode = '';
$memberViewName = '';
if ($userType === 'member' && $pdo instanceof PDO) {
    member_ensure_login_session_fields();
    $memberLoginId = member_session_canonical_account_id();
    $memberViewId = member_session_winloss_view_account_id();
    try {
        $accStmt = $pdo->prepare('SELECT account_id, name FROM account WHERE id = ? LIMIT 1');
        $accStmt->execute([$memberViewId]);
        $accRow = $accStmt->fetch(PDO::FETCH_ASSOC);
        if ($accRow) {
            $memberViewCode = (string) ($accRow['account_id'] ?? '');
            $memberViewName = (string) ($accRow['name'] ?? '');
        }
    } catch (Throwable $e) {
        error_log('current_user_api member view account lookup: ' . $e->getMessage());
    }
}

$responseUserId = isset($_SESSION['user_id']) ? (int) $_SESSION['user_id'] : null;
if ($userType === 'member' && $memberLoginId > 0) {
    $responseUserId = $memberLoginId;
}
$sessionName = (string) ($_SESSION['name'] ?? '');
$sessionLoginId = (string) ($_SESSION['login_id'] ?? '');

$assignedGroupCodes = [];
$assignedCompanyIds = [];
if ($pdo instanceof PDO && $userType !== 'member') {
    $sessionUserId = (int) ($_SESSION['user_id'] ?? 0);
    if ($sessionUserId > 0) {
        gc_hydrate_session_assigned_tenants($pdo);
        $assignedGroupCodes = gc_session_assigned_group_codes();
        $assignedCompanyIds = gc_session_assigned_company_ids();
    }
}

$payload = [
    'user_id' => $responseUserId,
    'member_login_account_id' => $memberLoginId,
    'member_winloss_view_account_id' => $memberViewId,
    'winloss_view_account_id' => $memberViewId,
    'account_code' => $memberViewCode,
    'account_name' => $memberViewName,
    'name' => $sessionName,
    'login_id' => $sessionLoginId,
    'role' => (string) ($_SESSION['role'] ?? ''),
    'user_type' => $userType,
    'permissions' => is_array($permissions) ? array_values($permissions) : [],
    'is_current_company_c168' => $isCurrentCompanyC168,
    'has_c168_domain_page_access' => $hasC168DomainPageAccess,
    'has_c168_auto_renew_access' => $hasC168AutoRenewAccess,
    'pending_auto_renew_count' => $pendingAutoRenewCount,
    'company_has_gambling' => $companyHasGambling,
    'company_has_bank' => $companyHasBank,
    'company_permissions' => is_array($companyPermissionsList) ? $companyPermissionsList : [],
    'company_id' => $companyId ?: null,
    'company_code' => $companyCodeForResponse !== '' ? $companyCodeForResponse : null,
    'login_scope' => isset($_SESSION['login_scope']) ? (string) $_SESSION['login_scope'] : null,
    'login_identifier' => isset($_SESSION['login_identifier'])
        ? (string) $_SESSION['login_identifier']
        : null,
    'login_group_id' => isset($_SESSION['login_group_id']) && trim((string) $_SESSION['login_group_id']) !== ''
        ? strtoupper(trim((string) $_SESSION['login_group_id']))
        : null,
    'login_group_scope_id' => isset($_SESSION['login_group_scope_id']) && (int) $_SESSION['login_group_scope_id'] > 0
        ? (int) $_SESSION['login_group_scope_id']
        : null,
    'accessible_group_ids' => gc_session_accessible_group_ids(),
    'assigned_group_codes' => $assignedGroupCodes,
    'assigned_company_ids' => $assignedCompanyIds,
    'can_use_group_ledger' => function_exists('gc_session_can_use_group_ledger')
        ? gc_session_can_use_group_ledger()
        : (gc_is_group_login() || $assignedGroupCodes !== []),
    'needs_owner_secondary' => $needsOwnerSecondary,
    'needs_user_secondary' => $needsUserSecondary,
    'expiration_date' => $companyExpirationDateRaw,
    'days_until_expiration' => $daysUntilExpiration,
    'expiration_hint' => $expirationHint,
    'expiration_status' => $expirationStatus,
    'read_only' => $readOnlyForClient,
];

if (function_exists('session_user_payload_cache_set')) {
    session_user_payload_cache_set($payload);
}

session_write_close();

echo json_encode([
    'success' => true,
    'message' => '',
    'data' => $payload,
], JSON_UNESCAPED_UNICODE);
