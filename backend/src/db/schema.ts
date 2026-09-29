import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * M0 只落地身份相关的两张表，用于跑通「登录」这条链路。
 * 团队 / 角色 / 项目 / 文件 / 标号 / 翻译 / 台账 / 发布队列等在 M1 之后逐步补，
 * 具体列设计见实施方案第六节。
 *
 * 全局约定：
 *  - 主键 `uuid`，新建数据用 `gen_random_uuid()`；**迁移数据用确定性 uuidv5**
 *    （`uuidv5(NS_405nm, 'moeflow:<collection>:<ObjectId>')`），使迁移天然幂等。
 *  - `legacy_id` 记录来源系统的 id，仅作查询便利，不是正确性前提。
 *  - 时间一律 `timestamptz`。
 */

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    username: text('username').notNull().unique(),
    /**
     * 可选的登录邮箱（一律存小写）。本站注册不收邮箱；这一列是给从 moeflow
     * 迁来的账号用的 —— 那边**用邮箱登录**，迁过来后用户名可能被规整过，
     * 不能指望他们记得新用户名。
     */
    email: text('email').unique(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    /** scrypt = 本站格式；werkzeug-* = 迁移来的旧哈希，首次登录成功后换成 scrypt。 */
    passwordAlgo: text('password_algo').notNull().default('scrypt'),
    avatarKey: text('avatar_key'),
    isSiteAdmin: boolean('is_site_admin').notNull().default(false),
    /** active | disabled */
    status: text('status').notNull().default('active'),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_legacy_id_idx').on(t.legacyId)],
);

/**
 * 会话刻意用「数据库不透明令牌」而不是 JWT：改密码 / 移出团队 / 停用账号时
 * 必须能**立即失效**，JWT 做不到这一点。
 * 库里只存 token 的哈希，明文只在 Cookie 里。
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

// ── 团队与权限 ──────────────────────────────────────────────
//
// 相对 moeflow 的三处刻意改造：
//  1. 权限从角色上的 `List[int]` 枚举码，改成 `role_permissions` **关联表** —— 可查询、可审计。
//  2. `TeamRole.convert_to_project_role()` 那套隐式提权，改成角色上的显式开关 `auto_project_admin`。
//  3. 团队角色与项目角色合到一张 `roles` 表，用 `scope` 区分 —— 两者字段完全同构，
//     分两张表只会让「查一个人的全部角色」变成两次查询。

export const teams = pgTable(
  'teams',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull().unique(),
    intro: text('intro').notNull().default(''),
    avatarKey: text('avatar_key'),
    /**
     * 新成员入团时的默认角色。刻意**不加外键**：teams ↔ roles 互相引用，
     * 加约束就得靠单独的手写迁移来打破循环，而这里的参照完整性风险很低。
     */
    defaultRoleId: uuid('default_role_id'),
    maxMembers: integer('max_members'),
    /**
     * 作品编号（`projects.serial`）的分配器。用「团队行上的计数器」而不是
     * `max(serial)+1`：后者在并发建作品时会撞号，而这里 `UPDATE ... RETURNING`
     * 天然持有行锁，天然原子。作品编号是给人看的（#12），不能有重号。
     */
    projectSeq: integer('project_seq').notNull().default(0),
    /** active | archived */
    status: text('status').notNull().default('active'),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('teams_legacy_id_idx').on(t.legacyId)],
);

/**
 * 角色表只装**团队作用域**的两种角色：
 *  - `scope='team'`：团队成员角色（创建人/管理员/…）。
 *  - `scope='project'`：项目角色的**模板**，供新建项目时批量实例化。
 *
 * 为什么项目角色要另立一张 `project_roles` 而不是复用本表的 `project_id` 列：
 * 复用的话「同一团队下不同项目可以有同名角色」要靠 `(scope, team_id, project_id, name)`
 * 上的 `UNIQUE NULLS NOT DISTINCT` 才成立 —— 因为团队角色的 project_id 是 NULL，
 * 而 PG 默认视 NULL 互不相等，普通唯一索引在 NULL 上等于不生效。
 * 两处 NULL 语义纠缠在一起，是很容易埋雷的写法；分开两张表后，
 * 两张表的唯一键都**不含 NULL 列**，约束语义一目了然。
 *
 * `projectId` 这一列在 M1 曾是占位，从未被写入过，M2 的迁移里删掉。
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** team | project（project 表示「项目角色模板」） */
    scope: text('scope').notNull(),
    /** 两种 scope 下都非空：模板也属于某个团队 */
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 等级：越高权限越大。守卫规则是「只能改动等级严格低于自己的成员」。 */
    level: integer('level').notNull(),
    intro: text('intro').notNull().default(''),
    /** 系统内置角色不可删除 */
    isSystem: boolean('is_system').notNull().default(false),
    systemCode: text('system_code'),
    /** 持有该团队角色的人是否自动成为项目管理员（替代 moeflow 的继承魔法） */
    autoProjectAdmin: boolean('auto_project_admin').notNull().default(false),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('roles_team_idx').on(t.teamId),
    // scope + teamId 都非空，这条约束真正生效。
    uniqueIndex('roles_scope_team_name_uq').on(t.scope, t.teamId, t.name),
  ],
);

