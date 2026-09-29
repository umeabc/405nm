/** 计划：作品集 / 作品 / 作品角色 / 作品成员 / 目标语言。 */
import { isKnownLanguage, languageLabel, normalizeLanguage } from '../domain/languages.js';
import type { Plan } from './plan.js';
import { planMembers, planRoles, PROJECT_ROLE_SPEC } from './plan-roles.js';
import type { Report } from './report.js';
import { mapProjectStatus } from './rules.js';
import { ref, str, type MoeflowExport } from './source.js';

export async function planProjects(exp: MoeflowExport, plan: Plan, report: Report): Promise<void> {
  // ── 语言（只查表）──
  const languages = new Map<string, { code: string; name: string }>();
  for (const l of await exp.all('language')) {
    languages.set(l._id, { code: normalizeLanguage(str(l.co)), name: str(l.c).trim() || str(l.e).trim() });
  }
  const langOf = (value: unknown, sample: string): string => {
    const hit = languages.get(ref(value) ?? '');
    if (!hit || !hit.code) {
      report.lose('language-unresolved', '语言引用找不到：记为 und（未知语言）', sample);
      return 'und';
    }
    if (!isKnownLanguage(hit.code)) report.lose('language-unlisted', '本站语言目录里没有的语言：原样保留语言码', `${sample}:${hit.code}`, false);
    return hit.code;
  };

  // ── 作品集：同团队内按「默认集在前、再按创建顺序」排序；重名加序号 ──
  plan.projectSets = [];
  plan.projectSetIds = new Set();
  plan.projectSetName = new Map();
  plan.projectSetOrder = new Map();
  plan.projectSetTeam = new Map();
  const setsByTeam = new Map<string, typeof plan.projectSets>();
  for (const s of await exp.all('project_set')) {
    const team = ref(s.t);
    if (!team || !plan.teamIds.has(team)) {
      report.lose('orphan-project-set', '所属团队不迁移的作品集：不迁', s._id, false);
      continue;
    }
    const list = setsByTeam.get(team) ?? [];
    list.push(s);
    setsByTeam.set(team, list);
  }
  for (const [team, sets] of setsByTeam) {
    sets.sort((a, b) => Number(b.d === true) - Number(a.d === true) || (a._id < b._id ? -1 : 1));
    const taken = new Set<string>();
    sets.forEach((s, i) => {
      const base = str(s.n).trim() || (s.d === true ? '默认作品集' : `作品集_${s._id.slice(-6)}`);
      let name = base;
      for (let n = 2; taken.has(name); n += 1) name = `${base}（${n}）`;
      if (name !== base) report.lose('project-set-renamed', '同一团队里作品集重名：后一个加序号', s._id);
      taken.add(name);
      plan.projectSets.push(s);
      plan.projectSetIds.add(s._id);
      plan.projectSetName.set(s._id, name);
      plan.projectSetOrder.set(s._id, i);
      plan.projectSetTeam.set(s._id, team);
    });
  }
  plan.projectSets.sort((a, b) => (a._id < b._id ? -1 : 1));
  const setTeam = new Map(plan.projectSets.map((s) => [s._id, ref(s.t)]));

  // ── 作品 ──
  plan.projects = [];
  plan.projectIds = new Set();
  plan.projectTeam = new Map();
  plan.projectSet = new Map();
  plan.projectLanguage = new Map();
  for (const p of await exp.all('project')) {
    const team = ref(p.t);
    if (!team || !plan.teamIds.has(team)) {
      report.lose('orphan-project', '所属团队不迁移的作品：不迁（连同其图片、标号、译文）', p._id);
      continue;
    }
    plan.projects.push(p);
    plan.projectIds.add(p._id);
    plan.projectTeam.set(p._id, team);
    const set = ref(p.ps);
    const setOk = set !== null && setTeam.get(set) === team;
    plan.projectSet.set(p._id, setOk ? set : null);
    if (p.ps != null && !setOk) report.lose('project-set-unlinked', '作品集引用失效：作品改为「未归类」', p._id);
    plan.projectLanguage.set(p._id, langOf(p.ol, p._id));

    const st = Number(p.st ?? 0);
    if (st !== 0) {
      const what = { 1: '已完结', 2: '计划完结', 3: '计划删除', 4: '已删除' }[st] ?? `未知状态 ${st}`;
      report.lose(`project-status-${st}`, `旧站作品状态「${what}」→ 本站「${mapProjectStatus(st) === 'active' ? '进行中' : '已归档'}」`, p._id, st !== 1);
    }
    if (Array.isArray(p.ta) && p.ta.length) report.lose('project-tags', '作品标签：本站没有这个字段，不迁', p._id);
    if (str(p.sn).trim() || str(p.tn).trim()) report.lose('project-names-in-intro', '作品原名/译名：并进作品简介末尾（本站没有单独字段）', p._id, false);
    if (p.u != null && Number(p.u) < 100000) report.lose('project-max-user', '作品人数上限：本站作品没有人数上限，不迁', p._id, false);
    if (p.m_a != null && Number(p.m_a) !== 1) report.lose('project-open-apply', '「允许申请加入作品」：本站只能由管理员拉人入作品', p._id, false);
    if (Array.isArray(p.tb) && p.tb.length) report.lose('project-term-banks', '作品关联的术语库：术语库不迁', p._id);
  }

  plan.projectRoles = planRoles(PROJECT_ROLE_SPEC, await exp.all('project_role'), plan.projects, report);
  for (const p of plan.projects) {
    // 本站作品没有「默认角色」：拉人入作品时总要选角色，默认值固定是「翻译」
    if (plan.projectRoles.defaultRole.get(p._id) !== plan.projectRoles.byCode.get(`${p._id}:translator`)) {
      report.lose('project-default-role', '作品默认角色不是「翻译」：本站拉人时默认选「翻译」，不保留这项设置', p._id, false);
    }
  }
  plan.projectMembers = planMembers(await exp.all('project_user_relation'), plan.projectIds, plan.userIds, plan.projectRoles, report, 'project');
  const inTeam = new Set(plan.teamMembers.map((m) => `${m.group}:${m.user}`));
  for (const m of plan.projectMembers) {
    if (!inTeam.has(`${plan.projectTeam.get(m.group)}:${m.user}`)) {
      report.lose('project-member-not-in-team', '作品成员不在所属团队里：成员关系照迁，但本站作品权限建立在团队成员身份上，需管理员把此人拉进团队后才看得到该作品', m.doc._id);
    }
  }

  // 创建人 = 第一个持有本作品「创建人」角色的成员（找不到就空着）
  plan.projectCreator = new Map();
  for (const m of plan.projectMembers) {
    if (!plan.projectCreator.has(m.group) && m.roleId === plan.projectRoles.byCode.get(`${m.group}:creator`)) {
      plan.projectCreator.set(m.group, m.user);
    }
  }

  // ── 目标语言：同作品同语言的多个 target 合并成一个 ──
  plan.targets = [];
  plan.targetAlias = new Map();
  plan.targetProject = new Map();
  plan.targetLanguage = new Map();
  plan.targetLabel = new Map();
  plan.targetOrder = new Map();
  plan.projectTargets = new Map();
  const firstByLang = new Map<string, string>();
  const orderByProject = new Map<string, number>();
  for (const t of await exp.all('target')) {
    const project = ref(t.t);
    if (!project || !plan.projectIds.has(project)) {
      report.lose('orphan-target', '所属作品不迁移的目标语言：不迁（连同其译文）', t._id, false);
      continue;
    }
    const lang = langOf(t.l, t._id);
    const key = `${project}:${lang}`;
    const first = firstByLang.get(key);
    if (first) {
      plan.targetAlias.set(t._id, first);
      report.lose('target-merged', '同一作品有两个同语言的目标：合并到先建的那个（译文一并归入）', t._id);
      continue;
    }
    firstByLang.set(key, t._id);
    plan.targetAlias.set(t._id, t._id);
    plan.targets.push(t);
    plan.targetProject.set(t._id, project);
    plan.targetLanguage.set(t._id, lang);
    const legacyName = languages.get(ref(t.l) ?? '')?.name ?? '';
    plan.targetLabel.set(t._id, isKnownLanguage(lang) ? languageLabel(lang) : legacyName || lang);
    const order = orderByProject.get(project) ?? 0;
    plan.targetOrder.set(t._id, order);
    orderByProject.set(project, order + 1);
    plan.projectTargets.set(project, [...(plan.projectTargets.get(project) ?? []), t._id]);
    if (str(t.i).trim()) report.lose('target-intro', '目标语言的介绍：本站没有这个字段，不迁', t._id);
  }
}
