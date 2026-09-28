#!/usr/bin/env node
/**
 * M4 验证：抓取客户端（指纹 / 失败分类 / 代理）。
 *
 *   docker compose -f deploy/docker-compose.yml run --rm \
 *     -v /opt/405nm/tests:/repo/tests:ro \
 *     -e SOURCING_PROXY=... backend node /repo/tests/m4-verify.mjs
 *
 * 这个脚本不碰数据库，可以单独跑来排查抓取链路。
 *
 * 关于**哪些断言需要外网**：只有「指纹」与「代理」两节需要。它们是这次 spike
 * 的核心结论，必须有回归护栏，所以宁可让脚本在没网时明确变红 ——
 * 一个连不上网的图源测试套件，绿了也没有任何意义。状态码那一节则刻意
 * 全部打本机起的小服务，确定性、离线可跑。
 */

import http from 'node:http';
import { SourcingError } from '../backend/dist/sourcing/errors.js';
import { maskProxy, sourcingFetch } from '../backend/dist/sourcing/http.js';

const REPORT_URL = process.env.M4_REPORT_URL ?? 'https://tls.peet.ws/api/all';
const PIXIV_PROBE = 'https://www.pixiv.net/ajax/illust/999999999999';
const PROXY = process.env.SOURCING_PROXY ?? '';

let passed = 0;
const failures = [];

