/**
 * 迁移报告。三类内容，缺一不可：
 *  - checks：硬性对账（计数 / 指纹 / 图片 md5 / 凭据扫描），任何一项 fail → 退出码非零；
 *  - lossy：**有损点**，逐类计数 + 样例，`confirm` 的必须有人看过才能放行；
 *  - dispositions：旧库**每一个集合**的去向（迁 / 仅查表 / 不迁 + 理由）。认不出的集合直接判失败，
 *    不允许「新集合被悄悄漏掉」。
 */
export type CheckStatus = 'ok' | 'fail' | 'confirm';

export type Check = { name: string; status: CheckStatus; detail: string; data?: Record<string, unknown> };

export type LossyEntry = { kind: string; description: string; confirm: boolean; count: number; samples: string[] };

export type Disposition = { collection: string; action: 'migrate' | 'lookup' | 'skip'; count: number; reason: string };

const MAX_SAMPLES = 10;

export class Report {
  readonly startedAt = new Date().toISOString();
  finishedAt = '';
  readonly checks: Check[] = [];
  readonly lossy = new Map<string, LossyEntry>();
  readonly dispositions: Disposition[] = [];
  readonly counts: Record<string, { source: number; inserted: number; existing: number }> = {};
  readonly log: string[] = [];

  /**
   * `silent`：只收集、不打印。migrate 与 verify 在同一进程里各重算一遍计划时，
   * 第二遍的有损点用一份静默报告接住 —— 同一条有损点不会在正式报告里记两次。
   */
  constructor(readonly silent = false) {}

  note(message: string): void {
    this.log.push(message);
    if (!this.silent) console.log(`[migrate] ${message}`);
  }

  /** 记一个有损点。同类累加计数，样例最多留 10 条（样例是 id，不是内容 —— 报告可能被转发）。 */
  lose(kind: string, description: string, sample: string, confirm = true): void {
    const entry = this.lossy.get(kind) ?? { kind, description, confirm, count: 0, samples: [] };
    entry.count += 1;
    if (entry.samples.length < MAX_SAMPLES) entry.samples.push(sample);
    this.lossy.set(kind, entry);
  }

  check(name: string, status: CheckStatus, detail: string, data?: Record<string, unknown>): void {
    this.checks.push({ name, status, detail, ...(data ? { data } : {}) });
    if (this.silent) return;
    const mark = status === 'ok' ? '✓' : status === 'fail' ? '✗' : '?';
    console.log(`  ${mark} ${name}：${detail}`);
  }

  count(table: string, source: number, inserted: number, existing: number): void {
    this.counts[table] = { source, inserted, existing };
    this.note(`${table}：源 ${source}，本次写入 ${inserted}，已存在 ${existing}`);
  }

  get failed(): boolean {
    return this.checks.some((c) => c.status === 'fail');
  }

  get needsConfirmation(): Array<Check | LossyEntry> {
    return [...this.checks.filter((c) => c.status === 'confirm'), ...[...this.lossy.values()].filter((l) => l.confirm)];
  }

  toJSON() {
    return {
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      result: this.failed ? 'FAIL' : this.needsConfirmation.length ? 'PASS_WITH_CONFIRMATIONS' : 'PASS',
      checks: this.checks,
      lossy: [...this.lossy.values()],
      dispositions: this.dispositions,
      counts: this.counts,
      log: this.log,
    };
  }
}

/**
 * 旧库集合的去向。**白名单**：不在表里的集合一律判失败 —— 那说明旧站多了我们没见过的数据。
 * `confirmIfAny`：不迁，但有数据时要有人确认「丢掉是可以接受的」。
 */
export const DISPOSITIONS: Record<string, { action: Disposition['action']; reason: string; confirmIfAny?: boolean }> = {
  user: { action: 'migrate', reason: '→ users（用户名规整见有损点；密码哈希照搬，首次登录升级为本站格式）' },
  team: { action: 'migrate', reason: '→ teams' },
  team_role: { action: 'migrate', reason: '→ roles(scope=team) + role_permissions' },
  team_user_relation: { action: 'migrate', reason: '→ team_members' },
  project_set: { action: 'migrate', reason: '→ project_sets' },
  project: { action: 'migrate', reason: '→ projects（serial 按团队内创建顺序分配）' },
  project_role: { action: 'migrate', reason: '→ project_roles + project_role_permissions' },
  project_user_relation: { action: 'migrate', reason: '→ project_members' },
  target: { action: 'migrate', reason: '→ targets' },
  file: { action: 'migrate', reason: '→ files（图片按字节搬运并校验 md5）+ file_credits（三个署名串拆成台账）' },
  source: { action: 'migrate', reason: '→ sources' },
  translation: { action: 'migrate', reason: '→ translations' },
  notice: { action: 'migrate', reason: '→ notices' },
  user_notice_read: { action: 'migrate', reason: '→ notice_reads（每个已读 id 一行）' },
  invitation_code: { action: 'migrate', reason: '→ invite_codes（码转大写，新站按大写匹配）' },
  language: { action: 'lookup', reason: '只用于把作品/目标的语言引用解析成语言码；新站语言表在代码里' },
  file_target_cache: { action: 'skip', reason: '派生缓存（逐文件译校计数），新站按需聚合' },
  output: { action: 'skip', reason: '导出任务记录与打包文件，可随时重新导出' },
  celery_taskmeta: { action: 'skip', reason: '任务队列运行态' },
  v_code: { action: 'skip', reason: '一次性验证码' },
  action_log: { action: 'skip', reason: '操作日志：随导出快照归档，不进新库' },
  error_log: { action: 'skip', reason: '错误日志：随导出快照归档，不进新库' },
  media_import_task: { action: 'skip', reason: '旧站导入任务的运行记录' },
  tip: { action: 'skip', reason: '新站没有对应功能', confirmIfAny: true },
  term_bank: { action: 'skip', reason: '新站暂无术语库（ROADMAP 后续里程碑）', confirmIfAny: true },
  term_group: { action: 'skip', reason: '新站暂无术语库', confirmIfAny: true },
  term: { action: 'skip', reason: '新站暂无术语库', confirmIfAny: true },
  invitation: { action: 'skip', reason: '待处理的入组邀请：新站改用邀请码', confirmIfAny: true },
  application: { action: 'skip', reason: '待处理的入组申请：新站没有申请流程', confirmIfAny: true },
  message: { action: 'skip', reason: '站内信：新站没有收件箱', confirmIfAny: true },
  site_setting: {
    action: 'skip',
    reason: '含第三方凭据（Cookie / session / app password），按规定一律不迁；其余站点配置在新站后台重新设置',
    confirmIfAny: true,
  },
};