/** 权限码目录。角色与权限是多对多，权限码本身是受控词表。 */
export const permissions = pgTable('permissions', {
  code: text('code').primaryKey(),
  /** team | project */
  scope: text('scope').notNull(),
  label: text('label').notNull(),
  intro: text('intro').notNull().default(''),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionCode] })],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId] }),
    index('team_members_user_idx').on(t.userId),
  ],
);

// ── 作品集 / 作品 / 项目角色 ────────────────────────────────
//
// 命名对照（彩翻 → 405nm → 界面）：
//   ProjectSet → project_sets → 作品集
//   Project    → projects     → 作品
//   ProjectRole→ project_roles→ 作品内的角色（创建人/监理/校对/翻译/嵌字…）
//
// 与 moeflow 的两处结构差异：
//  1. moeflow 的 `Target`（项目×语言）在这里叫 `targets`，只登记语言与展示名，
//     **不存计数器** —— 计数器照搬会带进漂移值，一律按需聚合或重算。
//  2. 作品状态分两层：`status` 是生命周期（active/archived，人工可改），
//     「进度到哪一环」则由 `files.state` 聚合**派生**，不落库成可改字段 ——
//     否则同一件事有两处记录，迟早不一致。

export const projectSets = pgTable(
  'project_sets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    intro: text('intro').notNull().default(''),
    /** 末尾排序，小在前 */
    orderIndex: integer('order_index').notNull().default(0),
    /** 封面图。刻意不加外键：projects/files 之间本来就互相引用，见 teams.defaultRoleId 的同款说明。 */
    coverFileId: uuid('cover_file_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_sets_team_name_uq').on(t.teamId, t.name),
    index('project_sets_team_idx').on(t.teamId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** 未归类时为 NULL */
    setId: uuid('set_id').references(() => projectSets.id, { onDelete: 'set null' }),
    /** 团队内自增的作品编号，界面上显示成 `#12`；由 teams.project_seq 原子分配 */
    serial: integer('serial').notNull(),
    name: text('name').notNull(),
    intro: text('intro').notNull().default(''),
    /** 原作者 / 出处，署名行要用 */
    author: text('author').notNull().default(''),
    /** 源语言（作品原文语种），如 ja / en / zh-CN */
    sourceLanguage: text('source_language').notNull().default('ja'),
    coverFileId: uuid('cover_file_id'),
    /** active | archived（结项后归档，仍可查，但不再出现在默认视图） */
    status: text('status').notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_team_serial_uq').on(t.teamId, t.serial),
    index('projects_team_idx').on(t.teamId),
    index('projects_set_idx').on(t.setId),
    index('projects_status_idx').on(t.teamId, t.status),
  ],
);

/**
 * 作品内的角色。建作品时从团队的项目角色模板**复制**一份，
 * 之后每个作品可以独立调整 —— 与 moeflow 的 `project_role` 集合一一对应。
 * 复制而不是引用模板，是为了「某个作品临时加一个岗位」不必污染全团队。
 */
export const projectRoles = pgTable(
  'project_roles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** 反范式：权限查询要按团队取，少一次 join */
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    level: integer('level').notNull(),
    intro: text('intro').notNull().default(''),
    isSystem: boolean('is_system').notNull().default(false),
    systemCode: text('system_code'),
    /** 来源模板，仅作追溯；模板改了不会回灌到已有作品 */
    sourceTemplateId: uuid('source_template_id'),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_roles_project_name_uq').on(t.projectId, t.name),
    index('project_roles_project_idx').on(t.projectId),
  ],
);

export const projectRolePermissions = pgTable(
  'project_role_permissions',
  {
    projectRoleId: uuid('project_role_id')
      .notNull()
      .references(() => projectRoles.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.projectRoleId, t.permissionCode] })],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectRoleId: uuid('project_role_id')
      .notNull()
      .references(() => projectRoles.id, { onDelete: 'restrict' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId] }),
    index('project_members_user_idx').on(t.userId),
  ],
);

