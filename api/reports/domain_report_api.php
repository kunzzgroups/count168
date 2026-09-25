<?php
/**
 * Domain Report API - 按 Process 汇总 Domain 报表（Turnover / Win / Lose）
 * 路径: api/reports/domain_report_api.php
 */

session_start();
session_write_close(); // 释放 session 锁，允许并发 AJAX 请求并行执行
header('Content-Type: application/json');
require_once __DIR__ . '/../../includes/config.php';
require_once __DIR__ . '/../includes/money_decimal.php';
require_once __DIR__ . '/report_scope_common.php';
require_once __DIR__ . '/../datacapture/data_capture_scope_common.php';

function domainReportMoneyOut($value): string {
    return money_out($value ?? '0');
}

/**
 * 标准 JSON 响应：success, message, data
 */
function jsonResponse($success, $message, $data = null, $httpCode = null) {
    if ($httpCode !== null) {
        http_response_code($httpCode);
    }
    echo json_encode([
        'success' => (bool) $success,
        'message' => $message,
        'data' => $data
    ], JSON_UNESCAPED_UNICODE);
}

/**
 * Align Domain Report scope with dual-tenant capture (group → groups.id, company → company.id).
 *
 * @return array<string, mixed>
 */
function resolveDomainReportCaptureScope(PDO $pdo, array $resolved, array $get): array
{
    return resolveReportDualTenantCaptureScope($pdo, $resolved, $get);
}

/** Group Domain Report: ensure PROFIT + SALARY + COMMISSION + BONUS on entity, then return rows. */
function fetchGroupDomainProcesses(PDO $pdo, int $company_id, string $groupId): array
{
    $g = reportNormalizeGroupId($groupId);
    foreach (dcGroupPayrollProcessCodes() as $code) {
        dcEnsureProcessIdByCode($pdo, $company_id, $code, true, $g !== '' ? $g : null);
    }
    return fetchProcesses($pdo, $company_id, true);
}

/**
 * 查询 Process 列表（id, process_id, description）
 */
function fetchProcesses(PDO $pdo, int $company_id, bool $groupScope = false) {
    $sql = "
        SELECT p.id, p.process_id, d.name AS description
        FROM process p
        LEFT JOIN description d ON p.description_id = d.id
        WHERE p.company_id = ?
          AND p.status IN ('active','inactive')
    ";
    if ($groupScope) {
        $sql .= dcSqlGroupProcessFilter('p');
    } else {
        $sql .= dcSqlCompanyProcessFilter('p');
    }
    $sql .= ' ' . dcSqlOrderByGroupPayrollProcessField('UPPER(TRIM(p.process_id))') . ', p.process_id ASC';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$company_id]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/**
 * 格式化为前端下拉所需结构
 */
function formatProcesses(array $processes, bool $groupScope = false) {
    return array_map(function ($row) use ($groupScope) {
        $code = strtoupper(trim((string) ($row['process_id'] ?? '')));
        $label = $groupScope
            ? $code
            : $row['process_id'];
        if (!$groupScope && !empty($row['description'])) {
            $label .= ' (' . $row['description'] . ')';
        }
        return [
            'id' => (int) $row['id'],
            'process' => $row['process_id'],
            'description' => $row['description'],
            'display_text' => $label,
        ];
    }, $processes);
}

/**
 * 与 Transaction 列表一致：公司代码 + 集团 ID（大写）。
 */
function fetchCompanyReportMeta(PDO $pdo, int $company_id): array {
    $stmt = $pdo->prepare("SELECT company_id, group_id FROM company WHERE id = ? LIMIT 1");
    $stmt->execute([$company_id]);
    $r = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$r) {
        return ['company_id' => null, 'group_id' => null];
    }
    $cid = isset($r['company_id']) ? strtoupper(trim((string) $r['company_id'])) : '';
    $gidRaw = $r['group_id'] ?? null;
    $gid = ($gidRaw !== null && trim((string) $gidRaw) !== '')
        ? strtoupper(trim((string) $gidRaw)) : null;
    return [
        'company_id' => $cid !== '' ? $cid : null,
        'group_id' => $gid,
    ];
}

/**
 * 查询 Domain 报表原始行（按 Process 汇总 Turnover / Win / Lose）
 * 以 process 为主表，无数据的 process 也显示（0）；过滤 dcd.company_id 保证 Win/Lose 只计当前公司
 */