function record(group, name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ [${group}] ${name}`);
  } else {
    failures.push({ group, name, detail });
    console.log(`  ✗ [${group}] ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 把抛出的东西压成 { code, message }，方便断言「失败得对不对」。 */
async function expectFailure(fn) {
  try {
    await fn();
    return { code: '(没有失败)', message: '' };
  } catch (err) {
    if (err instanceof SourcingError) {
      return { code: err.code, message: err.message, retryable: err.retryable, userMessage: err.userMessage };
    }
    return { code: `(非 SourcingError: ${err?.name})`, message: String(err?.message ?? err) };
  }
}

console.log('405nm M4 抓取客户端验证');
console.log(`出口：${PROXY ? maskProxy(PROXY) : '直连'}　报告端点：${REPORT_URL}\n`);

// ── 一、客户端能不能起来 ────────────────────────────────────
console.log('一、客户端');

{
  // 这条看着像废话，但它是**真实存在的风险**：sharp 就是因为预编译产物要求
  // x86-64-v2，在被虚拟化的机器上容器一启动就崩。impit 也是原生模块，
  // 所以「加载得起来」必须在目标机上单独验一次。
  let loaded = false;
  let loadError = '';
  try {
    const mod = await import('impit');
    loaded = typeof mod.Impit === 'function';
  } catch (err) {
    loadError = String(err?.message ?? err).split('\n')[0];
  }
  record('客户端', 'impit 原生模块能在本机加载', loaded, loadError);
  console.log(`  · 运行环境：${process.platform}/${process.arch} node ${process.version}`);
}

// ── 二、指纹 ────────────────────────────────────────────────
console.log('\n二、指纹（这次 spike 的全部意义所在）');

let report = null;
{
  const failure = await expectFailure(async () => {
    const res = await sourcingFetch(REPORT_URL);
    report = JSON.parse(res.body.toString('utf8'));
  });

  record(
    '指纹',
    '能取到指纹报告（取不到就是本机出不了网 —— 环境问题，不是代码问题）',
    report !== null,
    failure.code === '(没有失败)' ? '报告无法解析' : `${failure.code}：${failure.message}`,
  );

  if (report) {
    const ja4 = String(report?.tls?.ja4 ?? '');
    const ja4Cipher = ja4.split('_')[1] ?? '';
    // 8daaf6152771 = 真 Chrome 的 JA4 cipher hash。
    // 这条是**回归护栏**：impit 升级、或有人改了客户端的构造参数，
    // 伪装会静默退化 —— 不报错，只是某天开始被某些站点拦。
    record(
      '指纹',
      'JA4 的密码套件哈希与真 Chrome 一致（8daaf6152771）',
      ja4Cipher === '8daaf6152771',
      `实际 ja4=${ja4 || '(取不到)'}`,
    );

    record('指纹', 'JA4 是「15 个套件 / HTTP/2 / TLS1.3」的形态', ja4.startsWith('t13d1516h2_'), ja4);

    const akamai = String(report?.http2?.akamai_fingerprint ?? '');
    // 候选方案 1（Node http2）在这一项上会露馅：它的 SETTINGS 帧里有个
    // 32MB 的初始窗口，一眼不是浏览器。
    record(
      '指纹',
      'HTTP/2 的 Akamai 指纹是浏览器形态（不是 Node http2 的 32MB 初始窗口）',
      Boolean(akamai) && !akamai.includes('33554432'),
      `akamai=${akamai || '(取不到)'}`,
    );

    record(
      '指纹',
      '协商到了 HTTP/2',
      String(report?.http_version ?? '').toLowerCase().includes('2'),
      `http_version=${report?.http_version}`,
    );
  }
}

// ── 三、失败分类 ────────────────────────────────────────────
// 全部打本机起的小服务：不依赖任何外部站点的行为，离线也能跑。
// 分类的意义在于它决定了后续动作 —— 重试、换出口、还是让用户改链接。
console.log('\n三、失败分类（决定「重试」与「换出口」怎么分流）');

{
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (path === '/404') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (path === '/403-plain') {
      // 源站自己回的 403（比如缺 Referer）—— 不是机器人拦截
      res.writeHead(403);
      res.end('forbidden: missing referer');
      return;
    }
    if (path === '/403-cloudflare') {
      // Cloudflare 的挑战页形态 —— 这才是「被拦」
      res.writeHead(403, { server: 'cloudflare' });
      res.end('<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>');
      return;
    }
    if (path === '/429') {
      res.writeHead(429);
      res.end('slow down');
      return;
    }
    if (path === '/500') {
      res.writeHead(500);
      res.end('upstream is sad');
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const at = (p) => `http://127.0.0.1:${port}${p}`;
  // 本机地址必须显式直连 —— 配了 SOURCING_PROXY 时，请求默认会走代理，
  // 而代理到不了我们这个临时端口。
  const direct = { proxyUrl: null, timeoutMs: 8000 };

  try {
    const ok = await sourcingFetch(at('/ok'), direct);
    record('分类', '200 正常返回，body 原样拿到', ok.status === 200 && ok.body.length === 4, `${ok.status}/${ok.body.length}B`);

    const bad = await expectFailure(() => sourcingFetch('这不是一个链接', direct));
    record('分类', '乱写的链接 → INVALID_URL', bad.code === 'INVALID_URL', bad.code);

    const ftp = await expectFailure(() => sourcingFetch('ftp://example.com/x.jpg', direct));
    record('分类', '非 http(s) 协议 → UNSUPPORTED', ftp.code === 'UNSUPPORTED', ftp.code);

    const nf = await expectFailure(() => sourcingFetch(at('/404'), direct));
    record('分类', '404 → NOT_FOUND，且**不可重试**', nf.code === 'NOT_FOUND' && nf.retryable === false, nf.code);

    const plain403 = await expectFailure(() => sourcingFetch(at('/403-plain'), direct));
    record(
      '分类',
      '普通 403（缺 Referer）→ HTTP_STATUS，**不误判成被拦**',
      plain403.code === 'HTTP_STATUS',
      plain403.code,
    );

    const cf403 = await expectFailure(() => sourcingFetch(at('/403-cloudflare'), direct));
    record(
      '分类',
      '带 Cloudflare 挑战页特征的 403 → BLOCKED（要人去换出口）',
      cf403.code === 'BLOCKED',
      cf403.code,
    );

    const rl = await expectFailure(() => sourcingFetch(at('/429'), direct));
    record('分类', '429 → RATE_LIMITED，且可重试', rl.code === 'RATE_LIMITED' && rl.retryable === true, rl.code);

    const s500 = await expectFailure(() => sourcingFetch(at('/500'), direct));
    record('分类', '5xx → UPSTREAM_ERROR，且可重试', s500.code === 'UPSTREAM_ERROR' && s500.retryable === true, s500.code);

    const noHost = await expectFailure(() =>
      sourcingFetch('https://this-host-does-not-exist-405nm.invalid/', { proxyUrl: null, timeoutMs: 8000 }),
    );
    record('分类', '域名不存在 → NETWORK（直连时不该报成 PROXY）', noHost.code === 'NETWORK', noHost.code);

    if (PROXY) {
      // impit 在连接层分不出「代理挂了」和「目标不可达」（实测它抛的是
      // ConnectError 而不是某个 Proxy* 错误），所以配置了代理时连接失败一律
      // 归为 PROXY —— 两种情况该做的事是同一件：去查出口。
      const badProxy = await expectFailure(() =>
        sourcingFetch(REPORT_URL, { proxyUrl: 'http://127.0.0.1:9', timeoutMs: 5000 }),
      );
      record('分类', '配了代理时连接失败 → PROXY（而不是 NETWORK）', badProxy.code === 'PROXY', badProxy.code);
    } else {
      console.log('  · 未配置 SOURCING_PROXY，跳过「代理连接失败」这一条');
    }

    // 用户可读的一句话不能夹带内部细节。
    record(
      '分类',
      '给用户的消息里不含 URL / 上游原文',
      !nf.userMessage.includes('127.0.0.1') && !cf403.userMessage.includes('cf-chl'),
      `${nf.userMessage} / ${cf403.userMessage}`,
    );
  } finally {
    server.close();
  }
}

// ── 四、代理 ────────────────────────────────────────────────
console.log('\n四、代理');

if (!PROXY) {
  console.log('  · 未配置 SOURCING_PROXY —— 直连环境下这是正常的，跳过');
} else {
  // 打一个**不存在的作品 id**：404 表示请求穿到了源站、只是路径不对；
  // 403 / 503 才是被拦。这条把「网络不通」与「被拦截」分开了。
  const through = await expectFailure(() => sourcingFetch(PIXIV_PROBE, { proxyUrl: PROXY }));
  record(
    '代理',
    '经代理能到达 Pixiv（404 = 到达源站）',
    through.code === 'NOT_FOUND',
    `${through.code}：${through.message}`,
  );

  // 直连的结果**只记录不断言**：它取决于部署环境（内网里不通，开发机可能通），
  // 断言它会把「环境差异」误判成「代码问题」。
  const direct = await expectFailure(() =>
    sourcingFetch(PIXIV_PROBE, { proxyUrl: null, timeoutMs: 8000 }),
  );
  console.log(`  · 参考：同一地址直连得到 ${direct.code}${direct.code === 'NOT_FOUND' ? '（本机可直接出网）' : ''}`);
}

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`);
  process.exit(1);
}
console.log('全部通过。');