/** 作品的目标语言。承接 moeflow 的 `Target`：只登记「这个作品要出哪些语言」。 */
export const targets = pgTable(
  'targets',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** 语言码，如 zh-CN */
    language: text('language').notNull(),
    /** 展示名，如「简体中文」 */
    label: text('label').notNull(),
    orderIndex: integer('order_index').notNull().default(0),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('targets_project_language_uq').on(t.projectId, t.language),
    index('targets_project_idx').on(t.projectId),
  ],
);

// ── 文件（图片）──────────────────────────────────────────────

/**
 * 一张图一行。要点：
 *  - `team_id` 是**反范式**的冗余列：MD5 去重的作用域是整个团队（跨其全部作品），
 *    冗余一份 team_id 才能让去重查询走单表单索引。
 *  - 缩略图与预览图**不落列**，由 `storage_key` 按固定规则派生（见 storage/keys.ts）。
 *    这样少两列冗余，也少两处「派生键与实际文件对不上」的可能。
 *    迁移（M7）是**按字节搬到新键**，不要求与旧站的派生规则一致，所以这里可以自由约定。
 *  - 修订链：`parent_id` 是链根（同一逻辑页面），`old_revision_id` 是直接上一版。
 *    界面上只展示 `activated=true` 的那一版，但历史版本全留。
 *
 * ⚠️ MD5 **只建普通索引，不建唯一约束**（实施方案里曾写「部分唯一索引仅约束新数据」，
 * 这里刻意不做）：同一份字节在修订链里被重新上传是正常操作，
 * 加硬约束会把「合法操作」变成 500；去重改在应用层判定，可以给出带上下文的友好错误，
 * 也能区分「同一作品内重复」与「同团队跨作品重复」两种情形。
 */
export const files = pgTable(
  'files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** 原始文件名（含扩展名），界面上显示的就是它 */
    name: text('name').notNull(),
    /** 自然排序键：`p2.jpg` 要排在 `p10.jpg` 前面 */
    sortName: text('sort_name').notNull(),
    /** 存储键（原图）。缩略图/预览图由它派生。 */
    storageKey: text('storage_key').notNull(),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    width: integer('width').notNull().default(0),
    height: integer('height').notNull().default(0),
    md5: text('md5').notNull().default(''),
    sha256: text('sha256').notNull().default(''),
    /** 工作流状态，取值见 domain/workflow.ts 的 FILE_STATES */
    state: text('state').notNull().default('sourced'),
    /** 第几版，从 1 开始 */
    revision: integer('revision').notNull().default(1),
    /** 修订链根（同一逻辑页面的第一版）；首版时等于自身 id */
    parentId: uuid('parent_id'),
    /** 直接上一版 */
    oldRevisionId: uuid('old_revision_id'),
    /** 是否是当前生效版本 */
    activated: boolean('activated').notNull().default(true),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** 软删除：留行是为了让「标号/翻译曾经存在过」有据可查 */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('files_team_md5_idx').on(t.teamId, t.md5),
    index('files_project_sort_idx').on(t.projectId, t.sortName),
    index('files_project_state_idx').on(t.projectId, t.state),
    index('files_parent_idx').on(t.parentId),
    index('files_legacy_id_idx').on(t.legacyId),
  ],
);

/**
 * 状态变更流水。**每次进入某阶段都记一行** —— 这就是需求里
 * 「工作人员确认后维护图组状态」的落点，也是统计与通知的依据。
 * 与 `files.state` 的关系：那是当前态（供筛选与聚合，快），这是历史（供追溯，全）。
 */
export const fileStates = pgTable(
  'file_states',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** 首条记录没有前态 */
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('file_states_file_idx').on(t.fileId, t.createdAt),
    index('file_states_created_idx').on(t.createdAt),
  ],
);

// ── 标号 / 译文 / 署名 / 通知（M3 翻校）──────────────────────

