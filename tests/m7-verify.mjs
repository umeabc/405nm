#!/usr/bin/env node
/**
 * M7 迁移验证：纯函数映射 + 一份**自己造的**旧库快照 → 迁移两次 → 核验。
 *
 *   node tests/m7-verify.mjs [baseUrl]
 *
 * 跑法（与 m1~m6 一致，脚本在容器网络里，所以直接打 backend:3000）：
 *   docker compose -f deploy/docker-compose.yml run --rm \
 *     -v /opt/405nm/tests:/repo/tests:ro backend node /repo/tests/m7-verify.mjs
 *
 * 为什么造假快照而不是对着旧站跑：断言里的每个期望值都要**能独立算出来**。
 * 拿旧站数据当输入，就只能说「迁出来的和迁出来的一样」。这里每个 ObjectId、
 * 每条译文候选、每个署名串都是脚本自己摆的，所以「该选中哪一份」「该记几条台账」
 * 有唯一正确答案，迁错了就一定对不上。
 *
 * 脚本会写库（迁移本来就要写），但数据全带 `moeflow:` 前缀的 legacy_id，
 * 与站上真实数据互不干扰；重复跑不会累积（迁移本身就是幂等的）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { makePng } from './lib/png.mjs';
import { closeDb, db } from '../backend/dist/db/client.js';
import * as S from '../backend/dist/db/schema.js';
import { needsRehash, verifyPassword } from '../backend/dist/auth/password.js';
import { dirSource } from '../backend/dist/migrate/images.js';
import { compareCandidates, planGroup } from '../backend/dist/migrate/plan-content.js';
import { checkExport, runMigration } from '../backend/dist/migrate/run.js';
import {
  bboxOf,
  canonicalCredits,
  deriveFileState,
  mapLegacyPermissions,
  mapPosition,
  mapProjectStatus,
  pickUsername,
  splitCredits,
} from '../backend/dist/migrate/rules.js';
import { dateOr, lid, MoeflowExport, oidTime, uuidv5 } from '../backend/dist/migrate/source.js';
import { Report } from '../backend/dist/migrate/report.js';
import { variantKey } from '../backend/dist/storage/keys.js';
import { storage } from '../backend/dist/storage/index.js';

const BASE = (process.argv[2] ?? 'http://backend:3000/api').replace(/\/$/, '');
const ROOT = process.env.M7_DIR ?? '/tmp/m7-fixture';
const EXPORT_DIR = path.join(ROOT, 'export');
const IMAGES_DIR = path.join(ROOT, 'images');
const REPORT_PATH = path.join(ROOT, 'report.json');
const RUN = Date.now().toString(36);

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

/** 24 位 hex 的假 ObjectId：前 4 字节当时间戳（迁移会用 oidTime 推创建时间）。 */
const STAMP = Math.floor(Date.parse('2026-01-02T03:04:05Z') / 1000)
  .toString(16)
  .padStart(8, '0');
const oid = (tag) => STAMP + crypto.createHash('sha1').update(`${RUN}:${tag}`).digest('hex').slice(0, 16);

/** werkzeug 的两代哈希，salt 按 **UTF-8 字符串**参与运算（与 backend/src/auth/password.ts 的复刻一致）。 */
function werkzeugScrypt(password, salt) {
  const hex = crypto
    .scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 + 32 * 1024 * 1024 })
    .toString('hex');
  return `scrypt:32768:8:1$${salt}$${hex}`;
}
function werkzeugPbkdf2(password, salt) {
  const hex = crypto.pbkdf2Sync(password, salt, 600000, 64, 'sha256').toString('hex');
  return `pbkdf2:sha256:600000$${salt}$${hex}`;
}

// ── 造一份旧库快照 ──────────────────────────────────────────
// 每个 id 都记下来：断言要按 id 去库里查，不靠「列表里的第几个」猜（踩过这个坑）。

const U1 = oid('u1');
const U2 = oid('u2');
const TEAM = oid('team');
const ROLE_SYS = oid('roleSys');
const ROLE_CUSTOM = oid('roleCustom');
const TUR1 = oid('tur1');
const TUR2 = oid('tur2');
const PSET1 = oid('pset1');
const PSET2 = oid('pset2');
const PROJ = oid('proj');
const PROJ_ORPHAN = oid('projOrphan');
const PROLE_CREATOR = oid('proleCreator');
const PROLE_CUSTOM = oid('proleCustom');
const LANG_ZH = oid('langZh');
const LANG_JA = oid('langJa');
const T1 = oid('t1');
const T2 = oid('t2');
const F_MAIN = oid('fMain');
const F_REV = oid('fRev');
const F_MISSING = oid('fMissing');
const F_REV2 = oid('fRev2');
const F_FOLDER = oid('fFolder');
const F_ORPHAN = oid('fOrphan');
const S1 = oid('s1');
const S2 = oid('s2');
const S3 = oid('s3');
const S4 = oid('s4');
const TR1 = oid('tr1');
const TR2 = oid('tr2');
const TR3 = oid('tr3');
const TR4 = oid('tr4');
const TR5 = oid('tr5');
const TR6 = oid('tr6');
const TR8 = oid('tr8');
const NOTICE = oid('notice');
const NOTICE_GONE = oid('noticeGone');
const UNR = oid('unr');
const INV = oid('inv');
const INV2 = oid('inv2');

