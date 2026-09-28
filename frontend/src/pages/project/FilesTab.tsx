import {
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  InboxOutlined,
  LinkOutlined,
  PictureOutlined,
  ReadOutlined,
  SwapOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Empty,
  Image,
  Input,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, fileApi, translateApi, type ProjectFileRow } from '../../api/client';
import { ExportModal } from '../../components/ExportModal';
import { FileMoveModal } from '../../components/FileMoveModal';
import { ImportModal } from '../../components/ImportModal';
import { OutputModal } from '../../components/OutputModal';
import { UploadModal } from '../../components/UploadModal';
import { useClientConfig } from '../../hooks/useClientConfig';
import { palette } from '../../theme';
import { formatBytes } from '../../utils/time';
import type { ProjectTabProps } from './index';

/** 卡片右下角那行小字：有标号就显示译文进度，否则显示体积。 */
function fileStat(
  stats: Record<string, { sources: number; translated: number; proofread: number }>,
  fileId: string,
): React.ReactNode {
  const stat = stats[fileId];
  return (
    <Typography.Text type="secondary" style={{ fontSize: 10 }}>
      {stat && stat.sources > 0 ? `译 ${stat.translated}/${stat.sources}` : '暂无标号'}
    </Typography.Text>
  );
}

const STATE_LABEL: Record<string, string> = {
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

export function FilesTab({
  detail,
  reload,
  can,
  openUploadSignal,
  openTranslateSignal,
}: ProjectTabProps & { openUploadSignal: number; openTranslateSignal: number }) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const { maxImageMb } = useClientConfig();
  const projectId = detail.project.id;

  const [files, setFiles] = useState<ProjectFileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queue, setQueue] = useState<File[]>([]);
  const [renaming, setRenaming] = useState<ProjectFileRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [moving, setMoving] = useState(false);
  /** fileId → 译文进度。列表上每张图显示「译 3/12」用。 */
  const [stats, setStats] = useState<Record<string, { sources: number; translated: number; proofread: number }>>({});

  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 正在看哪张图的成品。null = 弹窗关着。 */
  const [outputTarget, setOutputTarget] = useState<ProjectFileRow | null>(null);

  const queueRef = useRef<File[]>([]);
  const flushTimer = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fileApi.list(projectId, {
        ...(keyword ? { keyword } : {}),
        ...(showDeleted ? { includeDeleted: true } : {}),
      });
      setFiles(res.files);
      setSelected(new Set());
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '图片加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, keyword, showDeleted, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // 译文进度单独拉（它要扫全部标号与译文，不适合塞进文件列表里）。
  useEffect(() => {
    void translateApi
      .stats(projectId)
      .then((res) => setStats(res.files))
      .catch(() => undefined);
  }, [projectId]);

  /** 浏览器按张触发 beforeUpload，这里攒一拍再打开弹窗，避免每张各弹一次。 */
  const pushQueue = useCallback((file: File) => {
    queueRef.current.push(file);
    if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => {
      const batch = queueRef.current;
      queueRef.current = [];
      flushTimer.current = null;
      if (batch.length > 0) setQueue(batch);
    }, 0);
  }, []);

  // 页头的「上传图片」按钮：切到本 tab 并自增信号，这里据此打开文件选择框。
  useEffect(() => {
    if (openUploadSignal > 0) inputRef.current?.click();
  }, [openUploadSignal]);

  // 页头的「翻校」按钮：直接进第一张图的工作页。
  // 由这里跳而不是页头自己算，是因为文件列表（含自然排序）本来就在这个组件里，
  // 页头再拉一次列表只为了知道第一张是谁，纯属浪费。
  useEffect(() => {
    if (openTranslateSignal > 0 && files[0]) {
      navigate(`/projects/${projectId}/workbench/${files[0].id}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTranslateSignal]);

  async function doRename() {
    if (!renaming) return;
    try {
      await fileApi.rename(renaming.id, renameValue.trim());
      message.success('已重命名');
      setRenaming(null);
      void load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '重命名失败');
    }
  }

  async function removeSelected() {
    try {
      const res = await fileApi.batchRemove(projectId, [...selected]);
      message.success(`已删除 ${res.deleted} 张`);
      void load();
      void reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    }
  }

  const allSelected = files.length > 0 && selected.size === files.length;

  return (
    <Card
      title={`图片（${files.length}）`}
      extra={
        <Space wrap>
          {can('tra.add') || can('tra.proofread') ? (
            <Button
              size="small"
              icon={<ReadOutlined />}
              disabled={files.length === 0}
              onClick={() => {
                const first = files[0];
                if (first) navigate(`/projects/${projectId}/workbench/${first.id}`);
              }}
            >
              开始翻校
            </Button>
          ) : null}
          {can('tra.output') ? (
            <Button
              size="small"
              icon={<ExportOutlined />}
              disabled={files.length === 0}
              onClick={() => setExporting(true)}
            >
              导出嵌字包
            </Button>
          ) : null}
          <Input.Search
            allowClear
            size="small"
            placeholder="按文件名搜索"
            style={{ width: 180 }}
            onSearch={setKeyword}
          />
          <Space size={4}>
            <Switch size="small" checked={showDeleted} onChange={setShowDeleted} />
            <Typography.Text style={{ fontSize: 12 }}>含已删除</Typography.Text>
          </Space>

          {can('file.delete') && selected.size > 0 ? (
            <Popconfirm
              title={`删除选中的 ${selected.size} 张图片？`}
              description="图片会从列表中移除；已有的标号与译文记录保留。"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => void removeSelected()}
            >
              <Button size="small" danger icon={<DeleteOutlined />}>
                删除选中（{selected.size}）
              </Button>
            </Popconfirm>
          ) : null}

          {can('file.move') && selected.size > 0 ? (
            <Button size="small" icon={<SwapOutlined />} onClick={() => setMoving(true)}>
              移动选中（{selected.size}）
            </Button>
          ) : null}

          {can('file.add') ? (
            <Upload
              multiple
              showUploadList={false}
              accept="image/*"
              beforeUpload={(file) => {
                pushQueue(file as unknown as File);
                // 返回 false 表示「不要上传」—— 真正的上传由 UploadModal 逐张负责，
                // 那里才有进度条与重试。
                return false;
              }}
            >
              <Button size="small" type="primary" icon={<UploadOutlined />}>
                上传图片
              </Button>
            </Upload>
          ) : null}

          {/* 导入与上传是同一件事的两种来源（一个是本地文件、一个是链接），
              所以用同一个权限位，摆在同一个位置。 */}
          {can('file.add') ? (
            <Button size="small" icon={<LinkOutlined />} onClick={() => setImporting(true)}>
              从链接导入
            </Button>
          ) : null}
        </Space>
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          for (const file of Array.from(event.target.files ?? [])) pushQueue(file);
          event.target.value = '';
        }}
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : files.length === 0 ? (
        <Card styles={{ body: { padding: 0 } }} variant="borderless">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={2}>
                <Typography.Text>还没有图片</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  支持 JPG / PNG / WebP / GIF / AVIF，单张不超过 {maxImageMb}MB。
                </Typography.Text>
              </Space>
            }
          />
        </Card>
      ) : (
        <>
          <Space style={{ marginBottom: 10 }} size={12}>
            <Checkbox
              checked={allSelected}
              indeterminate={selected.size > 0 && !allSelected}
              onChange={(event) => {
                setSelected(event.target.checked ? new Set(files.map((f) => f.id)) : new Set());
              }}
            >
              全选
            </Checkbox>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              按页码自然排序（p2 在 p10 之前）
            </Typography.Text>
          </Space>

          {/* PreviewGroup 让灯箱里的 ← → 能在整组图片间翻页 ——
              这正是翻校时最常用的动作，M3 的画布会在此基础上做标号。 */}
          <Image.PreviewGroup>
            <div className="nm-file-grid">
              {files.map((file) => {
                const isSelected = selected.has(file.id);
                const deleted = Boolean(file.deletedAt);
                return (
                  <div
                    key={file.id}
                    className={`nm-file-card${isSelected ? ' is-selected' : ''}`}
                    style={{ opacity: deleted ? 0.45 : 1 }}
                  >
                    <div className="nm-file-thumb">
                      {deleted ? (
                        <Space direction="vertical" size={4} style={{ color: palette.inkSoft }}>
                          <InboxOutlined style={{ fontSize: 20 }} />
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            已删除
                          </Typography.Text>
                        </Space>
                      ) : (
                        <Image
                          src={fileApi.mediaUrl(file.id, 'thumb')}
                          preview={{ src: fileApi.mediaUrl(file.id, 'preview') }}
                          alt={file.name}
                          loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          // 缩略图缺失（迁移数据或清理过）时给一个静态占位，
                          // 而不是 antd 默认的破图图标。
                          fallback="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMjAiIGhlaWdodD0iMTYwIj48cmVjdCB3aWR0aD0iMTIwIiBoZWlnaHQ9IjE2MCIgZmlsbD0iI2YwZTRkYSIvPjwvc3ZnPg=="
                        />
                      )}

                      {can('file.delete') ? (
                        <Checkbox
                          className="nm-file-check"
                          checked={isSelected}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(file.id);
                            else next.delete(file.id);
                            setSelected(next);
                          }}
                        />
                      ) : null}
                    </div>

                    <div className="nm-file-meta">
                      <Tooltip title={file.name}>
                        <Typography.Text ellipsis style={{ fontSize: 12, display: 'block' }}>
                          {file.name}
                        </Typography.Text>
                      </Tooltip>
                      <Space size={4} style={{ marginTop: 2 }} wrap>
                        <Typography.Text type="secondary" style={{ fontSize: 10 }}>
                          {STATE_LABEL[file.state] ?? file.state}
                        </Typography.Text>
                        {fileStat( stats, file.id )}
                        {/* 成品数直接标在卡上：嵌字进度是这一页最需要一眼看到的信息，
                            否则得逐张点开弹窗才知道哪张还没回传。 */}
                        {file.outputCount > 0 ? (
                          <Tooltip title={`已回传 ${file.outputCount} 版成品`}>
                            <Button
                              size="small"
                              type="text"
                              style={{ padding: 0, height: 16, fontSize: 10, color: palette.success }}
                              icon={<PictureOutlined />}
                              onClick={() => setOutputTarget(file)}
                            >
                              {file.outputCount}
                            </Button>
                          </Tooltip>
                        ) : null}
                      </Space>
                    </div>

                    {!deleted && (can('tra.add') || can('tra.proofread')) ? (
                      <Tooltip title="进入翻校">
                        <Button
                          className="nm-file-open"
                          size="small"
                          icon={<ReadOutlined />}
                          onClick={() => navigate(`/projects/${projectId}/workbench/${file.id}`)}
                        />
                      </Tooltip>
                    ) : null}

                    {!deleted && can('file.typeset') && file.outputCount === 0 ? (
                      <Tooltip title="回传嵌字成品">
                        <Button
                          className="nm-file-open"
                          size="small"
                          icon={<PictureOutlined />}
                          style={{ right: 34 }}
                          onClick={() => setOutputTarget(file)}
                        />
                      </Tooltip>
                    ) : null}

                    {!deleted && (can('file.rename') || can('file.delete')) ? (
                      <div className="nm-file-actions">
                        {can('file.rename') ? (
                          <Button
                            size="small"
                            type="text"
                            icon={<EditOutlined />}
                            onClick={() => {
                              setRenaming(file);
                              setRenameValue(file.name);
                            }}
                          />
                        ) : null}
                        {can('file.delete') ? (
                          <Popconfirm
                            title="删除这张图片？"
                            okText="删除"
                            okButtonProps={{ danger: true }}
                            cancelText="取消"
                            onConfirm={() =>
                              void fileApi
                                .remove(file.id)
                                .then(() => {
                                  message.success('已删除');
                                  void load();
                                  void reload();
                                })
                                .catch((err) => message.error(err instanceof ApiError ? err.message : '删除失败'))
                            }
                          >
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Image.PreviewGroup>
        </>
      )}

      <UploadModal
        projectId={queue.length > 0 ? projectId : null}
        files={queue}
        maxImageMb={maxImageMb}
        onClose={() => setQueue([])}
        onFinished={() => {
          void load();
          void reload();
        }}
      />

      <ImportModal
        open={importing}
        projectId={projectId}
        onClose={() => setImporting(false)}
        // 导入是异步的：这里只在「真的有图进来了」的时候刷新列表，
        // 而不是打开弹窗就刷 —— 否则用户每开一次弹窗，整个网格就重渲一次。
        onImported={() => {
          void load();
          void reload();
        }}
      />

      <FileMoveModal
        open={moving}
        projectId={projectId}
        fileIds={[...selected]}
        fileNames={files.filter((f) => selected.has(f.id)).map((f) => f.name)}
        onClose={() => setMoving(false)}
        onMoved={() => {
          setSelected(new Set());
          void load();
          void reload();
        }}
      />

      <ExportModal
        open={exporting}
        projectId={projectId}
        onClose={() => setExporting(false)}
      />

      <OutputModal
        open={outputTarget !== null}
        fileId={outputTarget?.id ?? null}
        fileName={outputTarget?.name ?? ''}
        canUpload={can('file.typeset')}
        onClose={() => setOutputTarget(null)}
        // 上传/删除之后要刷新网格上的成品数，否则徽标还停在旧数字上
        onChanged={() => void load()}
      />

      <Modal
        title="重命名图片"
        open={renaming !== null}
        onCancel={() => setRenaming(null)}
        onOk={() => void doRename()}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          只改显示名与排序位置，图片本身与已有标号不受影响。
        </Typography.Paragraph>
        <Input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={() => void doRename()}
          maxLength={180}
          autoFocus
        />
      </Modal>
    </Card>
  );
}
