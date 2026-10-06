<?php
/**
 * device_token（移动端指纹解锁）回归测试。
 *
 * 用法：
 *   php scripts/test-device-token.php
 *
 * 安全性：只使用临时库 `c168_devtok_test`，每次运行前 DROP 重建，
 *        绝不连接或修改任何真实数据库。
 *
 * 为什么要留着这个脚本：
 *   1. 二级密码「必须重输」是安全底线，靠 device_token_excluded_session_keys()
 *      维持。将来若有人往 session 里加了键又想绕过二级密码，第 3 组会红。
 *   2. 三分支（owner/user/member）的 redirect 判定容易被误改，第 11 组会红。
 *   3. 迁移文件本身也在这里被执行，DDL 写错能立刻发现。
 */

$root = dirname(__DIR__);
$dbName = 'c168_devtok_test';
$migration = $root . '/database/migrations/20261006_add_device_token.sql';

if (!is_file($migration)) {
    fwrite(STDERR, "找不到迁移文件: $migration\n");
    exit(2);
}

$pass = 0;
$fail = 0;

function ok(string $name, bool $cond, string $detail = ''): void
{
    global $pass, $fail;
    if ($cond) {
        $pass++;
        echo "  PASS  $name\n";
    } else {
        $fail++;
        echo "  FAIL  $name" . ($detail !== '' ? "  <-- $detail" : '') . "\n";
    }
}

function clean(PDO $pdo): void
{
    $pdo->exec('DELETE FROM device_token');
}

$opt = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false];

