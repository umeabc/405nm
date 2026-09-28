import { App as AntApp, Alert, Button, Empty, Image, List, Modal, Popconfirm, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, outputApi, type OutputRow } from '../api/client';
import { formatBytes } from '../utils/time';
import { palette } from '../theme';

/**
 * 嵌字成品：查看已回传的版本、删除某一版、继续回传新版本。
 *
 * **最新版本即当前版本**（表里没有 is_current 列）。所以这里的列表按版本倒序，
 * 第一项就是会被成品包采用的那一版 —— 这一点在界面上要写出来，
 * 否则用户会疑惑「我有三版，发布时用的是哪一版」。
 */

type Props = {
  open: boolean;
  fileId: string | null;
  fileName: string;
  canUpload: boolean;
  onClose: () => void;
  /** 有变化（上传成功 / 删掉一版）就通知外面刷新列表上的成品数 */
  onChanged: () => void;
};

export function OutputModal({ open, fileId, fileName, canUpload, onClose, onChanged }: Props) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<OutputRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!fileId) return;
    setLoading(true);
    try {
      const res = await outputApi.list(fileId);
      setRows(res.outputs);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '读取成品失败');
    } finally {
      setLoading(false);
    }
  }, [fileId, message]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function pickAndUpload(file: File) {
    if (!fileId) return;
    setBusy(true);
    try {
      const res = await outputApi.upload(fileId, file);
      message.success(`已回传第 ${res.output.version} 版成品`);
      await load();
      onChanged();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '回传失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      title={`嵌字成品 —— ${fileName}`}
      destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {canUpload ? (
          <Space size={8}>
            {/* 用原生 input[type=file] 而不是 antd Upload：
                这里只需要「选一个文件然后走我们自己的上传函数」，
                Upload 的受控行为反而要写更多代码去绕开。 */}
            <Button
              type="primary"
              size="small"
              icon={<UploadOutlined />}
              loading={busy}
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = 'image/*';
                input.onchange = () => {
                  const picked = input.files?.[0];
                  if (picked) void pickAndUpload(picked);
                };
                input.click();
              }}
            >
              回传新版本
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              重新嵌字后直接再传一次，会成为新的最新版
            </Typography.Text>
          </Space>
        ) : null}

        {rows.length === 0 && !loading ? (
          <Empty description="还没有回传成品">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              嵌完字把成品图传回来，才能标记为「已嵌字」。
            </Typography.Text>
          </Empty>
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              style={{ fontSize: 12 }}
              message="导出成品包时，每张图取的是版本号最大的那一版。"
            />
            <List
              size="small"
              loading={loading}
              dataSource={rows}
              renderItem={(row, index) => (
                <List.Item
                  key={row.id}
                  actions={
                    canUpload
                      ? [
                          <Popconfirm
                            key="del"
                            title={`删除第 ${row.version} 版成品？`}
                            description="图片文件也会一并删除，无法恢复。"
                            okText="删除"
                            okButtonProps={{ danger: true }}
                            cancelText="取消"
                            onConfirm={() =>
                              void outputApi
                                .remove(fileId!, row.id)
                                .then(async () => {
                                  message.success('已删除');
                                  await load();
                                  onChanged();
                                })
                                .catch((err) =>
                                  message.error(err instanceof ApiError ? err.message : '删除失败'),
                                )
                            }
                          >
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                          </Popconfirm>,
                        ]
                      : undefined
                  }
                >
                  <List.Item.Meta
                    avatar={
                      <Image
                        src={outputApi.mediaUrl(fileId!, row.id, 'thumb')}
                        width={40}
                        height={56}
                        style={{ objectFit: 'cover', borderRadius: 4 }}
                        preview={{ src: outputApi.mediaUrl(fileId!, row.id, 'preview') }}
                        alt=""
                      />
                    }
                    title={
                      <Space size={6} wrap>
                        <Typography.Text style={{ fontSize: 13 }}>第 {row.version} 版</Typography.Text>
                        {index === 0 ? <Tag color={palette.primary}>最新</Tag> : null}
                        {row.language ? <Tag>{row.language}</Tag> : null}
                      </Space>
                    }
                    description={
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {row.width}×{row.height} · {formatBytes(row.size)}
                        {row.createdByName ? ` · ${row.createdByName}` : ''}
                        {row.note ? ` · ${row.note}` : ''}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
          </>
        )}
      </Space>
    </Modal>
  );
}