const PASSWORD = 'Moeflow!2026';
// 用户名、邮箱、团队名、邀请码在库里都是唯一的。上一次运行迁进来的行带 legacy_id，
// 不会被算作「站内已有」，所以这些字段必须每次运行都不一样，否则第二次跑就撞唯一键。
const USERNAME_1 = `Violin_Ada_${RUN}`;
const EMAIL_1 = `violin-${RUN}@example.com`;
const EMAIL_2 = `jia-${RUN}@example.com`;
const TEAM_NAME = `旧站验证组-${RUN}`;
const PROJECT_NAME = `测试作品-${RUN}`;
const INVITE_CODE = `abc-${RUN}`;
/** 旧站里的用户昵称：署名串按名字对账号，必须与之一致 */
const NAME_1 = `Violin Ada ${RUN}`;
const NAME_2 = `甲${RUN}`;
const ARCHIVED_AT = Date.parse('2026-01-05T06:07:08Z');
/** 两张真图：字节必须不同，否则第二张会被团队级 md5 去重挡掉 */
const PNG_MAIN = makePng(120, 80, [200, 30, 40]);
const PNG_REV = makePng(60, 90, [10, 200, 90]);
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');
/** 浮点数不能写等号：0.3 - 0.1 在 double 上是 0.19999999999999998 */
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

const COLLECTIONS = {
  user: [
    // 带空格的用户名在本站不合规 → 登录名会被改写；邮箱大小写不一 → 统一小写
    { _id: U1, n: NAME_1, e: EMAIL_1.toUpperCase(), s: '签名', a: 'avatar.png', p: werkzeugScrypt(PASSWORD, 'a1b2c3d4e5f60718'), admin: true },
    { _id: U2, n: NAME_2, e: EMAIL_2, p: werkzeugPbkdf2(PASSWORD, '0f1e2d3c4b5a6978') },
  ],
  team: [
    // dr 指向自定义角色（默认角色不是系统角色）；u=5 是人数上限；m_a=2 是「允许任何人申请」；om 是 OCR 用量
    { _id: TEAM, n: TEAM_NAME, i: '旧站团队', a: 'team.png', dr: ROLE_CUSTOM, u: 5, m_a: 2, om: 10 },
  ],
  team_role: [
    // 全局系统角色（g 为空、m_s=true）；1010 是「自动成为项目管理员」，9999 认不出
    { _id: ROLE_SYS, m_s: true, m_n: '创建人', m_l: 500, m_i: '团队创建人', m_o: 'creator', m_p: [1010, 1020, 9999] },
    { _id: ROLE_CUSTOM, g: TEAM, m_n: '审校助理', m_l: 50, m_d: '', m_p: [1020] },
  ],
  team_user_relation: [
    { _id: TUR1, g: TEAM, u: U1, r: ROLE_CUSTOM },
    // 角色引用失效 → 退到团队默认角色，并记一条有损点
    { _id: TUR2, g: TEAM, u: U2, r: oid('noSuchRole'), m_t: ['标签'] },
  ],
  project_set: [
    { _id: PSET1, t: TEAM, n: '默认', d: true, i: '' },
    // 同一团队里重名 → 后一个加序号
    { _id: PSET2, t: TEAM, n: '默认', d: false },
  ],
  project: [
    {
      _id: PROJ,
      t: TEAM,
      ps: PSET2,
      n: PROJECT_NAME,
      i: '简介',
      u: 5,
      sn: '原名A',
      tn: '译名B',
      ol: LANG_JA,
      st: 1,
      ta: ['标签'],
      tb: [oid('termBank')],
      m_a: 2,
      ft: { $date: ARCHIVED_AT },
    },
    { _id: PROJ_ORPHAN, t: oid('noSuchTeam'), ps: PSET1, n: '孤儿作品', ol: LANG_ZH, st: 0 },
  ],
  project_role: [
    { _id: PROLE_CREATOR, m_s: true, m_n: '创建人', m_l: 500, m_o: 'creator', m_p: [1010] },
    { _id: PROLE_CUSTOM, g: PROJ, m_n: '嵌字助理', m_l: 150, m_p: [1020] },
  ],
  project_user_relation: [
    { _id: oid('pur1'), g: PROJ, u: U1, r: PROLE_CREATOR },
    { _id: oid('pur2'), g: PROJ, u: U2, r: PROLE_CUSTOM },
  ],
  language: [
    { _id: LANG_ZH, co: 'zh-CN', c: '中文（简体）', e: 'Chinese' },
    { _id: LANG_JA, co: 'ja', c: '日本語', e: 'Japanese' },
  ],
  target: [
    { _id: T1, t: PROJ, l: LANG_ZH, i: '目标介绍' },
    // 同语言 → 合并。**先落哪个由 _id 顺序决定**，所以两个都要带上会触发有损点的字段
    { _id: T2, t: PROJ, l: LANG_ZH, i: '目标介绍' },
  ],
  notice: [{ _id: NOTICE, t: '公告标题', c: '公告正文', e: true, cu: U1 }],
  user_notice_read: [
    // 一条指向已删除的公告 → 记有损点后丢弃
    { _id: UNR, u: U1, r: [NOTICE, NOTICE_GONE], ut: { $date: ARCHIVED_AT } },
  ],
  invitation_code: [
    { _id: INV, c: INVITE_CODE, t: TEAM, r: 'admin', e: true, u: 2, cu: U1 },
    { _id: INV2, c: '   ' },
  ],
};