/**
 * 标号（标注）。对应 moeflow 的 `Source` 实体 —— 它是**引用文件的独立集合**，
 * 不是「文件上的一个字符串字段」，因为一个标号要挂多份译文（每种目标语言一份）、
 * 要能被单独选中与拖动、还要参与署名统计。
 *
 * 坐标**一律归一化到 0–1**（相对图片宽高）。这样同一份标号在 520px 缩略图、
 * 2000px 预览图与原始大图上都落在同一位置，换分辨率不会错位。
 *
 * `kind` 把「拖框」与「打点」收敛到同一组字段：pin 的 w/h 为 0、x/y 即中心点。
 * 分成两张表或两套字段，会让后面每一处渲染与命中判定都写两遍分支。
 *
 * `vertices` 保留 moeflow 的多边形数据（迁移时是唯一的部分有损点：
 * 它只有 x/y + vertices，没有 w/h，迁移工具要从 vertices 推 bbox 合成 w/h）。
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /**
     * 框内 | 框外。
     *
     * 注意它**不是几何判定**，而是创建时由鼠标键位决定的分类：
     * 左键点画面 = 框内、右键点 = 框外。分类的用途在嵌字环节
     * （框内的字压在画面上、框外的字贴在画面外），而嵌字是离线在 PS 里做的，
     * 那边只能读到这份数据，所以必须落库、不能渲染时再猜。
     */
    positionType: text('position_type').notNull().default('in'),
    // 用 doublePrecision 而不是 real：归一化坐标在 float4 上往返一次会掉精度，
    // 表现为「标号存了又读之后位置微微变了」，在反复微调的场景里很烦人。
    /** 归一化 x。标号坐标 = 箭尖指向的那一点 */
    x: doublePrecision('x').notNull().default(0),
    y: doublePrecision('y').notNull().default(0),
    /**
     * 归一化宽高。**当前一律为 0** —— 标号是点，画面上不再有矩形。
     * 留着只为迁移期如实存下旧站的矩形/多边形标注，以及 M5 导出按框排版。
     */
    w: doublePrecision('w').notNull().default(0),
    h: doublePrecision('h').notNull().default(0),
    /** 多边形顶点 `[[x,y],…]`（归一化）；null 表示用上面的矩形 */
    vertices: jsonb('vertices'),
    /** 同一段话被拆到多个框时归组，便于整组移动 */
    groupId: uuid('group_id'),
    orderIndex: integer('order_index').notNull().default(0),
    /** 原文 */
    content: text('content').notNull().default(''),
    /** 给译者的备注（如「这句是双关」） */
    note: text('note').notNull().default(''),
    /** 排版样式（字号比例/对齐/竖排/颜色/描边）。见 shared 的 TextStyle。 */
    style: jsonb('style').notNull().default({}),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sources_file_order_idx').on(t.fileId, t.orderIndex),
    index('sources_group_idx').on(t.groupId),
    index('sources_legacy_id_idx').on(t.legacyId),
  ],
);

/**
 * 译文。**一个标号会有多份候选**（每人一份）+ 一个选中态 + 校对态 ——
 * 这是 moeflow 的原始语义，必须保留：
 * 同一句话经常有人给出不同译法，压平成「一标号一行」会直接丢数据。
 * 界面上 v1 可以只展示选中的那份，但表结构不能压平。
 *
 * `is_selected` 用**部分唯一索引**约束「每个 (标号, 语言) 至多一份被选中」。
 * 这里用部分唯一索引是合适的（不像 files.md5 那个场景）：这是真正的不变量，
 * 且索引的 WHERE 列没有 NULL 语义问题。
 */
export const translations = pgTable(
  'translations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** 译者。用户注销时置 null，但**译文内容不跟着人走** —— 那是作品的内容。 */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    content: text('content').notNull().default(''),
    /** 校对后的文本；空串表示尚未校对 */
    proofreadContent: text('proofread_content').notNull().default(''),
    proofreaderId: uuid('proofreader_id').references(() => users.id, { onDelete: 'set null' }),
    proofreadAt: timestamp('proofread_at', { withTimezone: true }),
    /** 多候选中「最终采用」的那一份 */
    isSelected: boolean('is_selected').notNull().default(false),
    machineTranslated: boolean('machine_translated').notNull().default(false),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('translations_source_target_user_uq').on(t.sourceId, t.targetId, t.userId),
    uniqueIndex('translations_one_selected_uq')
      .on(t.sourceId, t.targetId)
      .where(sql`${t.isSelected}`),
    index('translations_target_idx').on(t.targetId),
    index('translations_user_idx').on(t.userId),
  ],
);

/**
 * 成品（嵌字完成的图）。
 *
 * 离线嵌字流程的闭环落点：系统导出「原图 + 标号 + 译文」，嵌字的人在 PS 里做完
 * 把成品传回来，记在这里。**状态机进 `typeset` 的前置条件就是这张表里有行**
 * （见 workflow.ts 的 `outputCount`）—— 没有成品却说「已嵌字」是自欺。
 *
 * 几处刻意的取舍：
 *
 * 1. **语言存语言码文本，不存 `targets.id` 外键。** 成品是「某语言的成品图」
 *    这个**既成事实**，不是对一行配置的引用：项目里把某个目标语言删掉，
 *    已经嵌好的图不会因此变得不是那个语言了，不该跟着置空。
 *    顺带避开「唯一键里带可空列」——那个坑在角色表上已经踩过一次。
 * 2. **没有 `is_current` 列，最新版本即当前版本。** 多一列就要多维护一条
 *    「每个文件恰有一行为真」的不变量，而嵌字返工只要重新传一次就自然成为最新，
 *    不值得为它引入一份需要修复的状态。
 * 3. **版本号按 (文件, 语言) 各自从 1 递增**，不是全局递增 —— 一部作品同时做
 *    简繁两版时，「简体 v2」和「繁体 v2」是两件平行的事，混编会很乱。
 */
