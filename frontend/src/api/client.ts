/**
 * 与后端通信的最小封装。
 *
 * baseURL 默认 `/api`：开发态由 Vite 代理、生产态由 nginx 反代，
 * 两种情形都是同源请求，因此会话 Cookie 不需要任何跨域配置。
 */

import type { PositionType } from '@405nm/shared';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;

  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      record.error ?? 'ERROR',
      record.message ?? `请求失败（HTTP ${response.status}）`,
    );
  }

  return payload as T;
}

/**
 * 带进度的上传。
 *
 * 用 XHR 而不是 fetch：`fetch` 拿不到**上传**进度（只能读到下载侧），
 * 而用户要看的是「这张图传了多少」的进度条。XHR 的 `upload.onprogress`
 * 是唯一现成的办法，所以这里单独开一个函数，不污染 `apiRequest`。
 */
export function uploadWithProgress<T>(
  path: string,
  file: File,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`, true);
    xhr.withCredentials = true;
    // 不设 Content-Type：让浏览器自己带 multipart 的 boundary，
    // 手写会漏掉 boundary 导致后端解析失败。

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };

    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = { message: xhr.responseText };
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as T);
      } else {
        const record = (payload ?? {}) as { error?: string; message?: string };
        reject(new ApiError(xhr.status, record.error ?? 'ERROR', record.message ?? `上传失败（HTTP ${xhr.status}）`));
      }
    };

    xhr.onerror = () => reject(new ApiError(0, 'NETWORK_ERROR', '网络错误，上传失败'));
    xhr.ontimeout = () => reject(new ApiError(0, 'TIMEOUT', '上传超时'));
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', '上传已取消'));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(form);
  });
}

// ── 类型 ────────────────────────────────────────────────────

export type PublicUser = {
  id: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  isSiteAdmin: boolean;
  status?: string;
  createdAt?: string;
};

export type MyRole = {
  id: string;
  name: string;
  level: number;
  systemCode: string | null;
};

export type TeamSummary = {
  id: string;
  name: string;
  intro: string;
  avatarKey: string | null;
  memberCount: number;
  myRole: MyRole;
  /** 我在此团队的有效权限码。界面据此收起来点不了的入口。 */
  myPermissions: string[];
};

export type TeamDetail = {
  team: {
    id: string;
    name: string;
    intro: string;
    avatarKey: string | null;
    status: string;
    createdAt: string;
  };
  my: {
    isSiteAdmin: boolean;
    role: MyRole | null;
    permissions: string[];
  };
  roles: RoleInfo[];
};

export type RoleInfo = {
  id: string;
  name: string;
  level: number;
  intro: string;
  isSystem: boolean;
  systemCode: string | null;
  autoProjectAdmin: boolean;
  permissions: string[];
};

export type PermissionInfo = {
  code: string;
  scope: 'team' | 'project';
  label: string;
  intro: string;
};

export type TeamMemberRow = {
  userId: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  status: string;
  joinedAt: string;
  roleId: string;
  roleName: string;
  roleLevel: number;
  roleSystemCode: string | null;
};

export type InviteRow = {
  id: string;
  code: string;
  roleId: string | null;
  roleName: string | null;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  enabled: boolean;
  note: string;
  createdAt: string;
  createdBy: string | null;
};

export type NoticeRow = {
  id: string;
  title: string;
  content: string;
  enabled?: boolean;
  createdAt: string;
  read?: boolean;
  createdBy?: string | null;
  readCount?: number;
};

// ── 接口 ────────────────────────────────────────────────────

// ── 作品与文件 ──────────────────────────────────────────────

export type StageKey = 'translating' | 'proofreading' | 'typesetting' | 'publishable' | 'published';

export type ProjectProgress = {
  fileCount: number;
  translatedCount: number;
  proofreadCount: number;
  typesetCount: number;
  publishedCount: number;
};

export type ProjectMemberChip = {
  userId: string;
  displayName: string;
  avatarKey: string | null;
  roleName: string;
  roleLevel: number;
};

export type ProjectCard = {
  id: string;
  teamId: string;
  teamName: string;
  setId: string | null;
  setName: string | null;
  serial: number;
  name: string;
  intro: string;
  author: string;
  sourceLanguage: string;
  status: string;
  coverFileId: string | null;
  stage: StageKey;
  progress: ProjectProgress;
  members: ProjectMemberChip[];
  myRole: { id: string; name: string; level: number; systemCode: string | null } | null;
  /** 第一张图的 id —— 主操作据此直达翻校页 */
  firstFileId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectTarget = { id: string; language: string; label: string; orderIndex: number };

export type ProjectRoleRow = {
  id: string;
  name: string;
  level: number;
  intro: string;
  isSystem: boolean;
  systemCode: string | null;
  permissions: string[];
};

export type ProjectDetail = {
  project: ProjectCard;
  my: {
    permissions: string[];
    role: { id: string; name: string; level: number; systemCode: string | null } | null;
    viaTeamRole: boolean;
    isSiteAdmin: boolean;
  };
  roles: ProjectRoleRow[];
  targets: ProjectTarget[];
};

export type ProjectMemberRow = {
  userId: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
  status: string;
  joinedAt: string;
  roleId: string;
  roleName: string;
  roleLevel: number;
  roleSystemCode: string | null;
};

export type ProjectFileRow = {
  id: string;
  name: string;
  size: number;
  width: number;
  height: number;
  md5: string;
  state: string;
  revision: number;
  activated: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UploadResult = {
  uploaded: Array<{ id: string; name: string; width: number; height: number; size: number }>;
  duplicates: Array<{ name: string; existingId: string; existingName: string }>;
  failures: Array<{ name: string; reason: string; code: string }>;
};

export type ActivityItem = {
  id: number;
  action: string;
  kind: 'create' | 'upload' | 'update' | 'delete' | 'member' | 'publish' | 'other';
  text: string;
  targetType: string;
  targetId: string;
  teamId: string | null;
  teamName: string | null;
  actor: { id: string | null; displayName: string } | null;
  createdAt: string;
};

export type ProjectSetRow = { id: string; name: string; intro: string; orderIndex: number; projectCount: number };

export type LanguageOption = { code: string; label: string; nativeLabel: string };

export const projectApi = {
  languages: () => apiRequest<{ languages: LanguageOption[] }>('/languages'),

  workbench: (params: { teamId?: string; stage?: StageKey; mine?: boolean; keyword?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.teamId) search.set('teamId', params.teamId);
    if (params.stage) search.set('stage', params.stage);
    if (params.mine) search.set('mine', '1');
    if (params.keyword) search.set('keyword', params.keyword);
    const qs = search.toString();
    return apiRequest<{
      projects: ProjectCard[];
      teams: Array<{ id: string; name: string }>;
      counts: Record<string, number>;
      stages: Array<{ key: StageKey; label: string }>;
    }>(`/workbench${qs ? `?${qs}` : ''}`);
  },

  activity: (teamId?: string) =>
    apiRequest<{ activity: ActivityItem[] }>(`/activity${teamId ? `?teamId=${teamId}` : ''}`),

  sets: (teamId: string) => apiRequest<{ sets: ProjectSetRow[] }>(`/teams/${teamId}/project-sets`),

  createSet: (teamId: string, payload: { name: string; intro?: string }) =>
    apiRequest<{ set: { id: string; name: string } }>(`/teams/${teamId}/project-sets`, {
      method: 'POST',
      body: payload,
    }),

  updateSet: (teamId: string, setId: string, patch: { name?: string; intro?: string; orderIndex?: number }) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/project-sets/${setId}`, { method: 'PATCH', body: patch }),

  removeSet: (teamId: string, setId: string) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/project-sets/${setId}`, { method: 'DELETE' }),

  list: (teamId: string, params: { setId?: string; ungrouped?: boolean; keyword?: string; status?: string } = {}) => {
    const search = new URLSearchParams();
    if (params.setId) search.set('setId', params.setId);
    if (params.ungrouped) search.set('ungrouped', '1');
    if (params.keyword) search.set('keyword', params.keyword);
    if (params.status) search.set('status', params.status);
    const qs = search.toString();
    return apiRequest<{ projects: ProjectCard[] }>(`/teams/${teamId}/projects${qs ? `?${qs}` : ''}`);
  },

  create: (
    teamId: string,
    payload: {
      name: string;
      intro?: string;
      author?: string;
      sourceLanguage?: string;
      setId?: string | null;
      targetLanguages?: string[];
    },
  ) =>
    apiRequest<{ project: { id: string; serial: number; name: string } }>(`/teams/${teamId}/projects`, {
      method: 'POST',
      body: payload,
    }),

  detail: (projectId: string) => apiRequest<ProjectDetail>(`/projects/${projectId}`),

  update: (
    projectId: string,
    patch: {
      name?: string;
      intro?: string;
      author?: string;
      sourceLanguage?: string;
      setId?: string | null;
      coverFileId?: string | null;
    },
  ) => apiRequest<{ ok: true }>(`/projects/${projectId}`, { method: 'PATCH', body: patch }),

  archive: (projectId: string) => apiRequest<{ ok: true }>(`/projects/${projectId}/archive`, { method: 'POST' }),
  unarchive: (projectId: string) => apiRequest<{ ok: true }>(`/projects/${projectId}/unarchive`, { method: 'POST' }),
  remove: (projectId: string) => apiRequest<{ ok: true }>(`/projects/${projectId}`, { method: 'DELETE' }),

  members: (projectId: string) => apiRequest<{ members: ProjectMemberRow[] }>(`/projects/${projectId}/members`),

  memberCandidates: (projectId: string) =>
    apiRequest<{
      candidates: Array<{
        userId: string;
        username: string;
        displayName: string;
        avatarKey: string | null;
        teamRoleName: string;
        teamRoleLevel: number;
      }>;
    }>(`/projects/${projectId}/member-candidates`),

  addMember: (projectId: string, userId: string, projectRoleId: string) =>
    apiRequest<{ ok: true }>(`/projects/${projectId}/members`, { method: 'POST', body: { userId, projectRoleId } }),

  changeMemberRole: (projectId: string, userId: string, projectRoleId: string) =>
    apiRequest<{ ok: true }>(`/projects/${projectId}/members/${userId}`, {
      method: 'PATCH',
      body: { projectRoleId },
    }),

  removeMember: (projectId: string, userId: string) =>
    apiRequest<{ ok: true }>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

  createRole: (
    projectId: string,
    payload: { name: string; level: number; intro?: string; permissions: string[] },
  ) => apiRequest<{ roleId: string }>(`/projects/${projectId}/roles`, { method: 'POST', body: payload }),

  updateRole: (
    projectId: string,
    roleId: string,
    patch: { name?: string; level?: number; intro?: string; permissions?: string[] },
  ) => apiRequest<{ ok: true }>(`/projects/${projectId}/roles/${roleId}`, { method: 'PATCH', body: patch }),

  /** 把代码里的默认权限补给本作品的系统角色（只加不减）。 */
  syncRoles: (projectId: string) =>
    apiRequest<{ ok: true; report: Array<{ role: string; added: string[] }> }>(
      `/projects/${projectId}/roles/sync`,
      { method: 'POST' },
    ),

  removeRole: (projectId: string, roleId: string) =>
    apiRequest<{ ok: true }>(`/projects/${projectId}/roles/${roleId}`, { method: 'DELETE' }),

  addTarget: (projectId: string, language: string, label?: string) =>
    apiRequest<{ target: ProjectTarget }>(`/projects/${projectId}/targets`, {
      method: 'POST',
      body: { language, label },
    }),

  updateTarget: (projectId: string, targetId: string, patch: { label?: string; orderIndex?: number }) =>
    apiRequest<{ ok: true }>(`/projects/${projectId}/targets/${targetId}`, { method: 'PATCH', body: patch }),

  removeTarget: (projectId: string, targetId: string) =>
    apiRequest<{ ok: true }>(`/projects/${projectId}/targets/${targetId}`, { method: 'DELETE' }),

  storage: (teamId: string) =>
    apiRequest<{
      team: { fileCount: number; usedBytes: number };
      disk: { usedBytes: number; totalBytes: number | null; availableBytes: number | null; objectCount: number; elapsedMs: number };
      driver: string;
    }>(`/teams/${teamId}/storage`),
};

export const fileApi = {
  list: (projectId: string, params: { state?: string; keyword?: string; includeDeleted?: boolean } = {}) => {
    const search = new URLSearchParams();
    if (params.state) search.set('state', params.state);
    if (params.keyword) search.set('keyword', params.keyword);
    if (params.includeDeleted) search.set('includeDeleted', '1');
    const qs = search.toString();
    return apiRequest<{ files: ProjectFileRow[]; total: number; bytes: number; truncated: boolean }>(
      `/projects/${projectId}/files${qs ? `?${qs}` : ''}`,
    );
  },

  upload: (projectId: string, file: File, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal) =>
    uploadWithProgress<UploadResult>(`/projects/${projectId}/files`, file, onProgress, signal),

  detail: (fileId: string) =>
    apiRequest<{
      file: ProjectFileRow & { projectId: string; teamId: string; sha256: string };
      history: Array<{ from: string | null; to: string; note: string; at: string }>;
    }>(`/files/${fileId}`),

  rename: (fileId: string, name: string) =>
    apiRequest<{ ok: true }>(`/files/${fileId}`, { method: 'PATCH', body: { name } }),

  remove: (fileId: string) => apiRequest<{ ok: true }>(`/files/${fileId}`, { method: 'DELETE' }),

  batchRemove: (projectId: string, fileIds: string[]) =>
    apiRequest<{ ok: true; deleted: number }>(`/projects/${projectId}/files/batch-delete`, {
      method: 'POST',
      body: { fileIds },
    }),

  /**
   * 图片 URL 由 id 拼出来，**不从后端取完整 URL**。
   * 这样 URL 里永远只有 id，后端每次请求都能重新鉴权；
   * 若后端下发带签名的直链，权限一旦收回，旧链接还会继续有效一段时间。
   */
  mediaUrl: (fileId: string, variant: 'raw' | 'thumb' | 'preview' = 'thumb') =>
    `${BASE}/files/${fileId}/media/${variant}`,
};

// ── 标号 / 译文 / 状态 / 署名 / 通知（M3 翻校）──────────────

export type FileState =
  | 'sourced'
  | 'translating'
  | 'translated'
  | 'proofreading'
  | 'proofread'
  | 'typesetting'
  | 'typeset'
  | 'publishable'
  | 'published';

export type TextStyle = {
  fontSizeRatio: number;
  lineHeight: number;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  vertical: boolean;
  bold: boolean;
  italic: boolean;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  background: string;
};

export type SourceRow = {
  id: string;
  /** 框内 / 框外。由创建时的鼠标键位决定：左键 = 框内、右键 = 框外。 */
  positionType: PositionType;
  /** 归一化坐标 —— 标号是点，这里就是标记箭尖所指的那一点。 */
  x: number;
  y: number;
  /** 只读的历史列：标号现在是点，这两个一律为 0。不要依赖。 */
  w: number;
  h: number;
  vertices: Array<[number, number]> | null;
  groupId: string | null;
  orderIndex: number;
  content: string;
  note: string;
  style: Partial<TextStyle>;
  createdAt: string;
  updatedAt: string;
};

export type TranslationRow = {
  id: string;
  userId: string | null;
  displayName: string;
  content: string;
  proofreadContent: string;
  proofreaderId: string | null;
  proofreadAt: string | null;
  isSelected: boolean;
  machineTranslated: boolean;
  updatedAt: string;
};

export type SourceWithTranslations = SourceRow & {
  translations: TranslationRow[];
  selected: TranslationRow | null;
  mine: TranslationRow | null;
};

export type TranslationCompleteness = {
  sourceCount: number;
  targets: Array<{ targetId: string; language: string; label: string; translated: number; proofread: number }>;
  allTranslated: boolean;
  allProofread: boolean;
};

export type FileWorkbench = {
  file: {
    id: string;
    name: string;
    width: number;
    height: number;
    state: FileState;
    projectId: string;
  };
  targets: Array<{ id: string; language: string; label: string }>;
  targetId: string | null;
  sources: SourceWithTranslations[];
  completeness: TranslationCompleteness;
  my: { canTranslate: boolean; canProofread: boolean; canCheck: boolean };
};

export type CreditLine = {
  id: string;
  role: string;
  userId: string | null;
  displayName: string;
  source: string;
  createdAt: string;
};

export type CreditSummary = Record<string, { names: string[]; text: string }>;

export type NotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  teamId: string | null;
  projectId: string | null;
  fileId: string | null;
  read: boolean;
  createdAt: string;
};

export const sourceApi = {
  list: (fileId: string) =>
    apiRequest<{ sources: SourceRow[]; fileState: FileState }>(`/files/${fileId}/sources`),

  /** 批量保存。`replace` 为真时请求里没出现的标号会被删除。 */
  save: (
    fileId: string,
    sources: Array<Partial<SourceRow> & { id?: string; x: number; y: number }>,
    replace = false,
  ) =>
    apiRequest<{ sources: SourceRow[]; removed: string[] }>(`/files/${fileId}/sources`, {
      method: 'PUT',
      body: { sources, replace },
    }),

  create: (fileId: string, payload: Partial<SourceRow> & { x: number; y: number }) =>
    apiRequest<{ source: SourceRow }>(`/files/${fileId}/sources`, { method: 'POST', body: payload }),

  remove: (fileId: string, sourceId: string) =>
    apiRequest<{ ok: true }>(`/files/${fileId}/sources/${sourceId}`, { method: 'DELETE' }),
};

export const translateApi = {
  /** 工作台主数据：一张图的标号 + 指定语言的全部译文候选。 */
  load: (fileId: string, targetId?: string) =>
    apiRequest<FileWorkbench>(
      `/files/${fileId}/translations${targetId ? `?targetId=${targetId}` : ''}`,
    ),

  saveTranslations: (fileId: string, targetId: string, items: Array<{ sourceId: string; content: string }>) =>
    apiRequest<{ translations: Record<string, TranslationRow[]>; completeness: TranslationCompleteness }>(
      `/files/${fileId}/translations`,
      { method: 'PUT', body: { targetId, items } },
    ),

  saveProofreads: (
    fileId: string,
    targetId: string,
    items: Array<{ sourceId: string; proofreadContent: string; translationId?: string }>,
  ) =>
    apiRequest<{ translations: Record<string, TranslationRow[]>; completeness: TranslationCompleteness }>(
      `/files/${fileId}/proofreads`,
      { method: 'PUT', body: { targetId, items } },
    ),

  select: (translationId: string) =>
    apiRequest<{ ok: true }>(`/translations/${translationId}/select`, { method: 'POST' }),

  removeTranslation: (translationId: string) =>
    apiRequest<{ ok: true }>(`/translations/${translationId}`, { method: 'DELETE' }),

  stats: (projectId: string, targetId?: string) =>
    apiRequest<{
      targets: Array<{ id: string; language: string; label: string }>;
      targetId: string | null;
      files: Record<string, { sources: number; translated: number; proofread: number }>;
    }>(`/projects/${projectId}/translation-stats${targetId ? `?targetId=${targetId}` : ''}`),
};

export const workflowApi = {
  transition: (fileId: string, to: FileState, note?: string) =>
    apiRequest<{
      from: FileState;
      to: FileState;
      backward: boolean;
      notified: number;
      completeness: TranslationCompleteness;
    }>(`/files/${fileId}/state`, { method: 'POST', body: { to, note } }),

  history: (fileId: string) =>
    apiRequest<{ history: Array<{ from: string | null; to: string; note: string; actorName: string; at: string }> }>(
      `/files/${fileId}/state-history`,
    ),

  summary: (projectId: string) =>
    apiRequest<{
      byState: Record<string, number>;
      total: number;
      stages: Array<{ key: string; label: string }>;
    }>(`/projects/${projectId}/state-summary`),

  credits: (fileId: string) =>
    apiRequest<{ credits: CreditLine[]; summary: CreditSummary; roleLabels: Record<string, string>; completeness: TranslationCompleteness }>(
      `/files/${fileId}/credits`,
    ),

  setCredits: (fileId: string, role: string, entries: Array<{ userId?: string | null; username?: string; displayName?: string }>) =>
    apiRequest<{ credits: CreditLine[]; summary: CreditSummary }>(`/files/${fileId}/credits`, {
      method: 'PUT',
      body: { role, entries },
    }),

  myTodos: () =>
    apiRequest<{
      todos: Array<{ fileId: string; projectId: string; role: string; state: string }>;
      byProject: Record<string, number>;
      total: number;
    }>('/my-todos'),
};

export const notificationApi = {
  mine: (unreadOnly = false) =>
    apiRequest<{ unread: number; notifications: NotificationRow[] }>(
      `/notifications${unreadOnly ? '?unreadOnly=1' : ''}`,
    ),

  markRead: (payload: { all?: boolean; ids?: string[] }) =>
    apiRequest<{ ok: true; marked: number }>('/notifications/read', { method: 'POST', body: payload }),
};

export const moveApi = {
  targets: (projectId: string) =>
    apiRequest<{
      projects: Array<{
        id: string;
        serial: number;
        name: string;
        setId: string | null;
        targetLanguages: Array<{ language: string; label: string }>;
      }>;
    }>(`/projects/${projectId}/move-targets`),

  move: (projectId: string, toProjectId: string, fileIds: string[]) =>
    apiRequest<{ ok: true; moved: number; translationsRemapped: number; createdTargets: Array<{ language: string; label: string }> }>(
      `/projects/${projectId}/files/move`,
      { method: 'POST', body: { toProjectId, fileIds } },
    ),
};

export const authApi = {
  login: (username: string, password: string) =>
    apiRequest<{ user: PublicUser }>('/auth/login', { method: 'POST', body: { username, password } }),

  register: (payload: {
    username: string;
    password: string;
    displayName?: string;
    inviteCode: string;
  }) => apiRequest<{ user: PublicUser }>('/auth/register', { method: 'POST', body: payload }),

  logout: () => apiRequest<{ ok: true }>('/auth/logout', { method: 'POST' }),

  me: () => apiRequest<{ user: PublicUser }>('/auth/me'),

  registrationStatus: () =>
    apiRequest<{ open: boolean; viaEnv: boolean }>('/auth/registration-status'),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiRequest<{ ok: true; message: string }>('/auth/password', {
      method: 'PATCH',
      body: { currentPassword, newPassword },
    }),
};

/**
 * 站点品牌 —— 后端已经把缺省值与立绘地址拼好了，前端直接渲染。
 * 前端**不保留一份默认站名**：两边各写一份，改站名时必然漏掉一处。
 */
export type SiteBranding = {
  name: string;
  englishName: string;
  slogan: string;
  description: string;
  footer: string;
  hasMascot: boolean;
  mascotUrl: string | null;
};

export const siteApi = {
  /** 键值表的原样导出。要渲染用的品牌信息请用 `branding()`。 */
  settings: () => apiRequest<{ settings: Record<string, unknown> }>('/site/settings'),

  branding: () => apiRequest<{ branding: SiteBranding }>('/site/branding'),
};

export const permissionApi = {
  list: () => apiRequest<{ permissions: PermissionInfo[]; scopes: string[] }>('/permissions'),
};

export const teamApi = {
  mine: () => apiRequest<{ teams: TeamSummary[] }>('/teams'),

  create: (name: string, intro?: string) =>
    apiRequest<{ team: { id: string; name: string; intro: string } }>('/teams', {
      method: 'POST',
      body: { name, intro },
    }),

  detail: (teamId: string) => apiRequest<TeamDetail>(`/teams/${teamId}`),

  update: (teamId: string, patch: { name?: string; intro?: string }) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}`, { method: 'PATCH', body: patch }),

  remove: (teamId: string) => apiRequest<{ ok: true }>(`/teams/${teamId}`, { method: 'DELETE' }),

  members: (teamId: string) =>
    apiRequest<{ members: TeamMemberRow[] }>(`/teams/${teamId}/members`),

  addMember: (teamId: string, username: string, roleId: string) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/members`, {
      method: 'POST',
      body: { username, roleId },
    }),

  changeMemberRole: (teamId: string, userId: string, roleId: string) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/members/${userId}`, {
      method: 'PATCH',
      body: { roleId },
    }),

  removeMember: (teamId: string, userId: string) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),

  createRole: (
    teamId: string,
    payload: { name: string; level: number; intro?: string; permissions: string[]; autoProjectAdmin?: boolean },
  ) => apiRequest<{ roleId: string }>(`/teams/${teamId}/roles`, { method: 'POST', body: payload }),

  updateRole: (
    teamId: string,
    roleId: string,
    payload: { name?: string; level?: number; intro?: string; permissions?: string[]; autoProjectAdmin?: boolean },
  ) => apiRequest<{ ok: true }>(`/teams/${teamId}/roles/${roleId}`, { method: 'PATCH', body: payload }),

  removeRole: (teamId: string, roleId: string) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/roles/${roleId}`, { method: 'DELETE' }),

  invites: (teamId: string) => apiRequest<{ invites: InviteRow[] }>(`/teams/${teamId}/invites`),

  createInvites: (
    teamId: string,
    payload: { roleId?: string | null; maxUses?: number | null; expiresAt?: string | null; note?: string; count?: number },
  ) =>
    apiRequest<{ invites: Array<{ id: string; code: string }> }>(`/teams/${teamId}/invites`, {
      method: 'POST',
      body: payload,
    }),

  toggleInvite: (teamId: string, inviteId: string, enabled: boolean) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/invites/${inviteId}`, {
      method: 'PATCH',
      body: { enabled },
    }),

  removeInvite: (teamId: string, inviteId: string) =>
    apiRequest<{ ok: true }>(`/teams/${teamId}/invites/${inviteId}`, { method: 'DELETE' }),
};

