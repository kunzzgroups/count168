<?php
/**
 * WebAuthn 密码学核心回归测试（不需要浏览器、不需要数据库）。
 *
 * 用法：php scripts/test-webauthn.php
 *
 * 为什么这样测有意义：
 *   签名由 **openssl 独立生成**，本文件里的 PHP 代码只负责“验”。
 *   如果我的 CBOR / COSE→PEM / 签名归一化 / 数据拼接有任何一处写错，
 *   验签就会失败 —— 所以这不是自证。
 */

$root = dirname(__DIR__);

// 本地 XAMPP 的 PHP 找不到 openssl.cnf 时无法生成 EC 密钥（仅测试需要；生产只验签）。
// 注意：不能用 putenv —— PHP 的 openssl 在**模块初始化时**就读了 OPENSSL_CONF，
// 运行时设置无效；必须通过 openssl_pkey_new 的 config 参数显式指定。
$OPENSSL_CNF = null;
foreach ([
    'C:/xampp/php/extras/openssl/openssl.cnf',
    'C:/xampp/apache/conf/openssl.cnf',
    '/etc/ssl/openssl.cnf',
    '/etc/pki/tls/openssl.cnf',
] as $cnf) {
    if (is_file($cnf)) {
        $OPENSSL_CNF = $cnf;
        break;
    }
}

/** 生成一把 P-256 密钥（带 config 回退） */
function wa_test_ec_key(?string $cnf)
{
    $args = ['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1'];
    if ($cnf !== null) {
        $args['config'] = $cnf;
    }

    return @openssl_pkey_new($args);
}

require_once $root . '/includes/webauthn.php';

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

/* ── 仅供测试使用的迷你 CBOR 编码器 ─────────────────────────── */
function cbor_head(int $major, int $value): string
{
    if ($value < 24) {
        return chr(($major << 5) | $value);
    }
    if ($value < 256) {
        return chr(($major << 5) | 24) . chr($value);
    }

    return chr(($major << 5) | 25) . pack('n', $value);
}
function cbor_uint(int $n): string { return cbor_head(0, $n); }
function cbor_negint(int $n): string { return cbor_head(1, -1 - $n); }   // $n 为负
function cbor_bstr(string $s): string { return cbor_head(2, strlen($s)) . $s; }
function cbor_tstr(string $s): string { return cbor_head(3, strlen($s)) . $s; }
function cbor_map(array $m): string
{
    $out = cbor_head(5, count($m));
    foreach ($m as $k => $v) {
        $out .= is_int($k) ? ($k < 0 ? cbor_negint($k) : cbor_uint($k)) : cbor_tstr((string) $k);
        $out .= $v;
    }

    return $out;
}

/* ── 固定请求上下文 ─────────────────────────────────────────── */
$RP = 'count168.com';
$ORIGIN = 'https://www.count168.com';
$_SERVER['HTTP_HOST'] = 'www.count168.com';

/* ── 生成一把真实的 P-256 密钥（只用 openssl，不用被测代码）── */
$priv = wa_test_ec_key($OPENSSL_CNF);
if ($priv === false) {
    fwrite(STDERR, "无法生成 EC 密钥（openssl 配置缺失），跳过测试\n");
    while ($e = openssl_error_string()) {
        fwrite(STDERR, "  openssl: $e\n");
    }
    exit(2);
}
$det = openssl_pkey_get_details($priv);
$pubX = $det['ec']['x'];
$pubY = $det['ec']['y'];
$cose = cbor_map([
    1  => cbor_uint(2),        // kty = EC2
    3  => cbor_negint(-7),     // alg = ES256
    -1 => cbor_uint(1),        // crv = P-256
    -2 => cbor_bstr($pubX),
    -3 => cbor_bstr($pubY),
]);

echo "=== 1. base64url ===\n";
$bin = random_bytes(32);
ok('encode/decode 往返', wa_b64url_decode(wa_b64url_encode($bin)) === $bin);
ok('含 + / 的输入被拒（非规范 base64url 字符）', wa_b64url_decode('a+b/') === null);
ok('长度非法(余 1) 被拒', wa_b64url_decode('abcde') === null);
ok('空串解码为空串', wa_b64url_decode('') === '');
ok('encode 不含 = 与 + /', !preg_match('#[=+/]#', wa_b64url_encode(random_bytes(50))));