function fetchDomainReportRows(
    PDO $pdo,
    array $scopeCtx,
    string $date_from,
    string $date_to,
    ?int $process_id,
    array $currency_codes = []
) {
    $currency_codes = array_values(array_filter(array_map(
        static fn($code) => strtoupper(trim((string)$code)),
        $currency_codes
    )));

    $ledgerDc = dcBuildCaptureLedgerFilter($pdo, $scopeCtx, 'dc', 'data_captures');
    $ledgerDcd = dcBuildCaptureLedgerFilter($pdo, $scopeCtx, 'dcd', 'data_capture_details');
    $processCompanyId = dcCaptureProcessCompanyId($scopeCtx);
    $companyId = (int) ($scopeCtx['company_id'] ?? 0);
    $scopeProcessSql = (string) ($scopeCtx['scope_process_sql'] ?? '');
    $isGroupScope = !empty($scopeCtx['is_group_scope']);
    $groupScopeId = (int) ($scopeCtx['group_scope_id'] ?? $scopeCtx['scope_id'] ?? 0);

    $sql = "
        SELECT 
            p.id AS process_pk,
            p.process_id,
            d.name AS description_name,
            COALESCE(SUM(ABS(dcd.processed_amount)), 0) AS turnover_total,
            COALESCE(SUM(CASE WHEN dcd.processed_amount > 0 THEN dcd.processed_amount ELSE 0 END), 0) AS win_total,
            COALESCE(SUM(CASE WHEN dcd.processed_amount < 0 THEN ABS(dcd.processed_amount) ELSE 0 END), 0) AS lose_total
        FROM process p
        LEFT JOIN description d ON p.description_id = d.id
        LEFT JOIN data_captures dc ON dc.process_id = p.id
          AND dc.capture_date BETWEEN ? AND ?
          {$ledgerDc['sql']}
        LEFT JOIN data_capture_details dcd ON dcd.capture_id = dc.id
          {$ledgerDcd['sql']}
    ";
    $params = array_merge(
        [$date_from, $date_to],
        dcCaptureLedgerBindParams($ledgerDc),
        dcCaptureLedgerBindParams($ledgerDcd)
    );

    if (!empty($currency_codes)) {
        $placeholders = implode(',', array_fill(0, count($currency_codes), '?'));
        if ($isGroupScope && !empty($scopeCtx['dual_tenant']) && $groupScopeId > 0) {
            $sql .= "
          AND dcd.currency_id IN (
              SELECT c.id
              FROM currency c
              WHERE c.scope_type = 'group'
                AND c.scope_id = ?
                AND UPPER(c.code) IN ($placeholders)
          )
        ";
            $params[] = $groupScopeId;
        } else {
            $sql .= "
          AND dcd.currency_id IN (
              SELECT c.id
              FROM currency c
              WHERE c.company_id = ?
                AND (COALESCE(c.scope_type, '') = '' OR c.scope_type = 'company')
                AND UPPER(c.code) IN ($placeholders)
          )
        ";
            $params[] = $companyId;
        }
        foreach ($currency_codes as $code) {
            $params[] = $code;
        }
    }

    $sql .= "
        WHERE p.company_id = ?
          AND p.status IN ('active','inactive')
    ";
    $params[] = $processCompanyId;
    $sql .= $scopeProcessSql !== '' ? $scopeProcessSql : dcSqlCompanyProcessFilter('p');
    if ($process_id !== null && $process_id > 0) {
        $sql .= " AND p.id = ? ";
        $params[] = $process_id;
    }
    $sql .= ' GROUP BY p.id, p.process_id, d.name ' . dcSqlOrderByGroupPayrollProcessField('UPPER(TRIM(p.process_id))') . ', p.process_id ASC ';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

/**
 * 将原始行转为报表数据并计算合计
 * @param array $company_meta group_id / company_id 展示字段（与 Transaction 一致）
 * @param string $currency_scope 当前筛选下的币种范围标签（ALL 或逗号分隔代码）
 */
function buildReportResult(array $rows, string $date_from, string $date_to, array $company_meta, string $currency_scope) {
    $report_data = [];
    $total_turnover = '0.00000000';
    $total_win = '0.00000000';
    $total_lose = '0.00000000';

    foreach ($rows as $row) {
        $turnover = domainReportMoneyOut($row['turnover_total'] ?? '0');
        $win = domainReportMoneyOut($row['win_total'] ?? '0');
        $lose = domainReportMoneyOut($row['lose_total'] ?? '0');
        $winLose = domainReportMoneyOut(money_sub($win, $lose));

        $report_data[] = [
            'process_id' => (int)$row['process_pk'],
            'process' => $row['process_id'],
            'description' => $row['description_name'],
            'group_id' => $company_meta['group_id'] ?? null,
            'company_id' => $company_meta['company_id'] ?? null,
            'currency' => $currency_scope,
            'turnover' => $turnover,
            'win' => $win,
            'lose' => $lose,
            'win_lose' => $winLose
        ];

        $total_turnover = money_add($total_turnover, $turnover);
        $total_win = money_add($total_win, $win);
        $total_lose = money_add($total_lose, $lose);
    }

    return [
        'report_data' => $report_data,
        'totals' => [
            'turnover' => domainReportMoneyOut($total_turnover),
            'win' => domainReportMoneyOut($total_win),
            'lose' => domainReportMoneyOut($total_lose),
            'win_lose' => domainReportMoneyOut(money_sub($total_win, $total_lose))
        ],
        'date_from' => $date_from,
        'date_to' => $date_to
    ];
}

try {
    if (!isset($_SESSION['user_id'])) {
        throw new Exception('用户未登录');
    }

    $action = isset($_GET['action']) ? trim($_GET['action']) : '';
    // Process picker for capture/maintenance may target bank-only subsidiaries (e.g. CX).
    $scopeCategory = ($action === 'processes') ? 'maintenance' : 'games';
    $resolved = resolveReportRequestCompanyScope($pdo, $_GET, $scopeCategory);
    $scopeCtx = resolveDomainReportCaptureScope($pdo, $resolved, $_GET);
    $company_id = (int) ($scopeCtx['company_id'] ?? 0);
    $groupScope = (bool) ($scopeCtx['group_scope'] ?? $scopeCtx['is_group_scope'] ?? false);
    $processCompanyId = dcCaptureProcessCompanyId($scopeCtx);

    if ($action === 'processes') {
        if ($groupScope) {
            $groupIdForProcesses = reportNormalizeGroupId(
                $resolved['group_id'] ?? ($_GET['group_id'] ?? '')
            );
            $processes = fetchGroupDomainProcesses($pdo, $company_id, $groupIdForProcesses);
            $formatted = formatProcesses($processes, true);
        } else {
            if ($company_id > 0 && dcCompanyIdIsGroupEntity($pdo, $company_id)) {
                $formatted = [];
            } else {
                $processes = fetchProcesses($pdo, $company_id, false);
                $formatted = formatProcesses($processes, false);
            }
        }
        echo json_encode([
            'success' => true,
            'message' => 'OK',
            'data' => $formatted
        ]);
        exit;
    }

    $date_from = isset($_GET['date_from']) ? trim($_GET['date_from']) : '';
    $date_to = isset($_GET['date_to']) ? trim($_GET['date_to']) : '';
    $process_id_raw = $_GET['process_id'] ?? '';
    $process_id = ($process_id_raw !== '' && (int) $process_id_raw > 0) ? (int) $process_id_raw : null;
    $currency_raw = isset($_GET['currency']) ? trim((string)$_GET['currency']) : '';
    $currency_codes = $currency_raw !== '' ? explode(',', $currency_raw) : [];

    if (empty($date_from) || empty($date_to)) {
        throw new Exception('开始日期和结束日期不能为空');
    }

    $date_from_obj = DateTime::createFromFormat('Y-m-d', $date_from);
    $date_to_obj = DateTime::createFromFormat('Y-m-d', $date_to);
    if (!$date_from_obj || !$date_to_obj) {
        throw new Exception('日期格式不正确，请使用 YYYY-MM-DD');
    }
    if ($date_from_obj > $date_to_obj) {
        throw new Exception('开始日期不能大于结束日期');
    }

    if ($process_id !== null && $process_id > 0 && $processCompanyId > 0) {
        dcAssertProcessIdInCaptureScope($pdo, $process_id, $processCompanyId, $groupScope);
    }

    // Pure group + dual-tenant: company_id may be 0; ledger uses scope_type/scope_id.
    $groupPk = (int) ($scopeCtx['group_scope_id'] ?? $scopeCtx['scope_id'] ?? 0);
    if ($groupScope && $company_id <= 0 && (empty($scopeCtx['dual_tenant']) || $groupPk <= 0)) {
        echo json_encode([
            'success' => true,
            'message' => 'OK',
            'data' => [],
            'totals' => [
                'turnover' => domainReportMoneyOut('0'),
                'win' => domainReportMoneyOut('0'),
                'lose' => domainReportMoneyOut('0'),
                'win_lose' => domainReportMoneyOut('0'),
            ],
            'date_from' => $date_from,
            'date_to' => $date_to,
        ]);
        exit;
    }

    if (!$groupScope && $company_id > 0 && dcCompanyIdIsGroupEntity($pdo, $company_id)) {
        echo json_encode([
            'success' => true,
            'message' => 'OK',
            'data' => [],
            'totals' => [
                'turnover' => domainReportMoneyOut('0'),
                'win' => domainReportMoneyOut('0'),
                'lose' => domainReportMoneyOut('0'),
                'win_lose' => domainReportMoneyOut('0'),
            ],
            'date_from' => $date_from,
            'date_to' => $date_to,
        ]);
        exit;
    }

    $rows = fetchDomainReportRows(
        $pdo,
        $scopeCtx,
        $date_from,
        $date_to,
        $process_id,
        $currency_codes
    );
    $co_meta = $company_id > 0
        ? fetchCompanyReportMeta($pdo, $company_id)
        : [
            'company_id' => null,
            'group_id' => reportNormalizeGroupId($resolved['group_id'] ?? ($scopeCtx['group_id'] ?? '')),
        ];
    $currency_scope = 'ALL';
    if (!empty($currency_codes)) {
        $currency_scope = implode(', ', $currency_codes);
    }
    $result = buildReportResult($rows, $date_from, $date_to, $co_meta, $currency_scope);

    echo json_encode([
        'success' => true,
        'message' => 'OK',
        'data' => $result['report_data'],
        'totals' => $result['totals'],
        'date_from' => $result['date_from'],
        'date_to' => $result['date_to']
    ]);
} catch (PDOException $e) {
    http_response_code(500);
    error_log('Domain Report API Error: ' . $e->getMessage());
    echo json_encode([
        'success' => false,
        'message' => '数据库查询失败',
        'data' => null
    ]);
} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage(),
        'data' => null
    ]);
}