// 文件/标号/译文单独列，因为它们之间要交叉引用，而且注释多
const FILE_DOCS = [
  { _id: F_FOLDER, n: '第1话', t: 1, p: PROJ, sn: '1' },
  // 署名串里 `、` 与 `，` 混用 → 规整成 `、`；同一角色同一名字写两遍 → 台账照记、界面只显示一次
  {
    _id: F_MAIN,
    n: 'p1.png',
    t: 2,
    p: PROJ,
    sa: `${F_MAIN}.png`,
    md: md5(PNG_MAIN),
    fs: 1,
    // 署名串里的名字要与用户昵称逐字一致，否则对不上账号（演练时这里真踩过）
    tl: `${NAME_1}、${NAME_2}`,
    pr: `${NAME_2}，${NAME_2}`,
    tyu: NAME_2,
  },
  // 第二版：ov 指向首版 → revision=2、parent_id 指向链根；ac=false 表示不是当前生效版本
  { _id: F_REV, n: 'p2.png', t: 2, p: PROJ, sa: `${F_REV}.png`, ov: F_MAIN, v: 2, ac: false, md: md5(PNG_REV) },
  // 旧站自己就知道这张图没了（fn=1 未上传）→ 空记录、不算缺图
  { _id: F_MISSING, n: 'p3.png', t: 2, p: PROJ, sa: `${F_MISSING}.png`, fn: 1 },
  // 上一版不迁移（指向一个不迁的文件）→ 修订链在这里断开，本版视作首版
  { _id: F_REV2, n: 'p4.png', t: 2, p: PROJ, sa: `${F_REV2}.png`, ov: F_ORPHAN },
  { _id: F_ORPHAN, n: 'x.png', t: 2, p: oid('noSuchProject'), sa: 'orphan.png' },
];

const SOURCE_DOCS = [
  { _id: S1, f: F_MAIN, r: 0, c: 'こんにちは', x: 0.1, y: 0.2, v: [[0.05, 0.1], [0.3, 0.1], [0.3, 0.3], [0.05, 0.3]], p: 1, lf: true },
  // 坐标越界（原样保留）、框外标号、人工分段、候选术语
  { _id: S2, f: F_MAIN, r: 1, c: 'さようなら', x: 1.4, y: -0.2, v: [], p: 2, lf: false, pt: ['术语'] },
  // rank 为负、原文为空、多边形认不出格式（字符串坐标）
  { _id: S3, f: F_MAIN, r: -2, c: '', x: 0.5, y: 0.5, v: [['x', 'y']], p: 1 },
  { _id: S4, f: F_REV, r: 0, c: 'おはよう', x: 0.3, y: 0.4, p: 1 },
];

const TRANSLATION_DOCS = [
  // 同一标号两份候选，其中一份被选定 → 选定的那份迁过去仍是选中的
  { _id: TR1, o: S1, t: T1, u: U1, c: '你好', p: '', s: false },
  { _id: TR2, o: S1, t: T1, u: U2, c: '您好', p: '', s: true, sr: U1 },
  // 指向被合并掉的目标 T2：落到同一个目标上，作者与 TR2 撞 (标号, 目标, 作者) 唯一键
  { _id: TR8, o: S1, t: T2, u: U2, c: '您好', p: '', s: false },
  // 一份都没选定 → 按旧站的挑法自动选定，且要挑到「有校对稿」的那份
  { _id: TR3, o: S2, t: T1, u: U1, c: '再见', p: '再会了', pr: U2, s: false },
  { _id: TR4, o: S2, t: T1, u: U2, c: '再会', p: '', s: false },
  // 原文为空的标号也有一份空译文：不计入进度，但行要迁
  { _id: TR5, o: S3, t: T1, u: U1, c: '', p: '', s: false },
  { _id: TR6, o: oid('noSuchSource'), t: T1, u: U1, c: '孤儿', p: '', s: false },
];