echo "\n=== 2. 迷你 CBOR ===\n";
ok('uint 小值', wa_cbor_read_exact(cbor_uint(2)) === 2);
ok('negative int', wa_cbor_read_exact(cbor_negint(-7)) === -7);
ok('byte string', wa_cbor_read_exact(cbor_bstr('hello')) === 'hello');
ok('text string', wa_cbor_read_exact(cbor_tstr('fmt')) === 'fmt');
$rt = wa_cbor_read_exact(cbor_map([1 => cbor_uint(2), -2 => cbor_bstr(str_repeat('x', 32))]));
ok('map 往返（含负键）', is_array($rt) && $rt[1] === 2 && $rt[-2] === str_repeat('x', 32));
ok('截断的 bstr 被拒', wa_cbor_read_exact(cbor_head(2, 10) . 'abc') === null);
ok('尾部有多余字节被拒', wa_cbor_read_exact(cbor_uint(1) . "\x00") === null);
ok('不定长(0x1f) 被拒', wa_cbor_read_exact("\x9f") === null);
$off = 0;
$first = wa_cbor_read(cbor_uint(5) . cbor_uint(9), $off);
$second = wa_cbor_read(cbor_uint(5) . cbor_uint(9), $off);
ok('offset 引用推进正确', $first === 5 && $second === 9 && $off === 2);

echo "\n=== 3. COSE → PEM ===\n";
$coseOk = wa_cbor_read_exact($cose);
ok('COSE map 可解析', is_array($coseOk) && strlen($coseOk[-2]) === 32);
$pem = wa_cose_ec2_to_pem($coseOk);
ok('生成 PEM', is_string($pem) && str_starts_with($pem, WA_PEM_PREFIX));
$imported = $pem !== null ? @openssl_pkey_get_public($pem) : false;
ok('openssl 能导入该 PEM', $imported !== false);
$detailFromPem = $imported !== false ? openssl_pkey_get_details($imported) : null;
ok('导入后的 x/y 与原始一致',
    is_array($detailFromPem)
    && $detailFromPem['ec']['x'] === $pubX
    && $detailFromPem['ec']['y'] === $pubY);
ok('kty 非 EC2 → null', wa_cose_ec2_to_pem([1 => 3, 3 => -7, -1 => 1, -2 => $pubX, -3 => $pubY]) === null);
ok('alg 非 ES256 → null', wa_cose_ec2_to_pem([1 => 2, 3 => -257, -1 => 1, -2 => $pubX, -3 => $pubY]) === null);
ok('crv 非 P-256 → null', wa_cose_ec2_to_pem([1 => 2, 3 => -7, -1 => 2, -2 => $pubX, -3 => $pubY]) === null);
ok('x 长度不对 → null', wa_cose_ec2_to_pem([1 => 2, 3 => -7, -1 => 1, -2 => 'short', -3 => $pubY]) === null);

echo "\n=== 4. 签名归一化 ===\n";
$msg = 'sign me';
$der = '';
openssl_sign($msg, $der, $priv, OPENSSL_ALGO_SHA256);
ok('DER 原样通过', wa_signature_to_der($der) === $der);
ok('空签名 → null', wa_signature_to_der('') === null);
// 构造一个 r/s 高位为 1 的裸签名，确认会补前导 0x00 而不是被当成负数
$rHigh = "\x80" . str_repeat("\x11", 31);
$sHigh = "\xff" . str_repeat("\x22", 31);
$derHigh = wa_signature_to_der($rHigh . $sHigh);
ok('高位为 1 时补前导 0x00（不当负数解释）',
    is_string($derHigh)
    && $derHigh[2] === "\x02" && ord($derHigh[3]) === 33 && $derHigh[4] === "\x00");
// 拿一把真实签名的 DER，反解成裸 r||s，再用被测函数转回 DER ——
// openssl 能验通才说明转换器是对的（这才是真正有意义的断言）。
function der_to_raw_rs(string $der): ?string
{
    if (strlen($der) < 8 || $der[0] !== "\x30") {
        return null;
    }
    $i = 2;
    if (ord($der[1]) & 0x80) {
        $i = 2 + (ord($der[1]) & 0x7f);
    }
    if ($der[$i] !== "\x02") {
        return null;
    }
    $rLen = ord($der[$i + 1]);
    $r = substr($der, $i + 2, $rLen);
    $j = $i + 2 + $rLen;
    if ($j >= strlen($der) || $der[$j] !== "\x02") {
        return null;
    }
    $sLen = ord($der[$j + 1]);
    $s = substr($der, $j + 2, $sLen);

    // 去掉 DER 为了“正数”而补的前导 0x00，再补足到 32 字节
    $pad = static function (string $v): string {
        $v = ltrim($v, "\x00");
        return str_pad($v, 32, "\x00", STR_PAD_LEFT);
    };

    return $pad($r) . $pad($s);
}

