import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  LeftOutlined,
  RightOutlined,
  RollbackOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  fileApi,
  sourceApi,
  translateApi,
  workflowApi,
  type FileWorkbench,
  type ProjectFileRow,
  type SourceWithTranslations,
} from '../../api/client';
import { comiku } from '../../theme';
import { Canvas, type CanvasTextMode, type CanvasTool } from './Canvas';
import { SourcePanel } from './SourcePanel';
import { CreditsBar } from '../../components/CreditsBar';

/**
 * 翻校工作台 —— M3 的核心界面。
 *
 * 布局是「左图右字」：左边整块给画布（看图和摆框是这一页存在的理由），
 * 右边是标号列表与译文输入。中间那一列可以收起，窄屏时自动上下堆叠。
 *
 * 关于**编辑器状态的三个决定**：
 *
 * 1. **改动先落本地 drafts，保存时才提交**。这不是「省请求」，而是因为
 *    译者在同一页上会反复来回改：逐字自动保存会把半句话也写进库里，
 *    而校对看到的就是半句话。显式保存 + 切页时自动保存，是更稳的组合。
 * 2. **切页前自动保存**。做完一页就翻下一页是最高频的动作，
 *    如果每翻一页都弹「未保存」确认框，用户三天就会开始无脑点「不保存」。
 * 3. **脏数据只提示不阻塞**。离开工作台（回作品页）时如果没保存，
 *    浏览器原生的 beforeunload 拦一道，但切换文件时静默保存 ——
 *    两处的取舍不同，因为一个是「离开这个任务」，一个是「继续做下一个」。
 */

type Mode = 'translate' | 'proofread';