function writeFixture() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const collections = {
    ...COLLECTIONS,
    file: FILE_DOCS,
    source: SOURCE_DOCS,
    translation: TRANSLATION_DOCS,
  };
  const manifest = { exportedAt: new Date().toISOString(), collections: {} };
  for (const [name, docs] of Object.entries(collections)) {
    // 顺序是**约定**：标号按 _id、译文按 (o,t) —— 迁移工具靠归并读，顺序不对会直接报错
    const sorted =
      name === 'translation'
        ? [...docs].sort((a, b) => (a.o === b.o ? (a.t < b.t ? -1 : 1) : a.o < b.o ? -1 : 1))
        : [...docs].sort((a, b) => (a._id < b._id ? -1 : 1));
    fs.writeFileSync(path.join(EXPORT_DIR, `${name}.json`), `${sorted.map((d) => JSON.stringify(d)).join('\n')}\n`);
    manifest.collections[name] = docs.length;
  }
  fs.writeFileSync(path.join(EXPORT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(IMAGES_DIR, `${F_MAIN}.png`), PNG_MAIN);
  fs.writeFileSync(path.join(IMAGES_DIR, `${F_REV}.png`), PNG_REV);
}

// ── 纯函数 ──────────────────────────────────────────────────

function unitChecks() {
  const g = '纯函数';
  // RFC 4122 的标准示例：v5(DNS, "python.org") —— 自己实现的 uuidv5 必须对得上
  record(
    g,
    'uuidv5 与 RFC 4122 的示例向量一致',
    uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8') === '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
  );
  record(g, 'lid 对同一文档永远给同一个 id', lid('user', U1) === lid('user', U1) && lid('user', U1) !== lid('team', U1));
  record(g, 'oidTime 取 ObjectId 前 4 字节的时间', oidTime(STAMP + '0'.repeat(16)).getTime() === Number.parseInt(STAMP, 16) * 1000);
  record(g, 'dateOr 在日期缺失时退到 ObjectId 时间', dateOr(undefined, U1).getTime() === oidTime(U1).getTime());

  record(g, '署名串按「、」「，」「,」拆分', JSON.stringify(splitCredits('a、b,c，d')) === JSON.stringify(['a', 'b', 'c', 'd']));
  record(g, '署名规范形式用「、」连接', canonicalCredits(' a ，b ') === 'a、b');
  const team1020 = mapLegacyPermissions('team', [1010, 1020, 9999]);
  record(g, '团队权限码 1010 落成 autoProjectAdmin 而不是权限', team1020.autoProjectAdmin && !team1020.codes.includes('1010'));
  record(g, '认不出的权限码计入 unmapped', JSON.stringify(team1020.unmapped) === JSON.stringify([9999]));
  record(g, '作品状态 0/2 是进行中、1/3/4 是已归档', mapProjectStatus(0) === 'active' && mapProjectStatus(2) === 'active' && [1, 3, 4].every((s) => mapProjectStatus(s) === 'archived'));

  const box = bboxOf([[0.1, 0.2], [0.3, 0.5]]);
  record(g, '多边形包围盒（归一化）', near(box.w, 0.2) && near(box.h, 0.3), JSON.stringify(box));
  const box100 = bboxOf([[10, 20], [30, 50]]);
  record(g, '多边形按百分比（0~100）也能算', near(box100.w, 0.2) && near(box100.h, 0.3), JSON.stringify(box100));
  record(g, '没有多边形时宽高为 0', bboxOf([]).w === 0 && bboxOf([]).h === 0);
  record(g, '认不出的多边形返回 null', bboxOf([['x', 'y']]) === null);
  record(g, '标号位置 2 = 框外，其余 = 框内', mapPosition(2) === 'out' && mapPosition(1) === 'in' && mapPosition(undefined) === 'in');

  record(g, '进度推定：没有标号 = 已入库', deriveFileState(0, []) === 'sourced');
  record(g, '进度推定：一份没翻 = 已入库', deriveFileState(3, [{ translated: 0, proofread: 0 }]) === 'sourced');
  record(g, '进度推定：翻了一部分 = 翻译中', deriveFileState(3, [{ translated: 1, proofread: 0 }]) === 'translating');
  record(g, '进度推定：全翻完 = 已翻译', deriveFileState(3, [{ translated: 3, proofread: 0 }]) === 'translated');
  record(g, '进度推定：翻完且校了一部分 = 校对中', deriveFileState(3, [{ translated: 3, proofread: 1 }]) === 'proofreading');
  record(g, '进度推定：全翻全校 = 已校对', deriveFileState(3, [{ translated: 3, proofread: 3 }]) === 'proofread');

  const taken = new Set(['Violin_Ada']);
  record(g, '用户名不合规时改写', pickUsername('Violin Ada', U1, new Set()) === 'Violin_Ada');
  record(g, '用户名被占用时加后缀', pickUsername('Violin Ada', U1, taken) === `Violin_Ada_${U1.slice(-6)}`);

  // 译文候选：选定 > 校对稿非空 > 编辑时间 > _id
  const fakePlan = { userIds: new Set([U1, U2]) };
  const group = TRANSLATION_DOCS.filter((d) => [TR1, TR2, TR8].includes(d._id));
  const sorted = [...group].sort(compareCandidates);
  record(g, '挑选候选：被选定的排最前', sorted[0]._id === TR2, sorted.map((d) => d._id).join(','));
  const { rows, flags } = planGroup(S1, T1, group, fakePlan);
  record(g, '同组只留一份「选中」', rows.filter((r) => r.isSelected).length === 1 && rows.find((r) => r.isSelected).legacyId.endsWith(TR2));
  record(g, '作者撞 (标号,目标,作者) 唯一键时后来者留空', flags.mergedUnlinked === 1 && rows.filter((r) => r.userId).length === 2);
  record(g, '旧站已选定时不改动选择', flags.autoSelected === false && flags.multiSelected === false);
  const proofed = planGroup(S2, T1, TRANSLATION_DOCS.filter((d) => [TR3, TR4].includes(d._id)), fakePlan);
  const best = proofed.rows.find((r) => r.isSelected);
  record(g, '自动选定时挑有校对稿的那份', best.legacyId.endsWith(TR3) && best.proofreadContent === '再会了');
  record(g, '校对者取旧站的校对者', best.proofreaderId === lid('user', U2));
}

