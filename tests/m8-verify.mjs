#!/usr/bin/env node
/**
 * M8 端到端验证：AI 机翻（模型配置 / 自动标号 / 机翻提案 / 术语库）。
 *
 *   node tests/m8-verify.mjs [baseUrl]
 *
 * 在测试机上跑：
 *   docker compose -f deploy/docker-compose.yml run --rm --name m8mock \
 *     -v /opt/405nm/tests:/repo/tests:ro -e M8_ADMIN_PASSWORD=... \
 *     backend node /repo/tests/m8-verify.mjs
 *
 * **必须带 `--name m8mock`**：脚本在容器里起一个假的模型服务，
 * 后端要按这个主机名回调它。少了这个名字，模型那几条断言会以 502 的面目失败。
 *
 * 为什么造假模型而不是打真实接口：这类用例一旦连外网就注定不可重复 ——
 * 上游限流、模型换了、网络抖动，都会让「同一份代码」今天红明天绿。
 * 假服务只做一件事：按 OpenAI 的格式回一段**我们完全控制**的 JSON，
 * 于是「标号落在哪、译文写没写进去、重跑会不会翻倍」都能精确断言。
 */
import http from 'node:http';
import { eq } from 'drizzle-orm';
import { makePng } from './lib/png.mjs';
import { closeDb, db } from '../backend/dist/db/client.js';
import * as S from '../backend/dist/db/schema.js';
import { extractJson, AiError } from '../backend/dist/ai/client.js';
import { toProposal, DEDUPE_RADIUS } from '../backend/dist/ai/markers.js';
import { matchGlossary } from '../backend/dist/ai/translate.js';
import { parseTermLines } from '../backend/dist/api/routes/terms.js';

const BASE = (process.argv[2] ?? 'http://backend:3000/api').replace(/\/$/, '');
const ADMIN_USERNAME = process.env.M8_ADMIN_USERNAME ?? 'admin';
const ADMIN_PASSWORD = process.env.M8_ADMIN_PASSWORD ?? '';

const RUN_ID = Date.now().toString(36);
const TEAM_NAME = `M8验证组-${RUN_ID}`;
const PROJECT_NAME = `M8作品-${RUN_ID}`;
const MOCK_PORT = Number(process.env.M8_MOCK_PORT ?? 8931);
const MOCK_HOST = process.env.M8_MOCK_HOST ?? 'm8mock';

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

class Client {
  constructor(label) {
    this.label = label;
    this.cookie = '';
  }

  async request(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0];
      if (pair) this.cookie = pair;
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, text };
  }

  get = (p) => this.request('GET', p);
  post = (p, b) => this.request('POST', p, b);
  patch = (p, b) => this.request('PATCH', p, b);
  del = (p) => this.request('DELETE', p);
}