export const outputs = pgTable(
  'outputs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** 语言码，如 zh-CN。空串表示「项目只有一个目标语言，没特意指定」 */
    language: text('language').notNull().default(''),
    /** 该文件在该语言下的第几版，从 1 起 */
    version: integer('version').notNull().default(1),
    storageKey: text('storage_key').notNull(),
    /** 回传时的原始文件名。嵌字的人自己起的名字，保留下来便于对账 */
    name: text('name').notNull().default(''),
    size: bigint('size', { mode: 'number' }).notNull().default(0),
    width: integer('width').notNull().default(0),
    height: integer('height').notNull().default(0),
    note: text('note').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // (文件, 语言, 版本) 唯一：让「并发回传拿到同一个版本号」直接失败而不是
    // 悄悄产生两行 v2。插入前会先锁住文件行，所以正常情况下不会撞上。
    uniqueIndex('outputs_file_language_version_uq').on(t.fileId, t.language, t.version),
    index('outputs_file_idx').on(t.fileId, t.createdAt),
  ],
);

/**
 * 署名台账。
 *
 * moeflow 把「谁翻译了这张图」存成文件上的**自由文本串**（多人用 `、` 连接），
 * 后果是：没有历史、覆盖即抹除、改名要全库改、统计要靠解析字符串。
 * 这里改成一张台账表，显示串从台账派生 —— 顺序即 `created_at` 顺序，
 * 所以迁移时必须**按原 token 顺序插入**，否则署名会静默变序。
 *
 * 唯一键 `(file_id, role, user_id)` 让自动记账天然幂等（`ON CONFLICT DO NOTHING`），
 * 同时保证同一个人在同一个角色上只出现一次 —— 这正是署名该有的样子。
 */
export const fileCredits = pgTable(
  'file_credits',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /**
     * 插入顺序。**必须单独有这一列**，不能靠 `created_at` 排 ——
     * PostgreSQL 的 `now()` 返回的是**事务开始时间**，同一个事务里插入的多行
     * 拿到的是完全相同的时间戳，于是「署名顺序 = 录入顺序」这条保证会失效，
     * 顺序退化成按随机 uuid 排。这个坑是 m3-verify 的断言抓出来的。
     * bigserial 由序列分配，严格递增，事务内外都准。
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** 冗余团队列：署名要按团队统计，避免每次 join 到 files */
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** translator | proofreader | typesetter | supervisor | other */
    role: text('role').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 手工录入时保留外部署名（迁移自 moeflow 的自由文本，可能不是站内用户） */
    displayName: text('display_name').notNull().default(''),
    /** auto | manual */
    source: text('source').notNull().default('auto'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('file_credits_file_role_user_uq').on(t.fileId, t.role, t.userId),
    index('file_credits_file_idx').on(t.fileId, t.seq),
    index('file_credits_team_idx').on(t.teamId),
  ],
);

/**
 * 个人通知 —— 工作流推进时点名给「下一环节的人」。
 *
 * 与 `notices`（站点公告，所有人可见）是两回事：那是广播，这是投递。
 * 之所以不复用同一张表：公告的「已读」是每人一行、且对所有人都有意义；
 * 通知是给具体某个人的，混在一起会让「未读数」变成两种口径的叠加。
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 形如 `stage.entered_proofreading`，前端据此选图标；后端不定文案 */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** 点通知跳到哪儿 */
    teamId: uuid('team_id'),
    projectId: uuid('project_id'),
    fileId: uuid('file_id'),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_user_unread_idx').on(t.userId, t.readAt),
  ],
);

// ── 邀请码 ──────────────────────────────────────────────────

export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    code: text('code').notNull().unique(),
    /** 一码绑一团队：注册时自动入团 */
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    /** 入团时授予的角色 */
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    /** NULL = 不限次数 */
    maxUses: integer('max_uses'),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    note: text('note').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    legacyId: text('legacy_id'),
  },
  (t) => [index('invite_codes_team_idx').on(t.teamId)],
);

// ── 限流 ────────────────────────────────────────────────────

/**
 * 定长窗口限流。放数据库而不是内存，是为了**重启不清零**、多实例共享 ——
 * 对标图译空间的同名表。
 */