export default function TranslatePage() {
  const { projectId = '', fileId = '' } = useParams();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();

  const [workbench, setWorkbench] = useState<FileWorkbench | null>(null);
  const [files, setFiles] = useState<ProjectFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [targetId, setTargetId] = useState<string>('');
  const [mode, setMode] = useState<Mode>('translate');
  const [tool, setTool] = useState<CanvasTool>('select');
  const [textMode, setTextMode] = useState<CanvasTextMode>('translation');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  /** 未提交的编辑：sourceId → 文本 */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, string>>({});
  /**
   * 几何改动也攒着一起提交。标号拖动很频繁，逐个提交会打出一串请求，
   * 而它们的到达顺序不保证 —— 最后落库的可能是较早的那次。
   */
  const [geometry, setGeometry] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
  const [newSources, setNewSources] = useState<Array<{ tempId: string; rect: { x: number; y: number; w: number; h: number }; kind: 'box' | 'pin' }>>([]);

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const index = files.findIndex((f) => f.id === fileId);
  const current = index >= 0 ? files[index] : undefined;
  const prevFile = index > 0 ? files[index - 1] : undefined;
  const nextFile = index >= 0 && index < files.length - 1 ? files[index + 1] : undefined;

  // ── 载入 ──────────────────────────────────────────────────
  const load = useCallback(
    async (preserveTarget = false) => {
      if (!fileId) return;
      setLoading(true);
      try {
        const data = await translateApi.load(fileId, preserveTarget && targetId ? targetId : undefined);
        setWorkbench(data);
        setTargetId(data.targetId ?? '');

        const nextDrafts: Record<string, string> = {};
        for (const source of data.sources) {
          const selected = source.selected;
          nextDrafts[source.id] =
            mode === 'proofread' ? (selected?.proofreadContent ?? '') : (selected?.content ?? '');
        }
        setDrafts(nextDrafts);
        setSourceDrafts({});
        setGeometry({});
        setNewSources([]);
        setDirty(false);
        setSelectedId(data.sources[0]?.id ?? null);

        // 默认模式跟着「我在这部作品里的身份」走：校对进来就进校对模式，
        // 否则他每次都要先手动切一下。
        if (!data.my.canTranslate && data.my.canProofread) setMode('proofread');
      } catch (err) {
        message.error(err instanceof ApiError ? err.message : '载入失败');
        setWorkbench(null);
      } finally {
        setLoading(false);
      }
    },
    // targetId / mode 刻意不进依赖：它们是「载入的参数」而不是「载入的触发条件」，
    // 放进去会造成「改模式就重新拉整页」的循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fileId, message],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!projectId) return;
    void fileApi
      .list(projectId)
      .then((res) => setFiles(res.files))
      .catch(() => undefined);
  }, [projectId]);

  // 换目标语言时重新拉一次译文（标号不变，但译文是分语言的）。
  const switchTarget = async (next: string) => {
    if (dirtyRef.current && !(await save())) return;
    setTargetId(next);
    setLoading(true);
    try {
      const data = await translateApi.load(fileId, next);
      setWorkbench(data);
      const nextDrafts: Record<string, string> = {};
      for (const source of data.sources) {
        const selected = source.selected;
        nextDrafts[source.id] =
          mode === 'proofread' ? (selected?.proofreadContent ?? '') : (selected?.content ?? '');
      }
      setDrafts(nextDrafts);
      setDirty(false);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '切换语言失败');
    } finally {
      setLoading(false);
    }
  };

  // ── 保存 ──────────────────────────────────────────────────
  const save = useCallback(async (): Promise<boolean> => {
    if (!workbench || !targetId) return true;

    const hasTextChanges = Object.keys(drafts).length > 0 && dirty;
    const hasGeometryChanges = Object.keys(geometry).length > 0 || newSources.length > 0 || Object.keys(sourceDrafts).length > 0;
    if (!hasTextChanges && !hasGeometryChanges) {
      setDirty(false);
      return true;
    }

    setSaving(true);
    try {
      // ① 先保存标号几何与原文 —— 新标号必须先拿到服务端 id，
      //    否则紧接着的译文保存没有 sourceId 可挂。
      if (hasGeometryChanges) {
        const existing = mergeSources(workbench.sources, geometry, sourceDrafts);
        const payload = [
          ...existing.map((s) => ({
            id: s.id,
            kind: s.kind,
            x: s.x,
            y: s.y,
            w: s.w,
            h: s.h,
            vertices: s.vertices,
            groupId: s.groupId,
            orderIndex: s.orderIndex,
            content: s.content,
            note: s.note,
            style: s.style,
          })),
          ...newSources.map((s) => ({
            kind: s.kind,
            x: s.rect.x,
            y: s.rect.y,
            w: s.rect.w,
            h: s.rect.h,
            content: '',
            note: '',
            style: {},
          })),
        ];

        const saved = await sourceApi.save(fileId, payload);
        const byKey = new Map<string, string>();
        // 服务端按 orderIndex + createdAt 返回，新建的排在后面 ——
        // 用「顺序」把本地的临时框与服务端 id 对上，而不是猜。
        const created = saved.sources.slice(saved.sources.length - newSources.length);
        newSources.forEach((local, i) => {
          const server = created[i];
          if (server) byKey.set(local.tempId, server.id);
        });

        // 把新标号的译文草稿挪到真实 id 上，否则刚写的译文会丢。
        const migrated: Record<string, string> = {};
        for (const [key, value] of Object.entries(drafts)) {
          migrated[byKey.get(key) ?? key] = value;
        }

        setGeometry({});
        setNewSources([]);
        setSourceDrafts({});
        setDrafts(migrated);

        // ② 译文依赖上面的标号 id，所以必须等它完成。
        if (hasTextChanges) {
          await saveText(migrated, saved.sources);
        }
      } else if (hasTextChanges) {
        await saveText(drafts, workbench.sources);
      }

      setDirty(false);
      void load(true);
      return true;
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
      return false;
    } finally {
      setSaving(false);
    }

    // 只用到 id，所以刻意收窄成最小形状 —— 免得为了「类型对上」
    // 去构造一份完整的 SourceWithTranslations。
    async function saveText(textDrafts: Record<string, string>, sources: Array<{ id: string }>) {
      const validIds = new Set(sources.map((s) => s.id));
      const items = Object.entries(textDrafts)
        .filter(([id]) => validIds.has(id))
        .map(([sourceId, content]) => ({ sourceId, content }));

      if (items.length === 0) return;

      if (mode === 'proofread') {
        await translateApi.saveProofreads(fileId, targetId, items.map((i) => ({ ...i, proofreadContent: i.content })));
      } else {
        await translateApi.saveTranslations(fileId, targetId, items);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbench, targetId, drafts, geometry, newSources, sourceDrafts, dirty, mode, fileId, message, load]);

  // ── 键盘 ──────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA'].includes(target.tagName);

      // Ctrl/⌘+S 在输入框里也要生效 —— 这是所有人的肌肉记忆。
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
        return;
      }
      if (typing) return;

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        void go(prevFile?.id);
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        void go(nextFile?.id);
      }
      if (event.key === 'Delete' && selectedId) {
        void removeSource(selectedId);
      }
      if (event.key === 'Escape') setTool('select');
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save, prevFile?.id, nextFile?.id, selectedId]);

  // 离开工作台（关闭标签页/跳走）时拦一道：这一次是真的要离开这个任务了。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** 翻页：先保存再走。不弹确认框 —— 见文件头的说明。 */
  const go = async (nextId?: string) => {
    if (!nextId) return;
    if (dirtyRef.current && !(await save())) return;
    navigate(`/projects/${projectId}/workbench/${nextId}`);
  };

  // ── 标号操作 ──────────────────────────────────────────────
  const createSource = (rect: { x: number; y: number; w: number; h: number }, kind: 'box' | 'pin') => {
    const tempId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setNewSources((list) => [...list, { tempId, rect, kind }]);
    setDrafts((prev) => ({ ...prev, [tempId]: '' }));
    setSelectedId(tempId);
    setDirty(true);
  };

  const changeGeometry = (id: string, rect: { x: number; y: number; w: number; h: number }) => {
    setGeometry((prev) => ({ ...prev, [id]: rect }));
    setDirty(true);
  };

  const removeSource = async (sourceId: string) => {
    if (sourceId.startsWith('new-')) {
      setNewSources((list) => list.filter((s) => s.tempId !== sourceId));
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
      setSelectedId(null);
      return;
    }

    try {
      await sourceApi.remove(fileId, sourceId);
      message.success('已删除');
      setSelectedId(null);
      void load(true);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    }
  };

  // 画布与列表要看到「本地尚未保存的改动」，否则用户改了坐标却看不到变化。
  const displaySources = useMemo(
    () => mergeSources(workbench?.sources ?? [], geometry, sourceDrafts),
    [workbench, geometry, sourceDrafts],
  );

  /**
   * 画布与右侧列表看的是**同一份**数据：服务端已有的标号 + 尚未保存的新框。
   * 合成一处而不是各算一份 —— 两份一旦不同步，就会出现「画布上有这个框、
   * 右侧列表里没有」这种让人怀疑自己操作错了的现象。
   */
  const viewSources: SourceWithTranslations[] = useMemo(() => {
    const pending: SourceWithTranslations[] = newSources.map((item, i) => ({
      id: item.tempId,
      kind: item.kind,
      x: item.rect.x,
      y: item.rect.y,
      w: item.rect.w,
      h: item.rect.h,
      vertices: null,
      groupId: null,
      orderIndex: displaySources.length + i,
      content: '',
      note: '',
      style: {},
      createdAt: '',
      updatedAt: '',
      translations: [],
      selected: null,
      mine: null,
    }));

    return [...displaySources, ...pending];
  }, [displaySources, newSources]);

  // ── 渲染 ──────────────────────────────────────────────────
  if (loading && !workbench) {
    return (
      <div className="nm-centered">
        <Spin size="large" />
      </div>
    );
  }

  if (!workbench) {
    return (
      <Card>
        <Empty description="这张图片不存在，或你没有访问权限" />
        <Button type="link" onClick={() => navigate(`/projects/${projectId}`)} style={{ paddingLeft: 0 }}>
          回到作品页
        </Button>
      </Card>
    );
  }

  const { file, my, completeness } = workbench;
  const canEdit = mode === 'proofread' ? my.canProofread : my.canTranslate;
  const translated = completeness.targets.find((t) => t.targetId === targetId);
  const nextState = nextActionOf(file.state, my);

  return (
    <div className="nm-translate">
      <div className="nm-translate-bar">
        <Space size={8} wrap>
          <Button
            type="text"
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={() => {
              if (dirtyRef.current) {
                modal.confirm({
                  title: '有未保存的改动',
                  content: '保存后再离开吗？',
                  okText: '保存并离开',
                  cancelText: '直接离开',
                  onOk: async () => {
                    if (await save()) navigate(`/projects/${projectId}`);
                  },
                  onCancel: () => navigate(`/projects/${projectId}`),
                });
              } else {
                navigate(`/projects/${projectId}`);
              }
            }}
          >
            作品
          </Button>

          <Space size={2}>
            <Button
              size="small"
              type="text"
              icon={<LeftOutlined />}
              disabled={!prevFile}
              onClick={() => void go(prevFile?.id)}
            />
            <Typography.Text style={{ fontSize: 13 }}>
              {index >= 0 ? index + 1 : '?'} / {files.length || '?'}
            </Typography.Text>
            <Button
              size="small"
              type="text"
              icon={<RightOutlined />}
              disabled={!nextFile}
              onClick={() => void go(nextFile?.id)}
            />
          </Space>

          <Tooltip title={file.name}>
            <Typography.Text strong style={{ fontSize: 13, maxWidth: 180 }} ellipsis>
              {file.name}
            </Typography.Text>
          </Tooltip>

          <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
            {scoreLabel(file.state)}
          </Tag>

          {translated ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              译 {translated.translated}/{completeness.sourceCount} · 校 {translated.proofread}/
              {completeness.sourceCount}
            </Typography.Text>
          ) : null}
        </Space>

        <Space size={8} wrap>
          <Segmented
            size="small"
            value={mode}
            onChange={(value) => {
              const next = value as Mode;
              setMode(next);
              setTextMode(next === 'proofread' ? 'proofread' : 'translation');
              // 切换模式时把草稿换成对应字段的内容，避免「在校对模式里
              // 看到的是译文、一保存却写进了校对字段」。
              if (workbench) {
                const nextDrafts: Record<string, string> = {};
                for (const source of workbench.sources) {
                  nextDrafts[source.id] =
                    next === 'proofread' ? (source.selected?.proofreadContent ?? '') : (source.selected?.content ?? '');
                }
                setDrafts(nextDrafts);
                setDirty(false);
              }
            }}
            options={[
              { label: '翻译', value: 'translate', disabled: !my.canTranslate },
              { label: '校对', value: 'proofread', disabled: !my.canProofread },
            ]}
          />

          {workbench.targets.length > 1 ? (
            <Select
              size="small"
              value={targetId}
              style={{ width: 130 }}
              onChange={(value) => void switchTarget(value)}
              options={workbench.targets.map((t) => ({ value: t.id, label: t.label }))}
            />
          ) : null}

          <Segmented
            size="small"
            value={textMode}
            onChange={(value) => setTextMode(value as CanvasTextMode)}
            options={[
              { label: '译文', value: 'translation' },
              { label: '原文', value: 'source' },
            ]}
          />

          <Button
            size="small"
            type={dirty ? 'primary' : 'default'}
            icon={<SaveOutlined />}
            loading={saving}
            onClick={() => void save()}
          >
            {dirty ? '保存' : '已保存'}
          </Button>

          {nextState ? (
            <Button
              size="small"
              icon={nextState.backward ? <RollbackOutlined /> : <CheckCircleOutlined />}
              disabled={!nextState.allowed}
              onClick={async () => {
                if (dirtyRef.current && !(await save())) return;
                try {
                  const result = await workflowApi.transition(fileId, nextState.to);
                  message.success(
                    result.notified > 0
                      ? `已标记为「${scoreLabel(result.to)}」，并通知了下一环节的 ${result.notified} 位同事`
                      : `已标记为「${scoreLabel(result.to)}」`,
                  );
                  void load(true);
                } catch (err) {
                  message.error(err instanceof ApiError ? err.message : '状态推进失败');
                }
              }}
            >
              {nextState.label}
            </Button>
          ) : null}
        </Space>
      </div>

      {!canEdit ? (
        <div className="nm-translate-warn">
          {mode === 'proofread' ? '你没有校对权限，当前只能查看。' : '你没有翻译权限，当前只能查看。'}
        </div>
      ) : null}

      <div className="nm-translate-body">
        <div className="nm-translate-canvas">
          <Space size={4} style={{ marginBottom: 8 }}>
            <Segmented
              size="small"
              value={tool}
              onChange={(value) => setTool(value as CanvasTool)}
              options={[
                { label: '选择', value: 'select' },
                { label: '框', value: 'box' },
                { label: '点', value: 'pin' },
              ]}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Ctrl+滚轮缩放 · ←/→ 翻页 · Delete 删除选中
            </Typography.Text>
          </Space>

          <Canvas
            imageUrl={fileApi.mediaUrl(file.id, 'preview')}
            imageWidth={file.width || 1}
            imageHeight={file.height || 1}
            sources={viewSources}
            textMode={textMode}
            selectedId={selectedId}
            tool={tool}
            onSelect={setSelectedId}
            onCreate={createSource}
            onGeometryChange={changeGeometry}
            showHint={canEdit}
          />
        </div>

        <div className="nm-translate-panel">
          <CreditsBar fileId={file.id} canEdit={my.canCheck} projectId={projectId} />
          <SourcePanel
            sources={viewSources}
            drafts={drafts}
            onDraftChange={(id, value) => {
              setDrafts((prev) => ({ ...prev, [id]: value }));
              setDirty(true);
            }}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDelete={(id) => void removeSource(id)}
            canEditSource={my.canTranslate || my.canCheck}
            onSourceTextChange={(id, value) => {
              setSourceDrafts((prev) => ({ ...prev, [id]: value }));
              setDirty(true);
            }}
            mode={mode}
            canDelete={mode === 'translate' ? my.canTranslate : my.canCheck}
          />
        </div>
      </div>
    </div>
  );
}