$rawRs = der_to_raw_rs($der);
ok('（前置）能从 DER 反解出 64 字节裸签名', is_string($rawRs) && strlen($rawRs) === 64);
$backToDer = $rawRs !== null ? wa_signature_to_der($rawRs) : null;
ok('裸 64 字节 → DER 结构', is_string($backToDer) && $backToDer[0] === "\x30");
$roundTripPub = openssl_pkey_get_public($det['key']);
ok('★ 转换后的 DER 能被 openssl 验通（转换器正确）',
    $roundTripPub !== false && openssl_verify($msg, (string) $backToDer, $roundTripPub, OPENSSL_ALGO_SHA256) === 1);

echo "\n=== 5. RP ID / origin ===\n";
ok('www 去掉后为 RP ID', wa_rp_id() === $RP);
$_SERVER['HTTP_HOST'] = 'count168.com';
ok('裸域 RP ID 相同', wa_rp_id() === $RP);
$_SERVER['HTTP_HOST'] = 'www.count168.com:443';
ok('带端口能正确剥离', wa_rp_id() === $RP);
$_SERVER['HTTP_HOST'] = 'www.count168.com';
ok('允许列表含裸域与 www',
    in_array('https://count168.com', wa_expected_origins(), true)
    && in_array($ORIGIN, wa_expected_origins(), true));
ok('合法 origin 通过', wa_origin_ok($ORIGIN));
ok('裸域 origin 通过', wa_origin_ok('https://count168.com'));
ok('大小写不敏感', wa_origin_ok('HTTPS://WWW.COUNT168.COM'));
ok('尾斜杠容忍', wa_origin_ok('https://www.count168.com/'));
ok('★ 钓鱼子域被拒', !wa_origin_ok('https://www.count168.com.evil.com'));
ok('★ 前缀式假域被拒', !wa_origin_ok('https://www.count168.co'));
ok('★ 别的域名被拒', !wa_origin_ok('https://count168.org'));
ok('★ 空/非串被拒', !wa_origin_ok('') && !wa_origin_ok(null));

echo "\n=== 6. clientDataJSON ===\n";
$chal = wa_b64url_encode(random_bytes(32));
$cdjOk = json_encode(['type' => 'webauthn.get', 'challenge' => $chal, 'origin' => $ORIGIN]);
$cdjB64 = wa_b64url_encode($cdjOk);
$checked = wa_check_client_data($cdjB64, 'webauthn.get', $chal);
ok('合法 clientData 通过', is_array($checked) && $checked['origin'] === $ORIGIN);
ok('type 不匹配被拒', wa_check_client_data($cdjB64, 'webauthn.create', $chal) === null);
$cdjBadChal = wa_b64url_encode(json_encode(['type' => 'webauthn.get', 'challenge' => wa_b64url_encode(random_bytes(32)), 'origin' => $ORIGIN]));
ok('★ challenge 不匹配被拒', wa_check_client_data($cdjBadChal, 'webauthn.get', $chal) === null);
$cdjBadOrigin = wa_b64url_encode(json_encode(['type' => 'webauthn.get', 'challenge' => $chal, 'origin' => 'https://evil.com']));
ok('★ origin 不合法被拒', wa_check_client_data($cdjBadOrigin, 'webauthn.get', $chal) === null);
ok('★ 非 JSON 被拒', wa_check_client_data(wa_b64url_encode('nope'), 'webauthn.get', $chal) === null);
ok('T 型 challenge 不能通过（逐字节比较）',
    wa_check_client_data(wa_b64url_encode(json_encode(['type' => 'webauthn.get', 'challenge' => $chal . 'x', 'origin' => $ORIGIN])), 'webauthn.get', $chal) === null);

echo "\n=== 7. authenticatorData ===\n";
$rpHash = hash('sha256', $RP, true);
$credId = random_bytes(32);
$authDataReg = $rpHash
    . chr(WA_FLAG_UP | WA_FLAG_UV | WA_FLAG_AT)
    . pack('N', 0)
    . random_bytes(16)                    // aaguid
    . pack('n', strlen($credId)) . $credId
    . $cose;
$parsedReg = wa_parse_auth_data($authDataReg, true);
ok('注册 authData 可解析', is_array($parsedReg));
ok('credentialId 正确', ($parsedReg['credential_id'] ?? null) === $credId);
ok('COSE 公钥被取出', is_array($parsedReg['cose_key'] ?? null));
ok('signCount=0', ($parsedReg['sign_count'] ?? -1) === 0);