try {
    $rootPdo = new PDO('mysql:host=127.0.0.1;charset=utf8mb4', 'root', '', $opt);
    $rootPdo->exec("DROP DATABASE IF EXISTS `$dbName`");
    $rootPdo->exec("CREATE DATABASE `$dbName` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo = new PDO("mysql:host=127.0.0.1;dbname=$dbName;charset=utf8mb4", 'root', '', $opt);
} catch (Throwable $e) {
    fwrite(STDERR, "无法连接本地 MySQL: " . $e->getMessage() . "\n");
    exit(2);
}

require_once $root . '/includes/device_token.php';
require_once $root . '/includes/company_expiration.php';   // device_token_company_expired 依赖它

echo "=== 0. 迁移文件可直接执行 ===\n";
// 演练真实升级路径：先跑**不含 kind** 的基础迁移（模拟已存在的旧表），
// 再由 ensure_kind_column() 自动补列，最后确认 kind 迁移脚本本身幂等。
$sql = file_get_contents($migration);
$pdo->exec($sql);
ok('基础迁移文件执行成功', true);
$cols = $pdo->query("SHOW COLUMNS FROM device_token")->fetchAll(PDO::FETCH_COLUMN);
foreach (['user_type', 'user_id', 'token_hash', 'device_id', 'device_name',
          'session_snapshot', 'expires_at', 'last_used_at', 'last_used_ip',
          'revoked_at', 'created_at'] as $c) {
    ok("列 $c 存在", in_array($c, $cols, true));
}
$idx = $pdo->query("SHOW INDEX FROM device_token")->fetchAll(PDO::FETCH_ASSOC);
$idxNames = array_unique(array_column($idx, 'Key_name'));
ok('uk_token_hash 存在', in_array('uk_token_hash', $idxNames, true));
ok('uk_device 存在', in_array('uk_device', $idxNames, true));
$enum = $pdo->query("SHOW COLUMNS FROM device_token LIKE 'user_type'")->fetch(PDO::FETCH_ASSOC);
ok('user_type 覆盖 owner/user/member 三种身份',
    strpos((string) $enum['Type'], "'owner'") !== false
    && strpos((string) $enum['Type'], "'member'") !== false);

// 基础迁移不含 kind（升级前状态）
ok('（前置）旧表尚无 kind 列', !in_array('kind', $cols, true));

device_token_ensure_table($pdo);
$colsAfter = $pdo->query("SHOW COLUMNS FROM device_token")->fetchAll(PDO::FETCH_COLUMN);
ok('ensure_table 自动补上 kind 列', in_array('kind', $colsAfter, true));
$kindCol = $pdo->query("SHOW COLUMNS FROM device_token LIKE 'kind'")->fetch(PDO::FETCH_ASSOC);
ok('kind 默认值为 biometric', strpos((string) $kindCol['Default'], 'biometric') !== false);
device_token_ensure_kind_column($pdo);
ok('重复补列不报错（幂等）', true);

// kind 迁移脚本自身幂等（列已存在时应跳过而不是 Duplicate column）
$kindMigrationFile = $root . '/database/migrations/20261006_add_device_token_kind.sql';
function run_sql_file(PDO $pdo, string $path): void
{
    $raw = file_get_contents($path);
    $lines = array_filter(
        array_map('trim', explode("\n", $raw)),
        static fn($l) => $l !== '' && strpos($l, '--') !== 0
    );
    foreach (explode(';', implode("\n", $lines)) as $stmt) {
        $stmt = trim($stmt);
        if ($stmt === '') {
            continue;
        }
        // 用 query() 而非 exec()：PREPARE/EXECUTE 会产生结果集，
        // 不排空的话下一条会报 "other unbuffered queries are active"。
        $res = $pdo->query($stmt);
        if ($res instanceof PDOStatement) {
            $res->fetchAll();
            $res->closeCursor();
        }
    }
}
run_sql_file($pdo, $kindMigrationFile);
ok('kind 迁移脚本在列已存在时可重复执行', true);
run_sql_file($pdo, $kindMigrationFile);
ok('kind 迁移脚本连续执行两次也不报错', true);

// ── 桩表 ────────────────────────────────────────────────────────────
$pdo->exec("CREATE TABLE owner (
    id INT PRIMARY KEY, owner_code VARCHAR(50), name VARCHAR(150), status VARCHAR(20))");
$pdo->exec("CREATE TABLE user (
    id INT PRIMARY KEY, login_id VARCHAR(50), name VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active', secondary_password VARCHAR(255) NULL)");
$pdo->exec("CREATE TABLE account (
    id INT PRIMARY KEY, account_id VARCHAR(50), name VARCHAR(100), status VARCHAR(20))");
$pdo->exec("CREATE TABLE company (
    id INT PRIMARY KEY, company_id VARCHAR(50), group_id VARCHAR(50) NULL,
    expiration_date DATETIME NULL)");

$pdo->exec("INSERT INTO owner VALUES (7,'K','BOSS','active')");
$pdo->exec("INSERT INTO user (id,login_id,name,status,secondary_password) VALUES
    (11,'alice','Alice','active','\$2y\$10\$abc'),
    (12,'bob','Bob','active',NULL),
    (13,'carol','Carol','inactive',NULL)");
$pdo->exec("INSERT INTO account VALUES (21,'ACC1','Member One','active')");
$pdo->exec("INSERT INTO company VALUES
    (1,'C168',NULL,'2099-01-01 00:00:00'),
    (2,'BANK',NULL,'2099-01-01 00:00:00')");

echo "\n=== 1. 建表幂等 ===\n";
device_token_ensure_table($pdo);
device_token_ensure_table($pdo);
ok('ensure_table 可重复调用', true);

echo "\n=== 2. 基础工具函数 ===\n";
ok('hash 为 64 位 hex', strlen(device_token_hash('x')) === 64);
ok('normalize user_type 合法值', device_token_normalize_user_type('OWNER') === 'owner');
ok('normalize user_type 非法值→空', device_token_normalize_user_type('hacker') === '');
ok('normalize user_type null→空', device_token_normalize_user_type(null) === '');

echo "\n=== 3. 会话快照：排除表 + 双保险（安全底线）===\n";
$_SESSION = [
    'user_id' => 11, 'user_type' => 'user', 'role' => 'admin', 'company_id' => 1,
    'company_code' => 'C168', 'login_id' => 'alice',
    'secondary_password_verified' => true,      // 必须被排除
    'last_activity' => 12345,                   // 必须被排除
    'password_fingerprint' => 'SECRETHASH',     // 必须被排除
    '_spa_user_payload_cache' => ['junk'],      // 必须被排除
    'assigned_company_ids' => [1, 2],           // 数组应保留
];
$snap = device_token_capture_session();
ok('排除 secondary_password_verified', !array_key_exists('secondary_password_verified', $snap));
ok('排除 last_activity', !array_key_exists('last_activity', $snap));
ok('排除 password_fingerprint', !array_key_exists('password_fingerprint', $snap));
ok('排除 _ 前缀缓存', !array_key_exists('_spa_user_payload_cache', $snap));
ok('保留标量 user_id', ($snap['user_id'] ?? null) === 11);
ok('保留数组 assigned_company_ids', ($snap['assigned_company_ids'] ?? null) === [1, 2]);

$_SESSION = ['junk' => 1];
device_token_restore_session($snap + ['secondary_password_verified' => true]);
ok('还原后不含 secondary_password_verified', !isset($_SESSION['secondary_password_verified']));
ok('还原后无残留旧键 junk', !isset($_SESSION['junk']));
ok('还原后 user_id 正确', ($_SESSION['user_id'] ?? null) === 11);
ok('还原后 last_activity 已刷新', ($_SESSION['last_activity'] ?? 0) > 12345);

echo "\n=== 4. 签发 / 校验 ===\n";
clean($pdo);
$r = device_token_issue($pdo, 'user', 11, 'devAAA', 'Xiaomi 14', $snap);
ok('签发出 64 位 hex 令牌', $r['ok'] && preg_match('/^[0-9a-f]{64}$/', $r['token']));
ok('返回 expires_at', $r['ok'] && $r['expires_at'] !== '');
$t1 = $r['token'];

ok('正确令牌+设备 → ok', device_token_resolve($pdo, $t1, 'devAAA')['ok']);
ok('错误 device_id → TOKEN_INVALID',
    device_token_resolve($pdo, $t1, 'devOTHER')['code'] === 'TOKEN_INVALID');
ok('格式非法令牌 → TOKEN_INVALID',
    device_token_resolve($pdo, 'nothex', 'devAAA')['code'] === 'TOKEN_INVALID');
ok('未知但格式合法 → TOKEN_INVALID',
    device_token_resolve($pdo, str_repeat('a', 64), 'devAAA')['code'] === 'TOKEN_INVALID');
ok('空 device_id → TOKEN_INVALID', device_token_resolve($pdo, $t1, '')['code'] === 'TOKEN_INVALID');

echo "\n=== 5. 同设备重复开启 = 覆盖，不占名额 ===\n";
$r2 = device_token_issue($pdo, 'user', 11, 'devAAA', 'Xiaomi 14', $snap);
ok('重复签发成功', $r2['ok']);
ok('旧令牌已失效', !device_token_resolve($pdo, $t1, 'devAAA')['ok']);
ok('新令牌可用', device_token_resolve($pdo, $r2['token'], 'devAAA')['ok']);
$n = (int) $pdo->query('SELECT COUNT(*) FROM device_token WHERE user_id=11')->fetchColumn();
ok('同设备仍只有 1 行', $n === 1, "实际 $n");

echo "\n=== 6. 设备数上限 5 ===\n";
clean($pdo);
$tokens = [];
for ($i = 1; $i <= 5; $i++) {
    $ri = device_token_issue($pdo, 'user', 11, "dev$i", "Phone $i", $snap);
    if ($ri['ok']) {
        $tokens[$i] = $ri['token'];
    }
}
ok('5 台全部签发成功', count($tokens) === 5, '实际 ' . count($tokens));
$r6 = device_token_issue($pdo, 'user', 11, 'dev6', 'Phone 6', $snap);
ok('第 6 台 → DEVICE_LIMIT', !$r6['ok'] && $r6['code'] === 'DEVICE_LIMIT', $r6['code'] ?? '');
ok('第 6 台未落库',
    (int) $pdo->query('SELECT COUNT(*) FROM device_token WHERE user_id=11')->fetchColumn() === 5);
ok('达上限时原有设备仍可用', device_token_resolve($pdo, $tokens[1], 'dev1')['ok']);
ok('达上限时未被自动踢掉（多设备硬需求）', device_token_count_active($pdo, 'user', 11) === 5);

echo "\n=== 7. 吊销 ===\n";
ok('吊销 1 台返回 1', device_token_revoke($pdo, 'user', 11, 'dev1') === 1);
ok('被吊销 → TOKEN_REVOKED',
    device_token_resolve($pdo, $tokens[1], 'dev1')['code'] === 'TOKEN_REVOKED');
ok('活跃数降为 4', device_token_count_active($pdo, 'user', 11) === 4);
$r7 = device_token_issue($pdo, 'user', 11, 'dev7', 'Phone 7', $snap);
ok('腾出名额后可再签发', $r7['ok'], $r7['code'] ?? '');
ok('全部吊销返回 5', device_token_revoke($pdo, 'user', 11, null) === 5);
ok('全吊销后活跃数为 0', device_token_count_active($pdo, 'user', 11) === 0);
ok('全吊销后令牌不可用', !device_token_resolve($pdo, $r7['token'], 'dev7')['ok']);

echo "\n=== 8. 过期 ===\n";
clean($pdo);
$r8 = device_token_issue($pdo, 'user', 11, 'devX', 'X', $snap);
$pdo->exec('UPDATE device_token SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY)');
ok('已过期 → TOKEN_EXPIRED',
    device_token_resolve($pdo, $r8['token'], 'devX')['code'] === 'TOKEN_EXPIRED');
ok('过期后不计入活跃数', device_token_count_active($pdo, 'user', 11) === 0);

echo "\n=== 9. touch / list ===\n";
clean($pdo);
$_SERVER['REMOTE_ADDR'] = '203.0.113.7';   // CLI 下不存在，手动补上才能验证 IP 写入
device_token_issue($pdo, 'user', 11, 'devT', 'Touch Me', $snap);
$id = (int) $pdo->query("SELECT id FROM device_token WHERE device_id='devT'")->fetchColumn();
ok('使用前 last_used_at 为空',
    $pdo->query("SELECT last_used_at FROM device_token WHERE id=$id")->fetchColumn() === null);
device_token_touch($pdo, $id);
ok('touch 后 last_used_at 已写',
    $pdo->query("SELECT last_used_at FROM device_token WHERE id=$id")->fetchColumn() !== null);
$ipRaw = $pdo->query("SELECT last_used_ip FROM device_token WHERE id=$id")->fetchColumn();
ok('touch 把 IPv4 存成 4 字节', $ipRaw !== null && strlen($ipRaw) === 4);
ok('touch 存的 IP 可反解', $ipRaw !== null && inet_ntop($ipRaw) === '203.0.113.7');
$list = device_token_list($pdo, 'user', 11);
ok('list 返回 1 条', count($list) === 1);
ok('list 标记 is_active=1', (int) $list[0]['is_active'] === 1);
device_token_revoke($pdo, 'user', 11, 'devT');
$list = device_token_list($pdo, 'user', 11);
ok('吊销后 is_active=0', (int) $list[0]['is_active'] === 0);

echo "\n=== 10. 身份查询（三分支）===\n";
$p = device_token_fetch_principal($pdo, 'owner', 7);
ok('owner 主体可查', $p !== null && $p['login_id'] === 'K' && $p['status'] === 'active');
$p = device_token_fetch_principal($pdo, 'user', 11);
ok('user 主体可查', $p !== null && $p['login_id'] === 'alice');
$p = device_token_fetch_principal($pdo, 'member', 21);
ok('member 主体可查', $p !== null && $p['login_id'] === 'ACC1');
ok('停用 user 状态可读出', device_token_fetch_principal($pdo, 'user', 13)['status'] === 'inactive');
ok('不存在的主体 → null', device_token_fetch_principal($pdo, 'user', 999) === null);

echo "\n=== 11. 二级密码 redirect（决策 4 的核心）===\n";
$sC168 = ['company_id' => 1, 'company_code' => 'C168', 'user_id' => 11];
$sBank = ['company_id' => 2, 'company_code' => 'BANK', 'user_id' => 12];
ok('owner 总是要 → /owner-secondary-password',
    device_token_secondary_password_redirect($pdo, 'owner', 7, []) === '/owner-secondary-password');
ok('member 不需要 → null',
    device_token_secondary_password_redirect($pdo, 'member', 21, $sC168) === null);
ok('user+C168+已设二级密码 → /user-secondary-password',
    device_token_secondary_password_redirect($pdo, 'user', 11, $sC168) === '/user-secondary-password');
ok('user+C168+未设二级密码 → null',
    device_token_secondary_password_redirect($pdo, 'user', 12, $sC168) === null);
ok('user+非C168公司 → null',
    device_token_secondary_password_redirect($pdo, 'user', 11, $sBank) === null);
ok('company_code 缺失时按 company_id 回查（C168）',
    device_token_secondary_password_redirect($pdo, 'user', 11, ['company_id' => 1]) === '/user-secondary-password');
ok('company_code 缺失时按 company_id 回查（BANK）',
    device_token_secondary_password_redirect($pdo, 'user', 11, ['company_id' => 2]) === null);

echo "\n=== 12. 快照体积守卫 ===\n";
ok('正常快照可编码', device_token_encode_snapshot(['a' => 1]) !== null);
$bigArray = ['user_id' => 11, 'assigned_company_ids' => range(1, 20000)];
ok('前置条件：原始快照确实超限', strlen(json_encode($bigArray)) > DEVICE_TOKEN_SNAPSHOT_MAX_BYTES);
$enc = device_token_encode_snapshot($bigArray);
ok('超限时丢弃数组而非报错', $enc !== null);
ok('丢弃数组后保留标量身份键', $enc !== null && strpos($enc, '"user_id":11') !== false);
ok('丢弃数组后体积达标', $enc !== null && strlen($enc) <= DEVICE_TOKEN_SNAPSHOT_MAX_BYTES);
$hopeless = ['a' => str_repeat('Z', 70000), 'b' => str_repeat('Y', 70000)];
ok('无法压缩 → null（交回调用方报错）', device_token_encode_snapshot($hopeless) === null);

echo "\n=== 13. 入口参数校验 ===\n";
ok('非法 user_type → BAD_PRINCIPAL',
    device_token_issue($pdo, 'hacker', 11, 'devZ', 'Z', [])['code'] === 'BAD_PRINCIPAL');
ok('user_id<=0 → BAD_PRINCIPAL',
    device_token_issue($pdo, 'user', 0, 'devZ', 'Z', [])['code'] === 'BAD_PRINCIPAL');
ok('空 device_id → BAD_DEVICE_ID',
    device_token_issue($pdo, 'user', 11, '', 'x', [])['code'] === 'BAD_DEVICE_ID');
ok('过短但仍合法（不设人为下限）', device_token_is_valid_device_id('abc'));
ok('超长 device_id 被拒', !device_token_is_valid_device_id(str_repeat('d', 65)));
ok('含非法字符被拒', !device_token_is_valid_device_id("dev\0AAA123"));
ok('UUID 形式通过', device_token_is_valid_device_id('3f2504e0-4f89-11d3-9a0c-0305e82c3301'));

echo "\n=== 14. 跨身份隔离（uk_device 含 user_type + user_id）===\n";
clean($pdo);
device_token_issue($pdo, 'user', 11, 'sameDev', 'A', $snap);
device_token_issue($pdo, 'owner', 7, 'sameDev', 'B', $snap);
device_token_issue($pdo, 'member', 21, 'sameDev', 'C', $snap);
$n = (int) $pdo->query("SELECT COUNT(*) FROM device_token WHERE device_id='sameDev'")->fetchColumn();
ok('同 device_id 跨三种身份互不干扰', $n === 3, "实际 $n");
ok('user 身份活跃数为 1', device_token_count_active($pdo, 'user', 11) === 1);
ok('owner 身份活跃数为 1', device_token_count_active($pdo, 'owner', 7) === 1);
ok('member 身份活跃数为 1', device_token_count_active($pdo, 'member', 21) === 1);

echo "\n=== 15. kind 归一化 ===\n";
ok('biometric 合法', device_token_normalize_kind('BIOMETRIC') === DEVICE_TOKEN_KIND_BIOMETRIC);
ok('web 合法', device_token_normalize_kind('web') === DEVICE_TOKEN_KIND_WEB);
ok('非法 kind → 空', device_token_normalize_kind('mobile') === '');
ok('null kind → 空', device_token_normalize_kind(null) === '');

$snapMember = ['user_id' => 21, 'user_type' => 'member', 'company_id' => 1, 'company_code' => 'C168'];
$snapOwner  = ['user_id' => 7, 'user_type' => 'owner', 'company_id' => 1, 'company_code' => 'C168'];
$snapUser11 = ['user_id' => 11, 'user_type' => 'user', 'company_id' => 2, 'company_code' => 'BANK'];
$snapUser13 = ['user_id' => 13, 'user_type' => 'user', 'company_id' => 2, 'company_code' => 'BANK'];

echo "\n=== 16. kind 隔离：网页记住我不占手机指纹配额 ===\n";
clean($pdo);
for ($i = 1; $i <= 5; $i++) {
    device_token_issue($pdo, 'user', 11, "bio$i", "Phone $i", $snap);
}
ok('指纹已打满 5 台', device_token_count_active($pdo, 'user', 11) === 5);
for ($i = 1; $i <= 3; $i++) {
    device_token_issue($pdo, 'user', 11, "web$i", 'Browser', $snap, DEVICE_TOKEN_KIND_WEB, 30);
}
ok('网页记住我计入自己的配额', device_token_count_active($pdo, 'user', 11, DEVICE_TOKEN_KIND_WEB) === 3);
ok('指纹配额仍为 5，未被网页占用', device_token_count_active($pdo, 'user', 11) === 5);
ok('设备列表只含指纹', count(device_token_list($pdo, 'user', 11)) === 5);
ok('网页列表只含网页', count(device_token_list($pdo, 'user', 11, DEVICE_TOKEN_KIND_WEB)) === 3);
$rWeb = device_token_issue($pdo, 'user', 11, 'web4', 'Browser', $snap, DEVICE_TOKEN_KIND_WEB, 30);
ok('指纹满额时仍可新增网页记住我', $rWeb['ok'], $rWeb['code'] ?? '');
ok('但第 6 台指纹仍被挡',
    device_token_issue($pdo, 'user', 11, 'bio6', 'Phone 6', $snap)['code'] === 'DEVICE_LIMIT');

// 网页 TTL 与移动端不同（30 天 vs 90 天）
$webExp = $pdo->query("SELECT DATEDIFF(expires_at, NOW()) AS d FROM device_token WHERE device_id='web4'")->fetchColumn();
ok('网页记住我 TTL 约 30 天', (int) $webExp >= 29 && (int) $webExp <= 30, "实际 {$webExp}");
$bioExp = $pdo->query("SELECT DATEDIFF(expires_at, NOW()) AS d FROM device_token WHERE device_id='bio1'")->fetchColumn();
ok('指纹 TTL 约 90 天', (int) $bioExp >= 89 && (int) $bioExp <= 90, "实际 {$bioExp}");

ok('非法 kind → BAD_KIND',
    device_token_issue($pdo, 'user', 11, 'devKind', 'x', $snap, 'mobile')['code'] === 'BAD_KIND');

 echo "\n=== 17. web 解析：无设备绑定 + kind 必须匹配 ===\n";
clean($pdo);
$wTok = device_token_issue($pdo, 'member', 21, 'webdev01', 'Browser', $snapMember, DEVICE_TOKEN_KIND_WEB, 30);
$bTok = device_token_issue($pdo, 'member', 21, 'biodev01', 'Phone', $snapMember);
ok('web 令牌不传 device_id 也能解析',
    device_token_resolve($pdo, $wTok['token'], null, DEVICE_TOKEN_KIND_WEB)['ok']);
ok('web 令牌传错 device_id 仍被拒（绑定校验没被取消）',
    device_token_resolve($pdo, $wTok['token'], 'wrongdevice', DEVICE_TOKEN_KIND_WEB)['code'] === 'TOKEN_INVALID');
ok('web 令牌当 biometric 查 → INVALID',
    device_token_resolve($pdo, $wTok['token'], null, DEVICE_TOKEN_KIND_BIOMETRIC)['code'] === 'TOKEN_INVALID');
ok('biometric 令牌当 web 查 → INVALID',
    device_token_resolve($pdo, $bTok['token'], null, DEVICE_TOKEN_KIND_WEB)['code'] === 'TOKEN_INVALID');
ok('不限 kind 时两者都能查到',
    device_token_resolve($pdo, $bTok['token'], 'biodev01', null)['ok']
    && device_token_resolve($pdo, $wTok['token'], null, null)['ok']);

 echo "\n=== 18. revoke_by_token 只打中一条 ===\n";
clean($pdo);
$wA = device_token_issue($pdo, 'owner', 7, 'webA', 'A', $snapMember, DEVICE_TOKEN_KIND_WEB, 30);
$wB = device_token_issue($pdo, 'owner', 7, 'webB', 'B', $snapMember, DEVICE_TOKEN_KIND_WEB, 30);
ok('精确吐销返回 1', device_token_revoke_by_token($pdo, $wA['token'], DEVICE_TOKEN_KIND_WEB) === 1);
ok('被吐销的那条已失效',
    device_token_resolve($pdo, $wA['token'], null, DEVICE_TOKEN_KIND_WEB)['code'] === 'TOKEN_REVOKED');
ok('**另一个浏览器不受影响**',
    device_token_resolve($pdo, $wB['token'], null, DEVICE_TOKEN_KIND_WEB)['ok']);
ok('重复吐销同一 token 返回 0',
    device_token_revoke_by_token($pdo, $wA['token'], DEVICE_TOKEN_KIND_WEB) === 0);
ok('非 hex 字符串不报错且返回 0', device_token_revoke_by_token($pdo, 'nothex') === 0);

 echo "\n=== 19. 网页记住我签发（勾 / 不勾）===\n";
clean($pdo);
$postBackup = $_POST;
$cookieBackup = $_COOKIE;
$sessionBackup = $_SESSION;

$_SESSION = [
    'user_id' => 21, 'user_type' => 'member', 'role' => 'member',
    'login_id' => 'ACC1', 'account_id' => 'ACC1',
    'company_id' => 1, 'company_code' => 'C168',
    'member_login_account_id' => 21, 'member_winloss_view_account_id' => 21,
    'secondary_password_verified' => true,   // 必须被排除
];
$_COOKIE[DEVICE_TOKEN_WEB_COOKIE] = str_repeat('a', 32);
$_POST['remember_me'] = '1';
device_token_web_remember_issue($pdo, 'member', 21);
$webRows = $pdo->query("SELECT kind, device_id, session_snapshot FROM device_token WHERE user_type='member'")->fetchAll(PDO::FETCH_ASSOC);
ok('勾了记住我 → 建成一条 web 行', count($webRows) === 1 && $webRows[0]['kind'] === 'web', 'count=' . count($webRows));
ok('绑定了浏览器 device_id', ($webRows[0]['device_id'] ?? '') === str_repeat('a', 32));
$storedSnap = json_decode((string) ($webRows[0]['session_snapshot'] ?? ''), true);
ok('快照含 member 专属键', ($storedSnap['member_login_account_id'] ?? null) === 21);
ok('快照已排除二级密码标记', !array_key_exists('secondary_password_verified', (array) $storedSnap));

// 同一浏览器重新登录 = 覆盖，不是新增
$before = (int) $pdo->query("SELECT COUNT(*) FROM device_token WHERE kind='web'")->fetchColumn();
device_token_web_remember_issue($pdo, 'member', 21);
$after = (int) $pdo->query("SELECT COUNT(*) FROM device_token WHERE kind='web'")->fetchColumn();
ok('同浏览器重复登录不新增行（uk_device）', $before === $after && $after === 1, "before=$before after=$after");

// 不勾：精确吐销当前 cookie 那条
$keep = device_token_issue($pdo, 'member', 21, str_repeat('b', 32), 'B', $snapMember, DEVICE_TOKEN_KIND_WEB, 30);
$_COOKIE['remember_token'] = $keep['token'];
unset($_POST['remember_me']);
device_token_web_remember_issue($pdo, 'member', 21);
ok('不勾记住我 → 当前 cookie 那条被吐销',
    device_token_resolve($pdo, $keep['token'], null, DEVICE_TOKEN_KIND_WEB)['code'] === 'TOKEN_REVOKED');

 echo "\n=== 20. 用 cookie 恢复会话（含安全底线）===\n";
clean($pdo);
$_SESSION = [
    'user_id' => 7, 'user_type' => 'owner', 'role' => 'owner',
    'login_id' => 'K', 'owner_id' => 7, 'real_owner_id' => 7, 'owner_code' => 'K',
    'company_id' => 1, 'company_code' => 'C168',
    'secondary_password_verified' => true,   // 故意带上，看会不会被快照带进去
];
$oTok = device_token_issue(
    $pdo, 'owner', 7, str_repeat('c', 32), 'Browser',
    device_token_capture_session(), DEVICE_TOKEN_KIND_WEB, 30
);
$preSnap = json_decode((string) $pdo->query("SELECT session_snapshot FROM device_token WHERE device_id='" . str_repeat('c', 32) . "'")->fetchColumn(), true);
ok('（前置）快照本身不含二级密码标记', !array_key_exists('secondary_password_verified', (array) $preSnap));

$_SESSION = [];
$_COOKIE['remember_token'] = $oTok['token'];
ok('恢复成功', device_token_try_restore_from_cookie($pdo) === true);
ok('恢复出 owner 身份',
    ($_SESSION['user_type'] ?? '') === 'owner' && (int) ($_SESSION['user_id'] ?? 0) === 7);
ok('owner 专属字段已带回',
    (int) ($_SESSION['owner_id'] ?? 0) === 7 && ($_SESSION['owner_code'] ?? '') === 'K');

// 安全防线分层：
//  ① device_token_restore_session() 自身**绝不**设置该标记（即使快照被污染）
//  ② 放行只由显式策略 DEVICE_TOKEN_TRUSTED_SKIPS_SECONDARY 决定
$_SESSION = [];
device_token_restore_session(['user_id' => 7, 'user_type' => 'owner', 'secondary_password_verified' => true]);
ok('★ restore_session 自身绝不设置二级密码标记（防被污染的快照）',
    !isset($_SESSION['secondary_password_verified']));

// 重新走一次完整恢复，验证策略层确实放行了。用**显式**快照，不依赖当时的 $_SESSION。
$ownerSnapFull = [
    'user_id' => 7, 'user_type' => 'owner', 'role' => 'owner',
    'login_id' => 'K', 'owner_id' => 7, 'real_owner_id' => 7, 'owner_code' => 'K',
    'company_id' => 1, 'company_code' => 'C168',
];
clean($pdo);
$oPolicy = device_token_issue(
    $pdo, 'owner', 7, str_repeat('5', 32), 'Browser',
    $ownerSnapFull, DEVICE_TOKEN_KIND_WEB, 30
);
$_SESSION = [];
$_COOKIE['remember_token'] = $oPolicy['token'];
ok('策略开启时恢复成功', device_token_try_restore_from_cookie($pdo) === true);
ok('★ 受信任凭据已放行二级密码（产品决定：owner 不再重输 6 位码）',
    ($_SESSION['secondary_password_verified'] ?? null) === true);
ok('该标记确实来自策略而非快照',
    !array_key_exists('secondary_password_verified', (array) $preSnap));

// 已吐销
clean($pdo);
$r2 = device_token_issue($pdo, 'owner', 7, str_repeat('d', 32), 'B', $snapOwner, DEVICE_TOKEN_KIND_WEB, 30);
device_token_revoke_by_token($pdo, $r2['token'], DEVICE_TOKEN_KIND_WEB);
$_SESSION = [];
$_COOKIE['remember_token'] = $r2['token'];
ok('已吐销 → 不恢复', device_token_try_restore_from_cookie($pdo) === false);

// 已过期
clean($pdo);
$r3 = device_token_issue($pdo, 'owner', 7, str_repeat('e', 32), 'B', $snapOwner, DEVICE_TOKEN_KIND_WEB, 30);
$pdo->exec("UPDATE device_token SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY)");
$_SESSION = [];
$_COOKIE['remember_token'] = $r3['token'];
ok('已过期 → 不恢复', device_token_try_restore_from_cookie($pdo) === false);

// 快照与令牌身份不一致（防损坏 / 防被污染的快照被使用）
clean($pdo);
$mismatch = device_token_issue($pdo, 'owner', 7, str_repeat('7', 32), 'B', $snapMember, DEVICE_TOKEN_KIND_WEB, 30);
$_SESSION = [];
$_COOKIE['remember_token'] = $mismatch['token'];
ok('快照 user_id 与令牌不符 → 不恢复', device_token_try_restore_from_cookie($pdo) === false);

// C168 是平台自身：company_expiration.php 对它无条件 return 'valid'（过期也不拦）
clean($pdo);
$pdo->exec("UPDATE company SET expiration_date = '2020-01-01 00:00:00' WHERE id = 1");
$rC168 = device_token_issue($pdo, 'member', 21, str_repeat('f', 32), 'B', $snapMember, DEVICE_TOKEN_KIND_WEB, 30);
$_SESSION = [];
$_COOKIE['remember_token'] = $rC168['token'];
ok('C168 即使过期也放行（跟随 company_expiration 的既有豁免）',
    device_token_try_restore_from_cookie($pdo) === true);

// 非 C168 才是真正的过期拦截
clean($pdo);
$pdo->exec("UPDATE company SET expiration_date = '2020-01-01 00:00:00' WHERE id = 2");
$r4 = device_token_issue($pdo, 'user', 11, str_repeat('8', 32), 'B', $snapUser11, DEVICE_TOKEN_KIND_WEB, 30);
$_SESSION = [];
$_COOKIE['remember_token'] = $r4['token'];
ok('非 C168 公司已过期 → 不恢复', device_token_try_restore_from_cookie($pdo) === false);
ok('（且未误清凭据，公司续期后仍可用）',
    device_token_resolve($pdo, $r4['token'], null, DEVICE_TOKEN_KIND_WEB)['ok']);
$pdo->exec("UPDATE company SET expiration_date = '2099-01-01 00:00:00' WHERE id = 2");

// 账号被停用（快照必须与令牌身份一致，否则会先卡在不一致检查上）
clean($pdo);
$pdo->exec("UPDATE user SET status='inactive' WHERE id=13");
$r5 = device_token_issue($pdo, 'user', 13, str_repeat('0', 32), 'B', $snapUser13, DEVICE_TOKEN_KIND_WEB, 30);
$_SESSION = [];
$_COOKIE['remember_token'] = $r5['token'];
ok('账号已停用 → 不恢复', device_token_try_restore_from_cookie($pdo) === false);
ok('停用账号的令牌被顺手吐销',
    device_token_resolve($pdo, $r5['token'], null, DEVICE_TOKEN_KIND_WEB)['code'] === 'TOKEN_REVOKED');
$pdo->exec("UPDATE user SET status='active' WHERE id=13");

// 指纹令牌不能被网页路径认领
clean($pdo);
$bioOnly = device_token_issue($pdo, 'owner', 7, str_repeat('9', 32), 'Phone', $snapOwner);
$_SESSION = [];
$_COOKIE['remember_token'] = $bioOnly['token'];
ok('指纹令牌不能当网页记住我用', device_token_try_restore_from_cookie($pdo) === false);

$_SESSION = [];
unset($_COOKIE['remember_token']);
ok('无 cookie → 不恢复', device_token_try_restore_from_cookie($pdo) === false);

// 还原超全局
$_POST = $postBackup;
$_COOKIE = $cookieBackup;
$_SESSION = $sessionBackup;

// 收尾：不把测试库留在机器上
$rootPdo->exec("DROP DATABASE IF EXISTS `$dbName`");

echo "\n============================\n";
echo "PASS: $pass   FAIL: $fail\n";
echo "============================\n";
exit($fail === 0 ? 0 : 1);