export const rateLimits = pgTable('rate_limits', {
  bucket: text('bucket').primaryKey(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── 站点设置与通知 ──────────────────────────────────────────

export const siteSettings = pgTable('site_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const notices = pgTable(
  'notices',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    title: text('title').notNull().default(''),
    content: text('content').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notices_created_idx').on(t.createdAt)],
);

/**
 * 已读记录用**关联表**，而不是 moeflow 的「每用户一条记录塞一个 notice id 列表」：
 * 标记已读是一行写入而非重写整个数组，按公告统计已读也可索引。
 */
export const noticeReads = pgTable(
  'notice_reads',
  {
    noticeId: uuid('notice_id')
      .notNull()
      .references(() => notices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.noticeId, t.userId] })],
);

// ── 操作日志 ────────────────────────────────────────────────

export const opLogs = pgTable(
  'op_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    teamId: uuid('team_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull().default(''),
    targetId: text('target_id').notNull().default(''),
    targetName: text('target_name').notNull().default(''),
    detail: jsonb('detail'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('op_logs_created_idx').on(t.createdAt),
    index('op_logs_actor_idx').on(t.actorId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Team = typeof teams.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type TeamMember = typeof teamMembers.$inferSelect;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type Notice = typeof notices.$inferSelect;
export type ProjectSet = typeof projectSets.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type ProjectRole = typeof projectRoles.$inferSelect;
export type ProjectMember = typeof projectMembers.$inferSelect;
export type Target = typeof targets.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type FileStateRow = typeof fileStates.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Translation = typeof translations.$inferSelect;
export type FileCredit = typeof fileCredits.$inferSelect;
export type Notification = typeof notifications.$inferSelect;

// ── 图源采集（M4）───────────────────────────────────────────

/**
 * 图源账号：一组**具名**的凭据 + 出口。
 *
 * 不做成「全站单例」（moeflow 就是单例，一处改动影响所有人），也一上来就
 * 不做成「每团队必须自带」—— 折中是 `team_id` 可空：
 *   - `team_id = null` → 全站共享，站点管理员维护；
 *   - `team_id = 某团队` → 该团队专属，读的时候**优先命中**。
 *
 * v1 只有站点管理员能写（与「凭据仅管理员可读写」一致），团队自维护留给后面。
 */
export const sourcingAccounts = pgTable(
  'sourcing_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
    /** 图源 id，见 @405nm/shared 的 SOURCE_IDS —— 一个账号只服务一类图源 */
    source: text('source').notNull(),
    label: text('label').notNull(),
    /**
     * 加密后的凭据 JSON（AES-256-GCM，见 lib/credentials.ts）。
     * **明文绝不落这一列**，也不回传前端 —— API 只给掩码视图。
     */
    credentials: text('credentials').notNull().default(''),
    /** 该账号自己的出口代理。留空则用 SOURCING_PROXY。 */
    proxyUrl: text('proxy_url').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    /** 最近一次可用性结论（人工「测试」或抓取失败时写入），供后台界面显示 */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    lastStatus: text('last_status').notNull().default(''),
    lastMessage: text('last_message').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sourcing_accounts_source_idx').on(t.source, t.enabled),
    index('sourcing_accounts_team_idx').on(t.teamId),
  ],
);

/**
 * 导入任务：**一个任务对应一条粘贴进来的链接**。
 *
 * 一次粘三条链接就是三个任务 —— 而不是一个大任务里塞三种图源。
 * 这样「哪条链接失败了」「重试哪一条」都能落到具体的行上，
 * 而一条失败的链接不会拖累另外两条。
 *
 * 进度字段（total/done/imported/duplicated/failed）是**冗余的计数器**，
 * 真相在 import_task_items 里。这样做是为了让前端 1.5s 一次的轮询
 * 只需要读一行，而不是每次去 count 一遍明细表。
 */
export const importTasks = pgTable(
  'import_tasks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** 反范式：按团队列历史、以及去重都要用，省一次 join */
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** 用户粘进来的原始链接 */
    inputUrl: text('input_url').notNull(),
    /** 识别出的图源；认不出来时为空 */
    source: text('source').notNull().default(''),
    accountId: uuid('account_id').references(() => sourcingAccounts.id, { onDelete: 'set null' }),

    /** pending | running | done | failed */
    status: text('status').notNull().default('pending'),
    total: integer('total').notNull().default(0),
    done: integer('done').notNull().default(0),
    imported: integer('imported').notNull().default(0),
    duplicated: integer('duplicated').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    /** 整条链接级别的失败码/文案（逐张的失败在 items 里） */
    errorCode: text('error_code').notNull().default(''),
    errorMessage: text('error_message').notNull().default(''),
    /** 解析阶段的提示，例如「只取了最早 50 个作品」——必须让用户看到 */
    notes: jsonb('notes').notNull().default([]),

    /**
     * 认领与租约。
     *
     * 与发布队列同一套：`FOR UPDATE SKIP LOCKED` 原子认领 + 租约超时回收。
     * 380nm 用的是进程内 `_busy` 标志位，多开一个 worker 就会重复导入 ——
     * 那是必须修掉的缺陷，不是可以照抄的实现。
     */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('import_tasks_project_idx').on(t.projectId, t.createdAt),
    index('import_tasks_claim_idx').on(t.status, t.createdAt),
  ],
);

/** 导入任务里的一张图。逐张落状态，重启后能接着跑。 */
export const importTaskItems = pgTable(
  'import_task_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskId: uuid('task_id')
      .notNull()
      .references(() => importTasks.id, { onDelete: 'cascade' }),
    /** 在这一次导入里的顺序，决定文件名与自然排序 */
    idx: integer('idx').notNull(),
    url: text('url').notNull(),
    /** 下载时必须带的 Referer（i.pximg.net 少了它就是 403） */
    referer: text('referer').notNull().default(''),
    /** pending | imported | duplicated | failed */
    status: text('status').notNull().default('pending'),
    fileId: uuid('file_id').references(() => files.id, { onDelete: 'set null' }),
    /** 失败码与给用户看的文案 */
    code: text('code').notNull().default(''),
    reason: text('reason').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('import_task_items_task_idx').on(t.taskId, t.idx),
    index('import_task_items_status_idx').on(t.taskId, t.status),
  ],
);

export type SourcingAccount = typeof sourcingAccounts.$inferSelect;
export type ImportTask = typeof importTasks.$inferSelect;
export type ImportTaskItem = typeof importTaskItems.$inferSelect;

// ── 发布 ────────────────────────────────────────────────────
//
// 五张表，对着「一键导出发布包 → 草稿 → 定时发布」这条链路的每一段：
// `publish_accounts`（发到哪）→ `publish_jobs`（发什么、什么时候）
// → `publish_attempts`（发到哪一步了）。`credit_directory` 与
// `publish_templates` 是署名与正文的来源。
//
// 与旧实现（380nm）的三处结构差异，每一处都是**为了修一个已经在生产上
// 造成过麻烦的缺陷**：
//
//  1. `publish_jobs` 有 **`idempotency_key` 唯一列** —— 旧实现没有，重复入队
//     就重复发。顺带用它派生出确定性的 `upload_id`，让图片上传这一步可安全重试
//     （旧实现每次 `crypto.randomBytes(16)`，重试等于换一张图重传）。
//  2. `claimed_at` / `lease_expires_at` —— 旧实现靠进程内的 `_busy` 标志位，
//     多实例部署直接重复发布。认领改成 `FOR UPDATE SKIP LOCKED` + 租约。
//  3. **`status` 里有 `needs_review`** —— B 站的发布接口**没有幂等参数**，
//     「HTTP 200 之后、写库之前崩掉」这个窗口消不掉。旧实现的 `recover()`
//     把卡在 `publishing` 的任务直接改回 `pending` 重发，那是**静默重发**。
//     这里改成：凡有 in-flight 的发布尝试，一律标 `needs_review` 交人工。

export const publishAccounts = pgTable(
  'publish_accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** **归团队**（不是全站单例）：一个团队可以持有一个或多个发布号 */
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().default('bilibili'),
    /** 给人看的名字，如「主号」「备用号」 */
    label: text('label').notNull(),
    /** 加密后的凭据 JSON（AES-256-GCM，见 lib/credentials.ts）。**绝不明文输出** */
    credentials: text('credentials').notNull().default(''),
    /** 校验通过后拿到的平台身份，展示用 */
    platformUid: text('platform_uid').notNull().default(''),
    platformName: text('platform_name').notNull().default(''),
    avatarUrl: text('avatar_url').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    /** ok | expired | unknown —— 由定时巡检或手动校验写入 */
    cookieStatus: text('cookie_status').notNull().default('unknown'),
    cookieCheckedAt: timestamp('cookie_checked_at', { withTimezone: true }),
    cookieMessage: text('cookie_message').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('publish_accounts_team_label_uq').on(t.teamId, t.label),
    index('publish_accounts_team_idx').on(t.teamId, t.enabled),
  ],
);

