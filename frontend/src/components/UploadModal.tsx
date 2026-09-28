import { CheckCircleFilled, CloseCircleFilled, MinusCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Modal, Progress, Space, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, fileApi, type UploadResult } from '../api/client';
import { comiku } from '../theme';

/**
 * 图片上传弹窗。
 *
 * 三条设计决定，都是踩过坑之后定的：
 *
 * 1. **逐张串行上传**，不是一个请求打包多张。理由有两条：`fetch` 拿不到上传进度、
 *    要显示每张的进度只能用 XHR；而后端也就能给每张图单独返回结果
 *    （成功 / 重复 / 失败+原因），失败的可以单独重试。
 * 2. **本地先预检**，明显不合格的文件（非图片、超限）根本不发请求。
 *    传一个 200MB 的文件上去再被服务端拒绝，白等几分钟。
 * 3. **全部成功才自动关闭，且有失败就一定留着**。全成功时停 0.5 秒再关，
 *    是为了让人来得及看到「都成功了」；有失败还自动关，用户就不知道哪张没上去。
 */

type RowStatus = 'waiting' | 'uploading' | 'done' | 'failed' | 'skipped' | 'duplicate';

type Row = {
  key: string;
  file: File;
  status: RowStatus;
  percent: number;
  message: string;
};

export type UploadModalProps = {
  projectId: string | null;
  files: File[];
  maxImageMb: number;
  onClose: () => void;
  /** 上传结束（含部分失败）时调用，让调用方刷新列表。 */
  onFinished: () => void;
};

function isImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  // 有些系统/浏览器给的 type 是空的，退回按扩展名判断。
  return /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(file.name);
}

export function UploadModal({ projectId, files, maxImageMb, onClose, onFinished }: UploadModalProps) {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // 模块级「正在上传」标志位不能只靠 DOM 判断：弹窗关闭有淡出动画，
  // 那段时间里 DOM 还在，第二次上传会被误判为「正在进行」而被拒。
  const busyRef = useRef(false);

  const buildRows = useCallback(
    (list: File[]): Row[] =>
      list.map((file, index) => {
        const tooBig = file.size > maxImageMb * 1024 * 1024;
        const notImage = !isImage(file);
        return {
          key: `${index}-${file.name}-${file.size}`,
          file,
          status: notImage ? 'skipped' : tooBig ? 'failed' : 'waiting',
          percent: 0,
          message: notImage
            ? '非图片，跳过'
            : tooBig
              ? `超过 ${maxImageMb}MB`
              : '',
        };
      }),
    [maxImageMb],
  );

  useEffect(() => {
    const next = buildRows(files);
    setRows(next);
    setFinished(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, buildRows]);

  const uploadOne = useCallback(
    async (row: Row): Promise<void> => {
      if (!projectId) return;

      setRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, status: 'uploading', percent: 0, message: '' } : r)),
      );

      try {
        const controller = new AbortController();
        abortRef.current = controller;

        const result: UploadResult = await fileApi.upload(
          projectId,
          row.file,
          (loaded, total) => {
            const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
            setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, percent } : r)));
          },
          controller.signal,
        );

        const dup = result.duplicates[0];
        const fail = result.failures[0];

        setRows((prev) =>
          prev.map((r) => {
            if (r.key !== row.key) return r;
            if (dup) {
              return { ...r, status: 'duplicate', percent: 100, message: `内容重复，与「${dup.existingName}」相同` };
            }
            if (fail) return { ...r, status: 'failed', percent: 0, message: fail.reason };
            return { ...r, status: 'done', percent: 100, message: '' };
          }),
        );
      } catch (err) {
        setRows((prev) =>
          prev.map((r) =>
            r.key === row.key
              ? {
                  ...r,
                  status: 'failed',
                  percent: 0,
                  message: err instanceof ApiError ? err.message : '上传失败',
                }
              : r,
          ),
        );
      }
    },
    [projectId],
  );

  const runQueue = useCallback(
    async (queue: File[]) => {
      if (busyRef.current) {
        message.warning('上传正在进行中');
        return;
      }
      busyRef.current = true;
      setRunning(true);
      setFinished(false);

      const current = buildRows(queue);
      setRows(current);

      const pending = current.filter((r) => r.status === 'waiting');

      // 串行。串行不是为了省事 —— 图片解码在服务端是内存大户，
      // 并发上传几张就可能把容器打爆（见后端 lib/image.ts 的说明）。
      for (const row of pending) {
        await uploadOne(row);
      }

      busyRef.current = false;
      setRunning(false);
      setFinished(true);
      onFinished();
    },
    [buildRows, message, onFinished, uploadOne],
  );

  // 打开即开跑：调用方只需要「把文件丢进来」，不必自己管启动时机。
  useEffect(() => {
    if (projectId && files.length > 0) void runQueue(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, files]);

  const doneCount = rows.filter((r) => r.status === 'done').length;
  const failedRows = rows.filter((r) => r.status === 'failed');
  const skippedCount = rows.filter((r) => r.status === 'skipped').length;
  const duplicateCount = rows.filter((r) => r.status === 'duplicate').length;

  // 全部成功（没有失败项）时自动关闭；有失败就一直留着让用户处理。
  useEffect(() => {
    if (!finished || failedRows.length > 0) return;
    const timer = window.setTimeout(() => onClose(), 500);
    return () => window.clearTimeout(timer);
  }, [finished, failedRows.length, onClose]);

  return (
    <Modal
      open={projectId !== null && files.length > 0}
      title={`上传图片（${rows.filter((r) => r.status !== 'skipped').length} 张）`}
      onCancel={() => {
        if (running) {
          abortRef.current?.abort();
          busyRef.current = false;
          setRunning(false);
        }
        onClose();
      }}
      footer={
        <Space>
          {failedRows.length > 0 ? (
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={running}
              onClick={() => void runQueue(failedRows.map((r) => r.file))}
            >
              重试失败项（{failedRows.length}）
            </Button>
          ) : null}
          <Button onClick={onClose} disabled={running}>
            {running ? '上传中…' : '关闭'}
          </Button>
        </Space>
      }
      width={560}
      maskClosable={!running}
    >
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        已完成 {doneCount} / {rows.length}
        {duplicateCount > 0 ? ` · 重复 ${duplicateCount}` : ''}
        {failedRows.length > 0 ? ` · 失败 ${failedRows.length}` : ''}
        {skippedCount > 0 ? ` · 跳过 ${skippedCount}` : ''}
      </Typography.Text>

      <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
        {rows.map((row) => (
          <div key={row.key} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {row.status === 'done' ? <CheckCircleFilled style={{ color: comiku.success }} /> : null}
              {row.status === 'failed' ? <CloseCircleFilled style={{ color: comiku.danger }} /> : null}
              {row.status === 'skipped' || row.status === 'duplicate' ? (
                <MinusCircleFilled style={{ color: comiku.inkSoft }} />
              ) : null}
              <Typography.Text
                ellipsis
                style={{ fontSize: 13, flex: 1 }}
                type={row.status === 'failed' ? 'danger' : undefined}
              >
                {row.file.name}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {row.message || `${(row.file.size / 1024 / 1024).toFixed(1)}MB`}
              </Typography.Text>
            </div>

            {row.status === 'uploading' || row.status === 'done' ? (
              <Progress
                percent={row.percent}
                size="small"
                showInfo={false}
                strokeColor={row.status === 'done' ? comiku.success : comiku.primary}
                style={{ marginBottom: 0 }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </Modal>
  );
}