async function uploadImage(client, projectId, filename, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/png' }), filename);
  const headers = {};
  if (client.cookie) headers.cookie = client.cookie;
  const res = await fetch(`${BASE}/projects/${projectId}/files`, { method: 'POST', headers, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ── 假模型服务 ──────────────────────────────────────────────

/** 按请求内容决定回什么：带图 → 标号；纯文字 → 译文。 */
function startMockModel() {
  // state 就是返回出去的那个对象：测试里改 `mock.mode` 能直接改到服务的行为
  const state = { mode: 'ok', seen: [] };
  const seen = state.seen;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }
      const content = JSON.stringify(payload.messages ?? []);
      const hasImage = content.includes('image_url');
      // 取「解码后」的用户文本：整体 JSON 里引号是转义的，拿它正则匹配 id 一条都匹配不到
      const userText = (payload.messages ?? [])
        .filter((m) => m.role === 'user')
        .map((m) =>
          typeof m.content === 'string'
            ? m.content
            : (m.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join(''),
        )
        .join('\n');
      seen.push({ url: req.url, model: payload.model, hasImage, authorization: req.headers.authorization ?? '' });

      if (state.mode === 'auth') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if (state.mode === 'garbage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '今天天气不错，但我没有输出 JSON' } }] }));
        return;
      }

      let answer;
      if (hasImage) {
        // 一次给三种情况：正常框、与既有标号重叠的框（应被丢掉）、空文本（应被丢掉）
        answer = JSON.stringify([
          { box: [0.2, 0.3, 0.2, 0.1], text: 'これは魔王だ', positionType: 'in' },
          { box: [300, 400, 200, 100], text: 'さようなら', positionType: 'out' },
          { box: [0.5, 0.5, 0.1, 0.1], text: '', positionType: 'in' },
        ]);
      } else {
        // 把请求里的每条原文逐条"翻译"成 `[译]原文`，id 原样带回
        const ids = [...userText.matchAll(/"id":"([0-9a-f-]{36})","text":"((?:[^"\\]|\\.)*)"/g)];
        answer = JSON.stringify(
          ids.map(([, id, text]) => ({ id, translated: `[译]${JSON.parse(`"${text}"`)}` })),
        );
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(MOCK_PORT, '0.0.0.0', () => resolve(Object.assign(state, { server })));
  });
}

// ── 纯函数 ──────────────────────────────────────────────────

function unitChecks() {
  const g = '纯函数';

  record(g, 'JSON 解析：裸 JSON', JSON.stringify(extractJson('[{"a":1}]')) === '[{"a":1}]');
  record(
    g,
    'JSON 解析：带 ```json 围栏',
    JSON.stringify(extractJson('```json\n{"markers":[]}\n```')) === '{"markers":[]}',
  );
  record(
    g,
    'JSON 解析：前后有解释文字也能抠出来',
    (() => {
      const parsed = extractJson('好的，结果如下：\n[{"box":[0,0,1,1],"text":"x"}]\n需要我继续吗？');
      return Array.isArray(parsed) && parsed.length === 1 && parsed[0].text === 'x';
    })(),
  );
  record(
    g,
    'JSON 解析：字符串里的括号不算边界',
    (() => {
      const parsed = extractJson('prefix {"text":"a}b]c","n":1} suffix');
      return parsed.text === 'a}b]c' && parsed.n === 1;
    })(),
  );
  record(
    g,
    'JSON 解析：实在没有 JSON 就报 BAD_RESPONSE',
    (() => {
      try {
        extractJson('模型今天不想干活');
        return false;
      } catch (err) {
        return err instanceof AiError && err.code === 'BAD_RESPONSE';
      }
    })(),
  );

  const image = { width: 1000, height: 2000 };
  const normalized = toProposal({ box: [0.2, 0.4, 0.1, 0.2], text: 'あ', positionType: 'in' }, image);
  record(
    g,
    '归一化坐标 → 中心点 + 宽高',
    normalized.x === 0.25 && normalized.y === 0.5 && normalized.w === 0.1 && normalized.h === 0.2 && normalized.positionType === 'in',
    JSON.stringify(normalized),
  );
  const pixels = toProposal({ bbox: [200, 800, 100, 200], text: 'い', type: 'narration' }, image);
  record(g, '像素坐标按送出去的图尺寸归一化', Math.abs(pixels.x - 0.25) < 1e-9 && Math.abs(pixels.y - 0.45) < 1e-9);
  record(g, 'positionType 认得 out / narration', pixels.positionType === 'out');
  const ltrb = toProposal({ left: 0.1, top: 0.1, width: 0.2, height: 0.2, text: 'う' }, image);
  record(g, '认 {left,top,width,height} 写法', Math.abs(ltrb.x - 0.2) < 1e-9 && Math.abs(ltrb.w - 0.2) < 1e-9);
  record(g, '空文本的块丢掉', toProposal({ box: [0, 0, 1, 1], text: '   ' }, image) === null);
  record(g, '没有框的项丢掉', toProposal({ text: 'え' }, image) === null);
  record(g, '中心点落到画面外会被夹回 0~1', toProposal({ box: [0.95, 0.95, 0.2, 0.2], text: 'お' }, image).x === 1);
  record(g, '只要有一个数大于 1 就整体当像素处理', Math.abs(toProposal({ box: [1.2, -0.3, 0.2, 0.2], text: 'か' }, image).x - 0.0013) < 1e-6);

  const glossary = matchGlossary(
    ['これは魔王だ', '勇者よ'],
    [
      { source: '魔王', target: '魔王' },
      { source: 'これは', target: '这是' },
      { source: '不存在', target: 'x' },
      { source: '魔王', target: '重复的应被忽略' },
    ],
    10,
  );
  record(g, '术语命中：只带出现过的词', glossary.map((t) => t.source).join(',') === 'これは,魔王', glossary.map((t) => t.source).join(','));
  record(g, '术语命中：长词在前（截断时先留长词）', matchGlossary(['これは魔王だ'], glossary, 1)[0].source === 'これは');
  record(g, '术语命中：上限生效', matchGlossary(['これは魔王だ'], [{ source: '魔王', target: 'm' }], 0).length === 0);

  const lines = parseTermLines(
    ['# 注释', '魔王\t魔王', 'これは => 这是', '勇者 → 勇者', '王様,国王', '没有分隔符的一行', ''].join('\n'),
  );
  record(g, '术语批量解析：四种分隔符都认', lines.entries.length === 4, JSON.stringify(lines.entries));
  record(g, '术语批量解析：没有分隔符的行计入 skipped', lines.skipped === 1);
  record(g, '术语批量解析：注释与空行不算数', !lines.entries.some((e) => e.source.startsWith('#')));
  record(g, '去重半径是个合理的小值（0.04 量级）', DEDUPE_RADIUS > 0.01 && DEDUPE_RADIUS < 0.2);
}

// ── 主流程 ──────────────────────────────────────────────────

async function main() {
  console.log(`\n405nm M8 验证 —— ${BASE}\n`);
  if (!ADMIN_PASSWORD) {
    console.error('未提供 M8_ADMIN_PASSWORD，无法继续。');
    process.exit(1);
  }
  unitChecks();

  const mock = await startMockModel();
  const admin = new Client('admin');
  const login = await admin.post('/auth/login', { username: ADMIN_USERNAME, password: ADMIN_PASSWORD });
  record('准备', '管理员登录', login.status === 200, JSON.stringify(login.body));

  const team = await admin.post('/teams', { name: TEAM_NAME, intro: 'M8 自动验证' });
  const teamId = team.body?.team?.id;
  record('准备', '建团队', team.status === 200 || team.status === 201, JSON.stringify(team.body));
  const project = await admin.post(`/teams/${teamId}/projects`, { name: PROJECT_NAME, sourceLanguage: 'ja' });
  const projectId = project.body?.project?.id;
  const targetId = (await admin.get(`/projects/${projectId}/exports/targets`)).body?.targets?.[0]?.id;
  record('准备', '建作品与目标语言', !!projectId && !!targetId, `${projectId} / ${targetId}`);

  const uploaded = await uploadImage(admin, projectId, `m8-${RUN_ID}.png`, makePng(800, 1200));
  const fileId = uploaded.body?.uploaded?.[0]?.id;
  record('准备', '上传一页图', [200, 201].includes(uploaded.status) && !!fileId, JSON.stringify(uploaded.body).slice(0, 160));

  // ── 模型配置 ──
  const created = await admin.post('/ai/providers', {
    name: '假模型',
    baseUrl: `http://${MOCK_HOST}:${MOCK_PORT}/v1`,
    chatModel: 'mock-chat',
    visionModel: 'mock-vision',
    apiKey: 'sk-test-1234567890abcd',
    isDefault: true,
  });
  const providerId = created.body?.provider?.id;
  record('模型配置', '能建一份配置', created.status === 201 && !!providerId, JSON.stringify(created.body).slice(0, 200));
  const masked = created.body?.provider?.credentials?.apiKey ?? '';
  record(
    '模型配置',
    'API Key 只回掩码（留末 4 位便于对上「我配的是哪个」）',
    masked.endsWith('abcd') && masked !== 'sk-test-1234567890abcd' && !created.text.includes('sk-test-1234567890abcd'),
    masked,
  );
  record('模型配置', 'hasKey 为真', created.body?.provider?.hasKey === true);

  const patched = await admin.patch(`/ai/providers/${providerId}`, { name: '假模型（改名）' });
  record('模型配置', '改名不动 key', patched.body?.provider?.hasKey === true && patched.body?.provider?.name === '假模型（改名）');

  const badUrl = await admin.post('/ai/providers', { name: '地址不对', baseUrl: '不是网址' });
  record('模型配置', '接口地址不合格会被拒', badUrl.status === 400, JSON.stringify(badUrl.body));

  const second = await admin.post('/ai/providers', { name: '第二份', baseUrl: 'http://127.0.0.1:1/v1', isDefault: true });
  const listAfter = await admin.get('/ai/providers');
  const defaults = (listAfter.body?.providers ?? []).filter((p) => p.isDefault);
  record('模型配置', '默认配置始终只有一份', defaults.length === 1 && defaults[0].id === second.body?.provider?.id, JSON.stringify(defaults.map((p) => p.name)));
  record('模型配置', '站点出口提示随配置返回', typeof listAfter.body?.site?.defaultProxyConfigured === 'boolean');

  const cleared = await admin.patch(`/ai/providers/${second.body?.provider?.id}`, { apiKey: '', isDefault: false });
  record('模型配置', '清空 key 后 hasKey 变假', cleared.body?.provider?.hasKey === false);

  const missing = await admin.post(`/files/${fileId}/ai/markers/propose`, { providerId: '00000000-0000-4000-8000-000000000000' });
  record('模型配置', '拿别人的/不存在的配置会被拒', missing.status === 404 && missing.body?.error === 'AI_PROVIDER_MISSING', JSON.stringify(missing.body));

  // ── 术语库 ──
  const bank = await admin.post(`/teams/${teamId}/term-banks`, { name: 'M8 术语库', intro: '自动验证' });
  const bankId = bank.body?.bank?.id;
  record('术语库', '能建库', bank.status === 201 && !!bankId, JSON.stringify(bank.body).slice(0, 160));
  const dupBank = await admin.post(`/teams/${teamId}/term-banks`, { name: 'M8 术语库' });
  record('术语库', '同名库会被拒', dupBank.status === 409, JSON.stringify(dupBank.body));

  const imported = await admin.post(`/term-banks/${bankId}/terms`, {
    language: 'zh-CN',
    text: ['# 注释行', '魔王\t魔王大人', 'これは => 这是', '没有分隔符的一行'].join('\n'),
  });
  record('术语库', '批量导入解析出两条', imported.status === 201 && imported.body?.count === 2, JSON.stringify(imported.body));

  const reimport = await admin.post(`/term-banks/${bankId}/terms`, { language: 'zh-CN', text: '魔王 => 魔王殿下' });
  record('术语库', '同源词重复导入是覆盖而不是报错', reimport.status === 201 && reimport.body?.count === 1);
  const listed = await admin.get(`/term-banks/${bankId}/terms?language=zh-CN`);
  const mawang = (listed.body?.terms ?? []).find((t) => t.source === '魔王');
  record('术语库', '覆盖后的译文是最新那条', mawang?.target === '魔王殿下', JSON.stringify(mawang));

  await admin.post(`/term-banks/${bankId}/terms`, { language: 'zh-TW', text: '魔王 => 魔王殿下（繁）' });
  const zhTw = await admin.get(`/term-banks/${bankId}/terms?language=zh-TW`);
  record('术语库', '按语言隔离', (zhTw.body?.terms ?? []).length === 1 && zhTw.body?.terms[0]?.language === 'zh-TW');
  const searched = await admin.get(`/term-banks/${bankId}/terms?language=zh-CN&q=${encodeURIComponent('魔王')}`);
  record('术语库', '关键词搜索生效', (searched.body?.terms ?? []).length === 1, JSON.stringify(searched.body?.terms?.length));

  const banks = await admin.get(`/teams/${teamId}/term-banks`);
  record('术语库', '列表带条目数', banks.body?.banks?.[0]?.termCount === 3, JSON.stringify(banks.body?.banks?.map((b) => b.termCount)));

  // ── 自动标号：提案 → 应用 ──
  const propose1 = await admin.post(`/files/${fileId}/ai/markers/propose`, { providerId });
  const proposals1 = propose1.body?.proposals ?? [];
  record('自动标号', '提案回来了', propose1.status === 200 && proposals1.length === 2, JSON.stringify(propose1.body).slice(0, 240));
  record(
    '自动标号',
    '归一化坐标按中心点落位',
    Math.abs(proposals1[0]?.x - 0.3) < 1e-6 && Math.abs(proposals1[0]?.y - 0.35) < 1e-6,
    JSON.stringify(proposals1[0]),
  );
  record(
    '自动标号',
    '像素坐标按实际送出去的图（预览 1333×2000）换算',
    Math.abs(proposals1[1]?.x - 400 / (2000 * (800 / 1200))) < 0.002 && Math.abs(proposals1[1]?.y - 0.225) < 1e-6,
    JSON.stringify(proposals1[1]),
  );
  record('自动标号', '空文本的块被丢掉且计入 dropped', propose1.body?.dropped === 1, String(propose1.body?.dropped));
  record('自动标号', '提案阶段**没有**写任何标号', (await countSources(fileId)) === 0);

  const applied1 = await admin.post(`/files/${fileId}/ai/markers`, { markers: proposals1 });
  record('自动标号', '应用后标号落库', applied1.body?.created === 2 && (await countSources(fileId)) === 2, JSON.stringify(applied1.body));

  const propose2 = await admin.post(`/files/${fileId}/ai/markers/propose`, { providerId });
  // 两条都已经落库了，再跑一次应当**一条都不重复写** —— 这正是「提案可反复跑」的含义
  record(
    '自动标号',
    '再跑一次：两条都与既有标号重叠，一条都不重复写',
    propose2.body?.skipped === 2 && propose2.body?.proposals?.length === 0,
    JSON.stringify(propose2.body).slice(0, 200),
  );
  record('自动标号', '提案里带上「已有几个标号」', propose2.body?.existing === 2);

  // ── 机翻：提案 → 应用 ──
  const translate1 = await admin.post(`/files/${fileId}/ai/translations/propose`, { targetId, providerId });
  record('机翻', '提案覆盖全部有原文的标号', translate1.status === 200 && translate1.body?.proposals?.length === 2 && translate1.body?.requested === 2, JSON.stringify(translate1.body).slice(0, 200));
  record('机翻', '译文来自模型且逐条对应', translate1.body?.proposals?.[0]?.translated?.startsWith('[译]'), JSON.stringify(translate1.body?.proposals?.[0]));
  record('机翻', '术语表只带命中且长词在前', (translate1.body?.glossary ?? []).map((t) => t.source).join(',') === 'これは,魔王', JSON.stringify(translate1.body?.glossary));
  record('机翻', '提案里标注了每条用到的术语', (translate1.body?.proposals?.[0]?.terms ?? []).length === 2);
  record('机翻', '提案阶段**没有**写任何译文', (await countTranslations(fileId)) === 0);

  const apply1 = await admin.post(`/files/${fileId}/ai/translations`, {
    targetId,
    items: translate1.body.proposals.map((p) => ({ sourceId: p.sourceId, translated: p.translated })),
  });
  record('机翻', '应用后写入 2 条候选', apply1.body?.created === 2 && (await countTranslations(fileId)) === 2, JSON.stringify(apply1.body));
  const rows = await db.select().from(S.translations).where(eq(S.translations.targetId, targetId));
  record('机翻', '机翻行标了 machineTranslated、且**没有**被选中', rows.every((r) => r.machineTranslated && !r.isSelected), JSON.stringify(rows.map((r) => [r.machineTranslated, r.isSelected])));
  record('机翻', '写入的内容就是模型给的那份', rows.every((r) => r.content.startsWith('[译]')));

  const apply2 = await admin.post(`/files/${fileId}/ai/translations`, {
    targetId,
    items: translate1.body.proposals.map((p) => ({ sourceId: p.sourceId, translated: `${p.translated}（二版）` })),
  });
  record('机翻', '重跑是刷新同一条候选，不是新增', apply2.body?.created === 0 && apply2.body?.updated === 2 && (await countTranslations(fileId)) === 2, JSON.stringify(apply2.body));

  // 人工改过的那条不许被机翻覆盖
  const human = rows[0];
  await db.update(S.translations).set({ machineTranslated: false, content: '人工译文' }).where(eq(S.translations.id, human.id));
  const apply3 = await admin.post(`/files/${fileId}/ai/translations`, {
    targetId,
    items: [{ sourceId: human.sourceId, translated: '机翻想覆盖' }],
  });
  const afterHuman = (await db.select().from(S.translations).where(eq(S.translations.id, human.id)))[0];
  record('机翻', '人工译文不被覆盖', afterHuman.content === '人工译文' && apply3.body?.skipped?.[0]?.reason === 'human', JSON.stringify(apply3.body));

  // 已被选中的机翻候选也不动
  const machine = rows[1];
  await db.update(S.translations).set({ isSelected: true, content: '选中的版本' }).where(eq(S.translations.id, machine.id));
  const apply4 = await admin.post(`/files/${fileId}/ai/translations`, {
    targetId,
    items: [{ sourceId: machine.sourceId, translated: '又想覆盖' }],
  });
  const afterSelected = (await db.select().from(S.translations).where(eq(S.translations.id, machine.id)))[0];
  record('机翻', '被选中的机翻候选也不动', afterSelected.content === '选中的版本' && apply4.body?.skipped?.[0]?.reason === 'selected', JSON.stringify(apply4.body));

  const foreign = await admin.post(`/files/${fileId}/ai/translations`, {
    targetId,
    items: [{ sourceId: '11111111-1111-4111-8111-111111111111', translated: 'x' }],
  });
  record('机翻', '不属于这一页的标号写不进去', foreign.body?.skipped?.[0]?.reason === 'not-in-file', JSON.stringify(foreign.body));

  const wrongTarget = await admin.post(`/files/${fileId}/ai/translations/propose`, { targetId: projectId, providerId });
  record('机翻', '目标语言不属于这个作品会被拒', wrongTarget.status === 400 && wrongTarget.body?.error === 'TARGET_PROJECT_MISMATCH', JSON.stringify(wrongTarget.body));

  // 模型回的东西看不懂时必须**明确报错**，而不是把空提案当成「识别不出来」
  mock.mode = 'garbage';
  const garbage = await admin.post(`/files/${fileId}/ai/markers/propose`, { providerId });
  record('模型错误', '看不懂的回复报 AI_BAD_RESPONSE', garbage.status === 502 && garbage.body?.error === 'AI_BAD_RESPONSE', JSON.stringify(garbage.body).slice(0, 160));
  mock.mode = 'auth';
  const authFail = await admin.post(`/files/${fileId}/ai/markers/propose`, { providerId });
  record('模型错误', 'key 被拒映射成 401', authFail.status === 401 && authFail.body?.error === 'AI_AUTH', JSON.stringify(authFail.body).slice(0, 160));
  mock.mode = 'ok';

  record('模型调用', '识别用的是 visionModel', mock.seen.some((s) => s.hasImage && s.model === 'mock-vision'));
  record('模型调用', '翻译用的是 chatModel', mock.seen.some((s) => !s.hasImage && s.model === 'mock-chat'));
  record('模型调用', '带上了 Bearer 鉴权头', mock.seen.every((s) => s.authorization.startsWith('Bearer ')));

  await new Promise((resolve) => mock.server.close(resolve));
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
  if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name} —— ${f.detail}`);
    process.exitCode = 1;
  } else {
    console.log('M8 机翻链路全部通过（模型调用走脚本内置的假服务，不碰外网）。');
  }
}

async function countSources(fileId) {
  return (await db.select().from(S.sources).where(eq(S.sources.fileId, fileId))).length;
}

async function countTranslations(fileId) {
  const rows = await db
    .select({ id: S.translations.id })
    .from(S.translations)
    .innerJoin(S.sources, eq(S.sources.id, S.translations.sourceId))
    .where(eq(S.sources.fileId, fileId));
  return rows.length;
}

try {
  await main();
} catch (err) {
  console.error('\n脚本自身出错：', err);
  process.exitCode = 1;
} finally {
  // ⚠️ 必须显式退出：postgres.js 会保活 socket（曾经把验证脚本挂住 26 分钟）
  await closeDb();
  process.exit(process.exitCode ?? 0);
}