/**
 * 账号库 —— 署名用的成员目录。
 *
 * `platform_uid` 是这张表存在的关键：**@ 要可点击，就必须拿到对方的平台 uid**
 * （B 站的 type-2 节点靠 `biz_id` 定位用户）。只存一个 `@handle` 字符串的话，
 * 发出去的动态里那个 @ 是死的。
 */
export const creditDirectory = pgTable(
  'credit_directory',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** 显示名 */
    name: text('name').notNull(),
    /** @ 用的 handle，不含 `@` */
    handle: text('handle').notNull(),
    /** 平台 uid。空串表示「只当文字用，@ 不可点击」 */
    platformUid: text('platform_uid').notNull().default(''),
    /** active（在岗）| left（离岗）。离岗的仍保留，历史署名要能追溯 */
    status: text('status').notNull().default('active'),
    note: text('note').notNull().default(''),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    legacyId: text('legacy_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_directory_team_handle_uq').on(t.teamId, t.handle),
    index('credit_directory_team_idx').on(t.teamId, t.status),
  ],
);

export const publishTemplates = pgTable(
  'publish_templates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** 正文模板，`{{变量}}`（正则含中文，见 publish/render.ts） */
    content: text('content').notNull(),
    maxImages: integer('max_images').notNull().default(9),
    /** 变量声明的快照 `[{key,label,type,placeholder}]`，供界面渲染表单 */
    variables: jsonb('variables').notNull().default([]),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('publish_templates_team_name_uq').on(t.teamId, t.name)],
);

