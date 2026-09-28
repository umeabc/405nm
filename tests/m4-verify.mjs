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
import {
  decryptCredentials,
  encryptCredentials,
  maskCredentials,
} from '../backend/dist/sourcing/credentials.js';
import { importFileName } from '../backend/dist/sourcing/filenames.js';
import { detectSource } from '../backend/dist/sourcing/registry.js';
import { imagesOfTweet, originalUrl } from '../backend/dist/sourcing/sources/twitter.js';
import { imagesOfEmbed } from '../backend/dist/sourcing/sources/bluesky.js';
import { refererFor } from '../backend/dist/sourcing/sources/external.js';

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

// ── 五、链接识别（离线，纯本地判断）──────────────────────────
//
// 这一段看起来琐碎，但它挡的是一类真会发生的错：注册表**按顺序**问每个解析器，
// 谁先认领算谁的。顺序写错（比如把「凡是图片直链都算我的」排到前面），
// 表现是所有链接都被 external 吃掉，而每种链接单看都「能跑」。
console.log('\n五、链接识别');

{
  const cases = [
    ['https://www.pixiv.net/artworks/123456', 'pixiv'],
    ['https://www.pixiv.net/i/123456', 'pixiv'],
    ['https://www.pixiv.net/users/11', 'pixiv_user'],
    ['https://x.com/NASA/status/1234567890', 'twitter'],
    ['https://twitter.com/jack/status/20', 'twitter'],
    ['https://x.com/NASA', 'twitter_user'],
    ['https://bsky.app/profile/bsky.app/post/3abc', 'bluesky'],
    ['https://bsky.app/profile/bsky.app', 'bluesky_user'],
    ['https://i.pximg.net/img-original/img/2020/01/01/00/00/00/1_p0.jpg', 'external'],
    ['https://example.com/cover.png', 'external'],
    // 认不出来的要如实报错，而不是被 external 兜走（它只认图片扩展名）
    ['https://example.com/some/page', null],
    ['https://x.com/home', null],
    ['这不是一个链接', null],
    ['ftp://example.com/a.png', null],
  ];

  for (const [url, expected] of cases) {
    let actual = null;
    try {
      actual = detectSource(url).parser.id;
    } catch {
      actual = null;
    }
    record('识别', `${url.slice(0, 52)} → ${expected ?? '（认不出）'}`, actual === expected, `实际 ${actual ?? '（认不出）'}`);
  }

  // i.pximg.net 直链必须自动带上 Pixiv 的 Referer —— 少了它就是 403，
  // 而用户粘一条图片直链是很自然的操作，不该让他自己去查为什么 403。
  record(
    '识别',
    'i.pximg.net 直链自动带上 Pixiv 的 Referer',
    refererFor('https://i.pximg.net/img-original/img/x/1_p0.png') === 'https://www.pixiv.net/',
    String(refererFor('https://i.pximg.net/img-original/img/x/1_p0.png')),
  );
  record('识别', '普通图床不硬塞 Referer', refererFor('https://example.com/a.png') === undefined);
}

// ── 六、凭据加密 ────────────────────────────────────────────
console.log('\n六、凭据加密（明文绝不落库、也绝不回前端）');

{
  const payload = encryptCredentials({ phpSessId: '1234567_abcdefghijklmnop', bearer: 'AAAA' });
  record('凭据', '加密后的串里不含明文', payload !== '' && !payload.includes('abcdefghijklmnop'), payload.slice(0, 24));
  record(
    '凭据',
    '能原样解回来',
    decryptCredentials(payload).phpSessId === '1234567_abcdefghijklmnop',
    JSON.stringify(decryptCredentials(payload)),
  );
  record('凭据', '空凭据加密成空串（= 没有凭据）', encryptCredentials({}) === '');

  const masked = maskCredentials(payload);
  record(
    '凭据',
    '掩码只留后四位，且不含可逆信息',
    masked.phpSessId === '••••mnop' && !JSON.stringify(masked).includes('1234567'),
    JSON.stringify(masked),
  );
  // 解不开的密文要当作「没配凭据」，而不是抛错：
  // 换了 SESSION_SECRET、或者数据被截断时，正确行为是退回匿名抓取
  // （多数图源匿名可用），而不是让整次导入因为一个陈旧字段直接崩掉。
  const garbage = Buffer.from('x'.repeat(40)).toString('base64');
  record(
    '凭据',
    '解不开的密文当作「没有凭据」而不是抛错',
    Object.keys(decryptCredentials('这不是base64')).length === 0 &&
      Object.keys(decryptCredentials(garbage)).length === 0 &&
      Object.keys(decryptCredentials('')).length === 0,
    JSON.stringify(decryptCredentials(garbage)),
  );
}