$badRp = hash('sha256', 'evil.com', true) . substr($authDataReg, 32);
ok('★ rpIdHash 不匹配被拒', wa_parse_auth_data($badRp, true) === null);
$noUp = $rpHash . chr(WA_FLAG_UV | WA_FLAG_AT) . substr($authDataReg, 33);
ok('★ 缺 UP 被拒', wa_parse_auth_data($noUp, true) === null);
$noUv = $rpHash . chr(WA_FLAG_UP | WA_FLAG_AT) . substr($authDataReg, 33);
ok('★ 缺 UV 被拒（我们请求了 required）', wa_parse_auth_data($noUv, true) === null);
$noAt = $rpHash . chr(WA_FLAG_UP | WA_FLAG_UV) . pack('N', 0);
ok('注册时缺 AT 被拒', wa_parse_auth_data($noAt, true) === null);
ok('登录时缺 AT 可以（不需要 attested 数据）', wa_parse_auth_data($noAt, false) !== null);
ok('过短被拒', wa_parse_auth_data(substr($authDataReg, 0, 36), true) === null);

echo "\n=== 8. attestationObject ===\n";
$attObj = cbor_map(['fmt' => cbor_tstr('none'), 'attStmt' => cbor_map([]), 'authData' => cbor_bstr($authDataReg)]);
$parsedAtt = wa_parse_attestation_none(wa_b64url_encode($attObj));
ok('合法 attestationObject 可解析', is_array($parsedAtt));
ok('返回 credentialId 与 PEM',
    is_array($parsedAtt) && $parsedAtt['credential_id'] === $credId
    && str_starts_with($parsedAtt['public_key_pem'], WA_PEM_PREFIX));
$attPacked = cbor_map(['fmt' => cbor_tstr('packed'), 'attStmt' => cbor_map([]), 'authData' => cbor_bstr($authDataReg)]);
ok('★ fmt 非 none 被拒（我们不做 attestation 校验）', wa_parse_attestation_none(wa_b64url_encode($attPacked)) === null);
ok('★ 顶层多余字节被拒', wa_parse_attestation_none(wa_b64url_encode($attObj . "\x00")) === null);

echo "\n=== 9. 断言验签（openssl 独立签名）===\n";
$pubPem = wa_cose_ec2_to_pem($coseOk);
$authDataAs = $rpHash . chr(WA_FLAG_UP | WA_FLAG_UV) . pack('N', 1);
$cdjAs = json_encode(['type' => 'webauthn.get', 'challenge' => $chal, 'origin' => $ORIGIN]);
$sig = '';
openssl_sign($authDataAs . hash('sha256', $cdjAs, true), $sig, $priv, OPENSSL_ALGO_SHA256);
ok('合法断言验签通过', wa_verify_assertion($authDataAs, $cdjAs, $sig, $pubPem));
ok('★ 篡改 authData 失败', !wa_verify_assertion($authDataAs . 'x', $cdjAs, $sig, $pubPem));
ok('★ 篡改 clientData 失败', !wa_verify_assertion($authDataAs, $cdjAs . 'x', $sig, $pubPem));
ok('★ 篡改签名失败', !wa_verify_assertion($authDataAs, $cdjAs, strrev($sig), $pubPem));
ok('★ 空签名失败', !wa_verify_assertion($authDataAs, $cdjAs, '', $pubPem));
$other = wa_test_ec_key($OPENSSL_CNF);
$otherPem = $other !== false ? openssl_pkey_get_details($other)['key'] : '';
ok('★ 用别人的公钥验失败', !wa_verify_assertion($authDataAs, $cdjAs, $sig, $otherPem));
ok('★ 非 PEM 字符串被拒', !wa_verify_assertion($authDataAs, $cdjAs, $sig, 'not a pem'));

echo "\n=== 10. signCount ===\n";
ok('0 → 0 放行（平台验证器常见）', wa_sign_count_ok(0, 0));
ok('0 → 5 放行', wa_sign_count_ok(0, 5));
ok('5 → 0 放行（部分实现重置）', wa_sign_count_ok(5, 0));
ok('1 → 2 放行', wa_sign_count_ok(1, 2));
ok('★ 2 → 1 拒绝（疑似克隆）', !wa_sign_count_ok(2, 1));
ok('★ 5 → 5 拒绝', !wa_sign_count_ok(5, 5));

echo "\n============================\n";
echo "PASS: $pass   FAIL: $fail\n";
echo "============================\n";
exit($fail === 0 ? 0 : 1);