export const noticeApi = {
  mine: (scope: 'all' | 'unread' = 'all') =>
    apiRequest<{ unread: number; notices: NoticeRow[] }>(`/notices?scope=${scope}`),

  markRead: (payload: { all?: boolean; ids?: string[] }) =>
    apiRequest<{ ok: true; marked: number }>('/notices/read', { method: 'POST', body: payload }),
};

export const adminApi = {
  users: (params: { q?: string; status?: string; page?: number; pageSize?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.status) search.set('status', params.status);
    if (params.page) search.set('page', String(params.page));
    if (params.pageSize) search.set('pageSize', String(params.pageSize));
    const qs = search.toString();
    return apiRequest<{
      users: PublicUser[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    }>(`/admin/users${qs ? `?${qs}` : ''}`);
  },

  createUser: (payload: { username: string; password: string; displayName?: string; isSiteAdmin?: boolean }) =>
    apiRequest<{ user: PublicUser }>('/admin/users', { method: 'POST', body: payload }),

  updateUser: (userId: string, patch: { displayName?: string; status?: 'active' | 'disabled' }) =>
    apiRequest<{ ok: true }>(`/admin/users/${userId}`, { method: 'PATCH', body: patch }),

  resetPassword: (userId: string, newPassword?: string) =>
    apiRequest<{ ok: true; generatedPassword?: string }>(`/admin/users/${userId}/password`, {
      method: 'PATCH',
      body: newPassword ? { newPassword } : {},
    }),

  setSiteAdmin: (userId: string, isSiteAdmin: boolean) =>
    apiRequest<{ ok: true }>(`/admin/users/${userId}/site-admin`, {
      method: 'PATCH',
      body: { isSiteAdmin },
    }),

  deactivateUser: (userId: string) =>
    apiRequest<{ ok: true }>(`/admin/users/${userId}`, { method: 'DELETE' }),

  teams: () =>
    apiRequest<{
      teams: Array<{ id: string; name: string; intro: string; status: string; memberCount: number; createdAt: string }>;
    }>('/admin/teams'),

  settings: () =>
    apiRequest<{ settings: Record<string, unknown>; allowedKeys: string[] }>('/admin/settings'),

  saveSettings: (patch: Record<string, unknown>) =>
    apiRequest<{ ok: true; branding: SiteBranding }>('/admin/settings', { method: 'PUT', body: patch }),

  /** 立绘上传。走带进度的那条通道 —— 立绘经常是几 MB 的 PNG，没有进度条很像卡住了。 */
  uploadMascot: (file: File, onProgress?: (loaded: number, total: number) => void) =>
    uploadWithProgress<{ ok: true; branding: SiteBranding }>(
      '/admin/settings/mascot',
      file,
      onProgress,
    ),

  clearMascot: () =>
    apiRequest<{ ok: true; branding: SiteBranding }>('/admin/settings/mascot', { method: 'DELETE' }),

  notices: () => apiRequest<{ notices: NoticeRow[] }>('/admin/notices'),

  createNotice: (payload: { title?: string; content: string; enabled?: boolean }) =>
    apiRequest<{ noticeId: string }>('/admin/notices', { method: 'POST', body: payload }),

  updateNotice: (noticeId: string, patch: { title?: string; content?: string; enabled?: boolean }) =>
    apiRequest<{ ok: true }>(`/admin/notices/${noticeId}`, { method: 'PATCH', body: patch }),

  removeNotice: (noticeId: string) =>
    apiRequest<{ ok: true }>(`/admin/notices/${noticeId}`, { method: 'DELETE' }),

  storageUsage: () =>
    apiRequest<{
      driver: string;
      disk: {
        usedBytes: number;
        totalBytes: number | null;
        availableBytes: number | null;
        objectCount: number;
        elapsedMs: number;
      };
      byTeam: Array<{ teamId: string; teamName: string; fileCount: number; bytes: number }>;
      projectCount: number;
    }>('/admin/storage-usage'),
};