// ── 七、解析器的纯函数 ──────────────────────────────────────
//
// 用**真实抓到的返回形状**当夹具。夹具挡的是「我自己改坏了」，
// 挡不住「上游改了」—— 后者靠第八节的真机测试。
console.log('\n七、解析逻辑（夹具来自真实返回）');

{
  // X：syndication 的 tweet-result 形态
  const tweet = {
    id_str: '123',
    text: 'hi',
    user: { screen_name: 'someone' },
    mediaDetails: [
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/AAA.jpg' },
      { type: 'video', media_url_https: 'https://pbs.twimg.com/media/BBB.jpg' },
      { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/CCC.png' },
    ],
  };
  const tweetImages = imagesOfTweet(tweet);
  record('解析', 'X：只取 photo，跳过视频封面', tweetImages.length === 2, JSON.stringify(tweetImages.map((i) => i.filename)));
  record(
    '解析',
    'X：原图地址加 ?name=orig',
    tweetImages.every((i) => i.url.endsWith('?name=orig')),
    tweetImages[0]?.url ?? '',
  );
  record(
    '解析',
    'X：绝不加 format=jpg（PNG 稿件会 404）',
    tweetImages.every((i) => !i.url.includes('format=')),
    tweetImages.map((i) => i.url).join(' '),
  );
  // 文件名里的序号是**源数组里的位置**，跳过的视频仍占一个号 ——
  // 于是两张图是 p1.jpg 与 p3.png。这是有意的：位置本身就是信息
  // （第 3 张媒体是 PNG），而导入时文件名会按顺序重排成 001/002，
  // 所以这里的 pN 只用来决定扩展名。
  record(
    '解析',
    'X：PNG 稿件保留 .png 扩展名（序号跟源位置走）',
    tweetImages[1]?.filename === 'p3.png',
    String(tweetImages[1]?.filename),
  );
  record('解析', 'X：没有媒体时返回空数组（上层报 NO_MEDIA）', imagesOfTweet({ id_str: '1' }).length === 0);
  // 老形态兜底
  record(
    '解析',
    'X：只有 photos[] 的老返回也能取到',
    imagesOfTweet({ photos: [{ url: 'https://pbs.twimg.com/media/DDD.jpg' }] }).length === 1,
  );
  record('解析', 'originalUrl 会去掉已有的查询串', originalUrl('https://x/a.jpg?foo=1') === 'https://x/a.jpg?name=orig');

  // Bluesky：实测拿到的 embed 形态
  const did = 'did:plc:z72i7hdynmk6r22z27h6tvur';
  const bskyImages = imagesOfEmbed(
    {
      $type: 'app.bsky.embed.images#view',
      images: [
        { fullsize: 'https://cdn.bsky.app/img/feed_fullsize/plain/x/aaa', aspectRatio: { width: 4000, height: 3000 } },
        { thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/x/bbb' },
      ],
    },
    did,
    [],
  );
  // 第二条只有 thumb、没有 fullsize，也没有可退回的 blob 引用 —— 它应当被跳过，
  // 而不是拿缩略图冒充正片。缩略图进作品后会一路传到嵌字环节，
  // 那时才发现「这张图怎么这么糊」已经晚了。
  record(
    '解析',
    'Bluesky：取 fullsize 与尺寸',
    bskyImages.length === 1 && bskyImages[0]?.width === 4000 && bskyImages[0]?.height === 3000,
    JSON.stringify(bskyImages),
  );
  record(
    '解析',
    'Bluesky：没有 fullsize 的条目被跳过（不拿缩略图冒充正片）',
    bskyImages.every((i) => !i.url.includes('thumbnail')),
    JSON.stringify(bskyImages.map((i) => i.url)),
  );

  const notes = [];
  const recordWithMedia = imagesOfEmbed(
    { $type: 'app.bsky.embed.recordWithMedia#view', media: { $type: 'app.bsky.embed.images#view', images: [{ fullsize: 'https://cdn.bsky.app/img/x' }] } },
    did,
    notes,
  );
  record('解析', 'Bluesky：引用帖的媒体在 media 层，能递归取到', recordWithMedia.length === 1, JSON.stringify(recordWithMedia));

  const videoNotes = [];
  record(
    '解析',
    'Bluesky：视频帖子不冒充图片，但要留下说明',
    imagesOfEmbed({ $type: 'app.bsky.embed.video#view' }, did, videoNotes).length === 0 && videoNotes.length === 1,
    JSON.stringify(videoNotes),
  );

  // 导入文件名：序号必须左补零，否则 10 会排在 2 前面
  const names = [0, 1, 9, 10, 99, 100].map((i) => importFileName(i, 'png'));
  record(
    '解析',
    '导入文件名左补零（字典序 = 页序）',
    names.join(',') === '001.png,002.png,010.png,011.png,100.png,101.png',
    names.join(','),
  );
}

// ── 八、真机（可选）──────────────────────────────────────────
//
// 默认不跑：它会打真实站点，慢且可能被限流。要跑就设 M4_LIVE=1。
// 它挡的是夹具挡不住的那一类 —— **上游改了返回形态**。
console.log('\n八、真机（M4_LIVE=1 时才跑）');

if (process.env.M4_LIVE !== '1') {
  console.log('  · 未设置 M4_LIVE=1，跳过（这一段会真的去打上游站点）');
} else {
  const { parserById } = await import('../backend/dist/sourcing/registry.js');
  const liveCtx = (maxWorks = 3, maxImages = 3) => ({
    proxyUrl: PROXY || null,
    credentials: {},
    maxWorks,
    maxImages,
  });

  // Pixiv：先问排行榜要一个**当下真实存在**的作品 id，再去解析它 ——
  // 写死一个 id 的话，那个作品哪天被删了这条断言就开始无理由地红。
  try {
    const ranking = await sourcingFetch('https://www.pixiv.net/ranking.php?mode=daily&format=json', {
      proxyUrl: PROXY || null,
    });
    const id = JSON.parse(ranking.body.toString('utf8'))?.contents?.[0]?.illust_id;
    record('真机', 'Pixiv 排行榜可达（用来取一个真实作品 id）', Boolean(id), String(id));

    if (id) {
      const parsed = await parserById('pixiv').parse(new URL(`https://www.pixiv.net/artworks/${id}`), liveCtx(1, 2));
      record(
        '真机',
        'Pixiv 单作品解析出图片，且每张都带 Referer',
        parsed.images.length > 0 && parsed.images.every((i) => i.referer === 'https://www.pixiv.net/'),
        `${parsed.images.length} 张，referer=${parsed.images[0]?.referer ?? '-'}`,
      );
      const first = parsed.images[0];
      if (first) {
        const withRef = await sourcingFetch(first.url, { proxyUrl: PROXY || null, headers: { referer: 'https://www.pixiv.net/' } });
        record('真机', 'Pixiv 图片真的下得下来（带 Referer）', withRef.contentType.startsWith('image/'), withRef.contentType);
      }
    }
  } catch (err) {
    record('真机', 'Pixiv 链路', false, err instanceof Error ? err.message.slice(0, 160) : String(err));
  }

  // Bluesky：公开 API 匿名可用，拿一条真实帖子来解析
  try {
    const feed = await sourcingFetch(
      'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=bsky.app&filter=posts_with_media&limit=1',
      { proxyUrl: PROXY || null },
    );
    const uri = JSON.parse(feed.body.toString('utf8'))?.feed?.[0]?.post?.uri;
    record('真机', 'Bluesky 公开 feed 可达', Boolean(uri), String(uri));

    if (uri) {
      const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri);
      const parsed = await parserById('bluesky').parse(
        new URL(`https://bsky.app/profile/${m[1]}/post/${m[2]}`),
        liveCtx(1, 3),
      );
      record('真机', 'Bluesky 单帖解析出图片', parsed.images.length > 0, `${parsed.images.length} 张`);
    }
  } catch (err) {
    record('真机', 'Bluesky 链路', false, err instanceof Error ? err.message.slice(0, 160) : String(err));
  }

  // X：单条推文接口不需要凭据。用那条永远存在的「第一条推文」——
  // 它**没有图**，所以正好验证 NO_MEDIA 这条路（而不是碰巧断言了别的分支）。
  try {
    const { code } = await (async () => {
      try {
        await parserById('twitter').parse(new URL('https://x.com/jack/status/20'), liveCtx());
        return { code: '(没有失败)' };
      } catch (err) {
        return { code: err instanceof SourcingError ? err.code : String(err) };
      }
    })();
    record('真机', 'X 单贴接口可达，纯文字推文正确报 NO_MEDIA', code === 'NO_MEDIA', code);
  } catch (err) {
    record('真机', 'X 链路', false, err instanceof Error ? err.message.slice(0, 160) : String(err));
  }

  // 想验证「有图的推文」就把链接塞进 M4_TWEET_URL —— 我这边没有一条
  // 能长期存在、且确定带图的推文可以写死在测试里。
  const tweetUrl = process.env.M4_TWEET_URL;
  if (tweetUrl) {
    try {
      const parsed = await parserById('twitter').parse(new URL(tweetUrl), liveCtx(1, 5));
      record('真机', 'X 带图推文解析出图片', parsed.images.length > 0, `${parsed.images.length} 张`);
    } catch (err) {
      record('真机', 'X 带图推文', false, err instanceof Error ? err.message.slice(0, 160) : String(err));
    }
  } else {
    console.log('  · 未设置 M4_TWEET_URL，跳过「带图推文」这一条（需要一条真实链接）');
  }
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
