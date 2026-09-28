import { App as AntApp, Alert, Modal, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError, moveApi } from '../api/client';

/**
 * 把选中的图片移动到同团队的其他作品。
 *
 * 三件事在界面上要**提前**说清楚，而不是等用户按下去才报错：
 *  1. 目标作品缺哪种目标语言 → 移动时会自动补上（译文不会丢）；
 *  2. 目标作品里已有相同内容的图 → 整批会被拒绝，得先去处理；
 *  3. 标号与译文会跟着走 —— 这是用户最关心的「我的工作还在不在」。
 */

export type FileMoveModalProps = {
  open: boolean;
  projectId: string;
  fileIds: string[];
  fileNames: string[];
  onClose: () => void;
  onMoved: () => void;
};

type TargetProject = {
  id: string;
  serial: number;
  name: string;
  targetLanguages: Array<{ language: string; label: string }>;
};

export function FileMoveModal({
  open,
  projectId,
  fileIds,
  fileNames,
  onClose,
  onMoved,
}: FileMoveModalProps) {
  const { message } = AntApp.useApp();
  const [targets, setTargets] = useState<TargetProject[]>([]);
  const [toProjectId, setToProjectId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setToProjectId(null);
    void moveApi
      .targets(projectId)
      .then((res) => setTargets(res.projects as TargetProject[]))
      .catch((err) => setError(err instanceof ApiError ? err.message : '目标作品加载失败'));
  }, [open, projectId]);

  async function submit() {
    if (!toProjectId) return;
    setSubmitting(true);
    setError(null);
    try {
      await moveApi.move(projectId, toProjectId, fileIds);
      message.success(`已移动 ${fileIds.length} 张图片`);
      onMoved();
      onClose();
    } catch (err) {
      // 重复冲突之类的错误信息里带着「是哪几张」，直接显示出来比
      // 翻译成一句笼统的「移动失败」有用得多。
      setError(err instanceof ApiError ? err.message : '移动失败');
    } finally {
      setSubmitting(false);
    }
  }

  const selected = targets.find((t) => t.id === toProjectId);

  return (
    <Modal
      title={`移动 ${fileIds.length} 张图片`}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={submitting}
      okText="移动"
      cancelText="取消"
      okButtonProps={{ disabled: !toProjectId }}
      destroyOnHidden
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          标号与译文会跟着图片一起走：标号原样保留，译文按**同一种目标语言**映射到目标作品。
          目标作品没有那种语言时会自动补上，不会丢译文。
        </Typography.Text>

        <Select
          style={{ width: '100%' }}
          placeholder="选择目标作品"
          value={toProjectId}
          onChange={setToProjectId}
          options={targets.map((t) => ({ value: t.id, label: `#${t.serial} ${t.name}` }))}
          notFoundContent="同团队里没有其他作品可移入"
        />

        {selected ? (
          <Alert
            type="info"
            showIcon
            message="目标作品当前的目标语言"
            description={
              <Space size={4} wrap>
                {selected.targetLanguages.length === 0 ? (
                  <Typography.Text style={{ fontSize: 12 }}>
                    暂无 —— 移动时会按源作品的语言自动补
                  </Typography.Text>
                ) : (
                  selected.targetLanguages.map((l) => (
                    <Tag key={l.language} style={{ marginInlineEnd: 0 }}>
                      {l.label}
                    </Tag>
                  ))
                )}
              </Space>
            }
          />
        ) : null}

        {fileNames.length > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            将移动：{fileNames.slice(0, 6).join('、')}
            {fileNames.length > 6 ? ` 等 ${fileNames.length} 张` : ''}
          </Typography.Text>
        ) : null}

        {error ? <Alert type="error" showIcon message={error} /> : null}
      </Space>
    </Modal>
  );
}