/** 把本地未提交的几何与原文合并进服务端数据，让画布立刻反映改动。 */
function mergeSources(
  sources: SourceWithTranslations[],
  geometry: Record<string, { x: number; y: number; w: number; h: number }>,
  sourceDrafts: Record<string, string>,
): SourceWithTranslations[] {
  return sources.map((source) => {
    const rect = geometry[source.id];
    const text = sourceDrafts[source.id];
    if (!rect && text === undefined) return source;
    return {
      ...source,
      ...(rect ?? {}),
      ...(text !== undefined ? { content: text } : {}),
    };
  });
}

/** 状态的中文名。与后端 STATE_LABELS 一致，前端只用于展示。 */
function scoreLabel(state: string): string {
  const map: Record<string, string> = {
    sourced: '已入库',
    translating: '翻译中',
    translated: '已翻译',
    proofreading: '校对中',
    proofread: '已校对',
    typesetting: '嵌字中',
    typeset: '已嵌字',
    publishable: '可发布',
    published: '已发布',
  };
  return map[state] ?? state;
}

/**
 * 这张图「下一步该按什么」。
 *
 * 只给**一个**动作，和作品卡上的主操作是同一个思路：把「现在该干什么」
 * 直接摆出来，而不是让用户在一排按钮里自己判断。回退按钮只在
 * 有审核权时出现 —— 那是校对/监理的动作，不是译者的。
 */
function nextActionOf(
  state: string,
  my: { canTranslate: boolean; canProofread: boolean; canCheck: boolean },
): { label: string; to: 'translated' | 'proofread' | 'publishable'; allowed: boolean; backward: boolean } | null {
  switch (state) {
    case 'sourced':
    case 'translating':
      return my.canTranslate
        ? { label: '完成翻译', to: 'translated', allowed: true, backward: false }
        : null;
    case 'translated':
    case 'proofreading':
      return my.canProofread
        ? { label: '完成校对', to: 'proofread', allowed: true, backward: false }
        : null;
    case 'proofread':
      // 到这一站，下一步是嵌字（M5）。有审核权的人可以先打回重做。
      return my.canCheck
        ? { label: '打回重译', to: 'translated', allowed: true, backward: true }
        : null;
    default:
      return null;
  }
}

export { scoreLabel };
