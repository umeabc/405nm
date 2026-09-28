import { Alert, Button, Descriptions, Modal, Select, Space, Spin, Typography } from 'antd';
import { DownloadOutlined, FileTextOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, exportApi, type ExportPreview } from '../api/client';
import { palette } from '../theme';

/**
 * 导出：LabelPlus txt / 工程包 / 成品包。
 *
 * 打开时先做一次**体检**（`/exports/preview`）并把「还有多少标号没翻」
 * 摆在最显眼的地方。这是这个弹窗存在的主要理由 —— 导出本身一个链接就够了，
 * 真正会出问题的是「拿着一个缺译文的包去嵌字」：嵌字的人看不出哪几页是残缺的，
 * 等成品回来才发现翻漏了，那时候返工成本已经付过了。
 *
 * 下载走**浏览器导航**而不是 fetch+blob：工程包可能几百 MB，
 * 先读进内存再触发下载会把标签页拖垮，而且拿不到浏览器自带的下载进度。
 */

type Props = {
  open: boolean;
  projectId: string;
  onClose: () => void;
};

export function ExportModal({ open, projectId, onClose }: Props) {
  const [targets, setTargets] = useState<Array<{ id: string; language: string; label: string }>>([]);
  const [targetId, setTargetId] = useState<string | undefined>();
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    void exportApi
      .targets(projectId)
      .then((res) => {
        setTargets(res.targets);
        setTargetId(res.targets[0]?.id);
        if (res.targets.length === 0) setError('这个作品还没有目标语言，先去「设置」里加一个。');
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : '读取目标语言失败'));
  }, [open, projectId]);

  const loadPreview = useCallback(
    async (id: string) => {
      setLoading(true);
      setError('');
      try {
        setPreview(await exportApi.preview(projectId, id));
      } catch (err) {
        setPreview(null);
        setError(err instanceof ApiError ? err.message : '读取导出信息失败');
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (open && targetId) void loadPreview(targetId);
  }, [open, targetId, loadPreview]);

  const untranslated = preview
    ? preview.markerStats.fallbackToSource + preview.markerStats.empty
    : 0;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      title="导出嵌字包"
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space size={8} wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            目标语言
          </Typography.Text>
          <Select
            size="small"
            style={{ minWidth: 180 }}
            value={targetId}
            onChange={setTargetId}
            options={targets.map((t) => ({ value: t.id, label: `${t.label}（${t.language}）` }))}
            placeholder="选择语言"
          />
        </Space>

        {error ? <Alert type="warning" showIcon message={error} /> : null}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 20 }}>
            <Spin />
          </div>
        ) : null}

        {preview && !loading ? (
          <>
            <Descriptions
              size="small"
              column={2}
              bordered
              items={[
                { key: 'files', label: '图片', children: `${preview.fileCount} 张` },
                { key: 'markers', label: '标号', children: `${preview.markerStats.total} 条` },
                {
                  key: 'translated',
                  label: '已有译文',
                  children: (
                    <span style={{ color: palette.success }}>
                      {preview.markerStats.translated} 条
                    </span>
                  ),
                },
                {
                  key: 'proofread',
                  label: '已校对',
                  children: `${preview.markerStats.proofread} 条`,
                },
              ]}
            />

            {/* 未翻译的提示放在按钮**上面**：先看到风险，再决定要不要下。
                下载按钮点下去就来不及了。 */}
            {untranslated > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`还有 ${untranslated} 个标号没有译文`}
                description={
                  <>
                    <div style={{ fontSize: 12 }}>
                      txt 里这些位置填的是<Typography.Text strong>原文</Typography.Text>
                      （原文也空的则是空行），所以嵌完会留下一部分没翻的内容。
                    </div>
                    {preview.filesWithoutTranslation.length > 0 ? (
                      <div style={{ fontSize: 12, marginTop: 6 }}>
                        涉及 {preview.filesWithoutTranslation.length} 张图：
                        {preview.filesWithoutTranslation.slice(0, 6).join('、')}
                        {preview.filesWithoutTranslation.length > 6 ? ' 等' : ''}
                      </div>
                    ) : null}
                  </>
                }
              />
            ) : (
              <Alert type="success" showIcon message="全部标号都已有译文，可以放心导出。" />
            )}

            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Button
                block
                icon={<FileTextOutlined />}
                href={exportApi.labelPlusUrl(projectId, targetId!)}
                target="_blank"
              >
                下载 LabelPlus txt（仅译文清单，最小）
              </Button>
              <Button
                block
                type="primary"
                icon={<DownloadOutlined />}
                href={exportApi.projectZipUrl(projectId, targetId!)}
                target="_blank"
              >
                下载工程包（原图 + txt + 结构化清单）
              </Button>
              <Button
                block
                icon={<DownloadOutlined />}
                href={exportApi.outputsZipUrl(projectId, targetId!)}
                target="_blank"
              >
                下载成品包（已回传的成品图）
              </Button>
            </Space>

            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              工程包不附带 PS 脚本 —— 嵌字用的是 LabelPlus 官方的
              <Typography.Text code style={{ fontSize: 12 }}>
                LabelPlus_Ps_Script.jsx
              </Typography.Text>
              ，从 LabelPlus 项目获取后，在 PS 里用「文件 → 脚本 → 浏览」运行即可。
              包内「说明.txt」里有完整的操作步骤与 txt 格式说明。
            </Typography.Paragraph>
          </>
        ) : null}
      </Space>
    </Modal>
  );
}