export const publishJobs = pgTable(
  'publish_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** 取的是哪个语言的成品。语言码文本，理由同 outputs */
    language: text('language').notNull().default(''),
    accountId: uuid('account_id').references(() => publishAccounts.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

    /**
     * 幂等键。唯一。作用是挡住「重复入队」，并派生确定性的 upload_id。
     * 它**挡不住**「HTTP 200 之后崩掉」那种重复 —— 那个窗口只能靠
     * `publish_attempts` 的两阶段标记 + `needs_review` 兜。
     */
    idempotencyKey: text('idempotency_key').notNull().unique(),

    /** 内容类型：翻嵌 | 翻译 | 转载 | 原创。决定署名槽位 */
    kind: text('kind').notNull().default('原创'),
    title: text('title').notNull().default(''),
    /** 正文（已渲染模板；署名片段与提及在**发布时**兜底追加） */
    text: text('text').notNull().default(''),
    /** 绑定的话题 `{id,name}` */
    topic: jsonb('topic'),
    /** @ 提及 `[{name,uid}]`。发布时还会再兜底补一次 */
    mentions: jsonb('mentions').notNull().default([]),
    /**
     * 署名槽位**快照** `{trans:{name,handle,uid}, typo:{…}, orig:{…}}`。
     * 存快照而不是每次去目录里查：目录改名、有人离岗，都不该改变
     * 一条**已经排好期**的动态的署名。
     */
    slots: jsonb('slots').notNull().default({}),
    /** 图片**快照** `[{key,name,width,height}]`，同上：成品换版本不该影响已排期的任务 */
    images: jsonb('images').notNull().default([]),

    /** draft | pending | publishing | published | failed | needs_review | canceled */
    status: text('status').notNull().default('draft'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error').notNull().default(''),

    // 原子认领 + 租约（取代旧实现的进程内标志位）
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    externalId: text('external_id').notNull().default(''),
    externalUrl: text('external_url').notNull().default(''),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 认领查询走这条：status + scheduled_at
    index('publish_jobs_claim_idx').on(t.status, t.scheduledAt),
    index('publish_jobs_team_idx').on(t.teamId, t.createdAt),
    index('publish_jobs_project_idx').on(t.projectId),
  ],
);

/**
 * 发布尝试 —— **两阶段标记**的落点。
 *
 * 调 `createDynamic` **之前**先插一条 `phase='publish', status='in_flight'`；
 * 拿到结果再改成 succeeded / failed。这样「发出去了但没来得及写库」的窗口
 * 在库里留下一条 in_flight 记录：worker 重启时看到它就是**不确定**，
 * 标 `needs_review` 交人工，**绝不自动重发**。
 *
 * 图片上传单独记一个 phase：它失败可以安全重试（最坏是平台上多几张没人引用的图），
 * 而 `createDynamic` 失败**不能** —— 网络超时是歧义的，请求可能已经到达并发布成功。
 */
export const publishAttempts = pgTable(
  'publish_attempts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    jobId: uuid('job_id')
      .notNull()
      .references(() => publishJobs.id, { onDelete: 'cascade' }),
    /** upload_images | publish */
    phase: text('phase').notNull(),
    /** in_flight | succeeded | failed */
    status: text('status').notNull(),
    /** 第几次尝试，与 publish_jobs.attempts 对齐，便于排查 */
    attempt: integer('attempt').notNull().default(0),
    detail: text('detail').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('publish_attempts_job_idx').on(t.jobId, t.createdAt),
    // 启动时扫「有没有悬空的发布尝试」走这条
    index('publish_attempts_inflight_idx').on(t.status, t.phase),
  ],
);

export type PublishAccount = typeof publishAccounts.$inferSelect;
export type CreditDirectoryEntry = typeof creditDirectory.$inferSelect;
export type PublishTemplate = typeof publishTemplates.$inferSelect;
export type PublishJob = typeof publishJobs.$inferSelect;
export type PublishAttempt = typeof publishAttempts.$inferSelect;