const rowById = async (table, id) =>
  (await db.select().from(table).where(eq(table.id, id)).limit(1))[0] ?? null;

/** 有损点清单：迁移报告里必须**逐条**出现，少一条就意味着某类数据被静默处理了。 */
const REQUIRED_KINDS = [
  'folder',
  'orphan-project',
  'orphan-file',
  'project-status-1',
  'project-set-renamed',
  'project-tags',
  'project-names-in-intro',
  'project-max-user',
  'project-open-apply',
  'project-term-banks',
  'target-merged',
  'target-intro',
  'file-bytes-absent-in-legacy',
  'file-bytes-missing',
  'file-revision-unlinked',
  'credit-normalized',
  'credit-duplicate-name',
  'source-xy-out-of-range',
  'source-vertices-unreadable',
  'source-line-feed-false',
  'source-possible-terms',
  'translation-orphan',
  'translation-auto-selected',
  'translation-user-unlinked-merge',
  'user-renamed',
  'user-avatar',
  'user-signature',
  'team-avatar',
  'team-ocr-quota',
  'team-open-apply',
  'team-member-role-fallback',
  'team-member-tags',
  'invite-empty-code',
  'orphan-notice-read-notice',
];

async function main() {
  console.log(`\n405nm M7 迁移验证 —— ${BASE}\n   快照：${EXPORT_DIR}\n`);
  writeFixture();
  unitChecks();

  // ── 导出自检：两条必须拦住的情形 ──
  const bogusDir = path.join(ROOT, 'bogus');
  fs.cpSync(EXPORT_DIR, bogusDir, { recursive: true });
  const bogusManifest = JSON.parse(fs.readFileSync(path.join(bogusDir, 'manifest.json'), 'utf8'));
  bogusManifest.collections.mystery_collection = 1;
  fs.writeFileSync(path.join(bogusDir, 'manifest.json'), JSON.stringify(bogusManifest));
  fs.writeFileSync(path.join(bogusDir, 'mystery_collection.json'), `${JSON.stringify({ _id: oid('mystery') })}\n`);
  const bogusReport = new Report(true);
  await checkExport(new MoeflowExport(bogusDir), bogusReport);
  record('导出自检', '没登记去向的集合 → 失败', bogusReport.failed);

  const truncatedDir = path.join(ROOT, 'truncated');
  fs.cpSync(EXPORT_DIR, truncatedDir, { recursive: true });
  const truncatedManifest = JSON.parse(fs.readFileSync(path.join(truncatedDir, 'manifest.json'), 'utf8'));
  truncatedManifest.collections.source += 5;
  fs.writeFileSync(path.join(truncatedDir, 'manifest.json'), JSON.stringify(truncatedManifest));
  const truncatedReport = new Report(true);
  await checkExport(new MoeflowExport(truncatedDir), truncatedReport);
  record('导出自检', '行数与 manifest 不符（导出被截断）→ 失败', truncatedReport.failed);

  // ── 盘点不写库 ──
  const images = dirSource(IMAGES_DIR);
  const inventory = await runMigration({ exportDir: EXPORT_DIR, images, mode: 'inventory', reportPath: REPORT_PATH });
  const afterInventory = await rowById(S.teams, lid('team', TEAM));
  record('盘点', 'inventory 一行都不写', !inventory.failed && afterInventory === null);

  // ── 迁移 ──
  const first = await runMigration({ exportDir: EXPORT_DIR, images, mode: 'migrate', reportPath: REPORT_PATH });
  const failedChecks = first.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}：${c.detail}`);
  record('迁移', '没有硬性对账失败', !first.failed, failedChecks.join(' | '));
  const kinds = new Set(first.lossy.keys());
  const missingKinds = REQUIRED_KINDS.filter((k) => !kinds.has(k));
  record('有损点', `逐类记全（共 ${REQUIRED_KINDS.length} 类）`, missingKinds.length === 0, `缺：${missingKinds.join('、')}`);

  for (const [name, expected] of [
    ['users', 2],
    ['teams', 1],
    ['projects', 1],
    ['files', 4],
    ['sources', 4],
    ['translations', 6],
  ]) {
    record('计数', `${name}（源 ${expected}）`, first.counts[name]?.source === expected, JSON.stringify(first.counts[name]));
  }

  // ── 落库结果：逐条按 id 查，不靠列表位置猜 ──
  const u1 = await rowById(S.users, lid('user', U1));
  record('用户', '登录名改写（空格换成下划线）、邮箱转小写', u1?.username === USERNAME_1 && u1?.email === EMAIL_1, `${u1?.username}/${u1?.email}`);
  record(
    '用户',
    'werkzeug 哈希原样搬、标注算法、标记为待升级',
    u1?.passwordAlgo === 'werkzeug-scrypt' && u1.passwordHash.startsWith('scrypt:32768:8:1$') && needsRehash(u1.passwordHash),
  );
  record('用户', '站点管理员标记跟着迁', u1?.isSiteAdmin === true);
  const u2 = await rowById(S.users, lid('user', U2));
  record('用户', 'pbkdf2 也认得，且能用原密码校验', u2?.passwordAlgo === 'werkzeug-pbkdf2' && (await verifyPassword(PASSWORD, u2.passwordHash)));

  const team = await rowById(S.teams, lid('team', TEAM));
  record(
    '团队',
    '人数上限照迁；默认角色是旧站指定的自定义角色',
    team?.maxMembers === 5 && team?.defaultRoleId === uuidv5(`moeflow:team_role:${ROLE_CUSTOM}`),
  );
  record('团队', '作品编号游标越过迁进来的作品', team?.projectSeq === 1);

  const creatorRole = await rowById(S.roles, uuidv5(`moeflow:team_role:${ROLE_SYS}@${TEAM}`));
  record(
    '角色',
    '全局系统角色按团队复制一份，等级与名称照旧',
    creatorRole?.level === 500 && creatorRole?.isSystem === true && creatorRole?.systemCode === 'creator',
  );
  record('角色', '旧的 1010 落成「自动成为作品管理员」开关', creatorRole?.autoProjectAdmin === true);
  const filledRole = await rowById(S.roles, uuidv5(`moeflow:team_role:fill:admin@${TEAM}`));
  record(
    '角色',
    '旧站缺的系统角色按本站默认补建',
    filledRole?.systemCode === 'admin' && String(filledRole?.legacyId).endsWith(`fill:admin@${TEAM}`),
    String(filledRole?.legacyId),
  );

  const project = await rowById(S.projects, lid('project', PROJ));
  record(
    '作品',
    '编号从 1 起、归档时间取旧站完结时间',
    project?.serial === 1 && project?.status === 'archived' && project?.archivedAt?.getTime() === ARCHIVED_AT,
    `${project?.serial}/${project?.status}/${project?.archivedAt?.toISOString()}`,
  );
  record('作品', '原名/译名并进简介', project?.intro.includes('原名：原名A') && project?.intro.includes('译名：译名B'));
  record('作品', '创建人 = 持有「创建人」角色的成员', project?.createdBy === lid('user', U1));
  record('作品', '作品集与源语言', project?.setId === lid('project_set', PSET2) && project?.sourceLanguage === 'ja');
  record('作品集', '同团队重名时加序号', (await rowById(S.projectSets, lid('project_set', PSET2)))?.name === '默认（2）');

  const fMain = await rowById(S.files, lid('file', F_MAIN));
  const fRev = await rowById(S.files, lid('file', F_REV));
  record(
    '文件',
    '字节搬完并算出摘要与尺寸',
    fMain?.md5 === md5(PNG_MAIN) && fMain?.size === PNG_MAIN.length && fMain?.width === 120 && fMain?.height === 80,
  );
  const storedBytes = await storage.getBuffer(fMain.storageKey);
  record('文件', '图片字节确实落在新存储（不只是行写对了）', storedBytes !== null && storedBytes.equals(PNG_MAIN));
  record(
    '文件',
    '缩略图与预览图都生成了',
    (await storage.stat(variantKey(fMain.storageKey, 'thumb'))) !== null &&
      (await storage.stat(variantKey(fMain.storageKey, 'preview'))) !== null,
  );
  record(
    '文件',
    '修订链：版本 2、指向首版、不是当前生效版本',
    fRev?.revision === 2 && fRev?.parentId === lid('file', F_MAIN) && fRev?.oldRevisionId === lid('file', F_MAIN) && fRev?.activated === false,
  );
  record('文件', '旧站本来就没有字节的图建成空记录', (await rowById(S.files, lid('file', F_MISSING)))?.size === 0);
  record('文件', '文件状态按译校进度推定', fMain?.state === 'translating' && fRev?.state === 'sourced', `${fMain?.state}/${fRev?.state}`);

  const s1 = await rowById(S.sources, lid('source', S1));
  record('标号', '归一化坐标 + 多边形包围盒 = 宽高', s1?.x === 0.1 && s1?.y === 0.2 && near(s1?.w, 0.25) && near(s1?.h, 0.2), JSON.stringify([s1?.w, s1?.h]));
  const s2 = await rowById(S.sources, lid('source', S2));
  record(
    '标号',
    '超出画布的坐标原样保留；框外标号；rank 当排序号',
    s2?.x === 1.4 && s2?.y === -0.2 && s2?.positionType === 'out' && s2?.orderIndex === 1,
  );
  const s3 = await rowById(S.sources, lid('source', S3));
  record('标号', '认不出的多边形：宽高 0、vertices 原样保留', s3?.w === 0 && s3?.h === 0 && JSON.stringify(s3?.vertices) === JSON.stringify([['x', 'y']]));
  record('标号', '负的 rank 也照迁（本站的排序号只要求是整数）', s3?.orderIndex === -2);

  const s1Translations = await db.select().from(S.translations).where(eq(S.translations.sourceId, lid('source', S1)));
  const selectedRows = s1Translations.filter((r) => r.isSelected);
  record('译文', '同一 (标号, 目标) 只留一份选中', selectedRows.length === 1 && selectedRows[0].content === '您好', selectedRows.map((r) => r.content).join(','));
  record('译文', '合并目标后作者撞唯一键：后来者留空', s1Translations.length === 3 && s1Translations.filter((r) => r.userId === null).length === 1);
  const s2Translations = await db.select().from(S.translations).where(eq(S.translations.sourceId, lid('source', S2)));
  const s2Best = s2Translations.find((r) => r.isSelected);
  record(
    '译文',
    '自动选定挑到带校对稿的那份，并带上校对者与校对时间',
    s2Best?.content === '再见' && s2Best?.proofreadContent === '再会了' && s2Best?.proofreaderId === lid('user', U2) && s2Best?.proofreadAt !== null,
  );
  record('译文', '标号已不存在的译文不迁', (await rowById(S.translations, lid('translation', TR6))) === null);

  const credits = await db.select().from(S.fileCredits).where(eq(S.fileCredits.fileId, lid('file', F_MAIN))).orderBy(S.fileCredits.seq);
  const wantCredits = [
    `translator:${NAME_1}:${lid('user', U1)}`,
    `translator:${NAME_2}:${lid('user', U2)}`,
    `proofreader:${NAME_2}:${lid('user', U2)}`,
    `proofreader:${NAME_2}:`,
    `typesetter:${NAME_2}:${lid('user', U2)}`,
  ].join('|');
  const gotCredits = credits.map((c) => `${c.role}:${c.displayName}:${c.userId ?? ''}`).join('|');
  record('署名', '台账顺序 = 旧站 token 顺序（这一条错了，显示出来的署名会静默变序）', gotCredits === wantCredits, gotCredits);

  const reads = await db.select().from(S.noticeReads).where(eq(S.noticeReads.userId, lid('user', U1)));
  record('公告', '已读记录逐条落库；指向已删公告的那条丢弃', reads.length === 1 && reads[0].noticeId === lid('notice', NOTICE));
  const invite = await rowById(S.inviteCodes, lid('invitation_code', INV));
  record(
    '邀请码',
    '码统一大写、使用次数照迁、角色指向本团队的系统角色',
    invite?.code === INVITE_CODE.toUpperCase() && invite?.usedCount === 2 && invite?.roleId === uuidv5(`moeflow:team_role:fill:admin@${TEAM}`),
    `${invite?.code}/${invite?.usedCount}`,
  );

  const history = await db.select().from(S.fileStates).where(eq(S.fileStates.fileId, lid('file', F_MAIN)));
  record('状态流水', '每个文件一条当前态记录，并写明是迁入时推定的', history.length === 1 && history[0].toState === 'translating' && history[0].note.includes('迁移'));

  // ── 幂等：重跑一行都不该写 ──
  const second = await runMigration({ exportDir: EXPORT_DIR, images, mode: 'migrate', reportPath: REPORT_PATH });
  const insertedOnRerun = Object.values(second.counts).reduce((sum, c) => sum + c.inserted, 0);
  record('幂等', '重跑不写新行，且自带的核验仍然通过', insertedOnRerun === 0 && !second.failed, `本次写入 ${insertedOnRerun} 行`);

  // ── 核验要真的会失败（否则它只是一段自我安慰）──
  await db.delete(S.sources).where(eq(S.sources.id, lid('source', S1)));
  const broken = await runMigration({ exportDir: EXPORT_DIR, images, mode: 'verify', reportPath: REPORT_PATH });
  record('核验', '少了一行 → 判失败', broken.failed, broken.checks.filter((c) => c.status === 'fail').map((c) => c.name).join(','));
  const restored = await runMigration({ exportDir: EXPORT_DIR, images, mode: 'migrate', reportPath: REPORT_PATH });
  record('续跑', '重跑把缺的行补回来，整轮核验重新通过', !restored.failed && restored.counts.sources.inserted === 1, JSON.stringify(restored.counts.sources));

  await db.update(S.translations).set({ content: '被改过的译文' }).where(eq(S.translations.id, lid('translation', TR1)));
  const tampered = await runMigration({ exportDir: EXPORT_DIR, images, mode: 'verify', reportPath: REPORT_PATH });
  record('核验', '字段被改过 → 判失败（逐字段比对不是为了好看）', tampered.failed, tampered.checks.filter((c) => c.status === 'fail').map((c) => c.name).join(','));
  // 迁移**只增不改**：被改脏的行要人工处理，这里把行删掉，重跑会按旧库内容补回来
  await db.delete(S.translations).where(eq(S.translations.id, lid('translation', TR1)));
  const repaired = await runMigration({ exportDir: EXPORT_DIR, images, mode: 'migrate', reportPath: REPORT_PATH });
  record('续跑', '删掉的行重跑会按旧库内容补回', !repaired.failed && repaired.counts.translations.inserted === 1);

  // ── 迁来的账号：用原密码登录，并在登录后升级哈希 ──
  const login = async (username) => {
    const res = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const byName = await login(USERNAME_1);
  record('登录', '改写过用户名的账号能用新用户名登录', byName.status === 200, JSON.stringify(byName.body));
  const upgraded = await rowById(S.users, lid('user', U1));
  record(
    '登录',
    '登录成功后旧格式自动升级为本站 scrypt',
    upgraded?.passwordAlgo === 'scrypt' && upgraded.passwordHash.startsWith('scrypt$') && !needsRehash(upgraded.passwordHash),
    upgraded?.passwordAlgo,
  );
  record('登录', '升级后的哈希仍能用原密码校验', await verifyPassword(PASSWORD, upgraded.passwordHash));
  const byEmail = await login(EMAIL_2.toUpperCase());
  record('登录', '邮箱登录忽略大小写', byEmail.status === 200, JSON.stringify(byEmail.body));

  // ── 汇总 ────────────────────────────────────────────────────
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
  if (failures.length > 0) {
    console.log('\n失败明细：');
    for (const f of failures) console.log(`  ✗ [${f.group}] ${f.name} —— ${f.detail}`);
    process.exit(1);
  }
  console.log('M7 迁移链路全部通过（含「核验在数据被改动时会失败」的反向验证）。');
}

try {
  await main();
} catch (err) {
  console.error('\n脚本自身出错：', err);
  process.exitCode = 1;
} finally {
  // ⚠️ 必须显式退出：postgres.js 会保活 socket，掉进文件末尾就永远不退出（真栽过一次，卡了 26 分钟）
  await closeDb();
  process.exit(process.exitCode ?? 0);
}
