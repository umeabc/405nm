import { App as AntApp, Alert, Button, Input, Modal, Progress, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, importApi, type ImportTaskRow } from '../api/client';
import { palette } from '../theme';

/**
 * 从链接导入图源。
 *
 * 交互上有三个刻意的选择：
 *
 *  1. **一次可以粘多条链接，每条一个任务**。合成一个任务的话，其中一条链接
 *     挂了会把整批拖住，而且「重试」只能整批重来。
 *  2. **关掉弹窗不中断导入**。抓取在 worker 里跑，跟这个弹窗在不在没有关系 ——
 *     所以文案要说清楚「可以关掉」，否则用户会守着一个几百张的进度条发呆。
 *  3. **轮询用批量接口**。粘十条链接就是十个任务，逐个查等于每轮十个请求。
 *
 * 另外：`notes` 必须显示出来。解析阶段会截断（「该画师共 800 个作品，
 * 本次只取最早的 50 个」），不显示就等于悄悄少导了。
 */

const POLL_MS = 1500;

type Props = {
  open: boolean;
  projectId: string;
  onClose: () => void;
  /** 有图导进来了就通知外面刷新文件列表 */
  onImported: () => void;
};

const STATUS_META: Record<string, { text: string; color?: string }> = {
  pending: { text: '排队中' },
  running: { text: '导入中', color: palette.primary },
  done: { text: '已完成', color: palette.success },
  failed: { text: '失败', color: palette.danger },
};

export function ImportModal({ open, projectId, onClose, onImported }: Props) {
  const { message } = AntApp.useApp();
  const [text, setText] = useState('');
  const [tasks, setTasks] = useState<ImportTaskRow[]>([]);
  const [starting, setStarting] = useState(false);
  const [sourceHint, setSourceHint] = useState<string[]>([]);

  /** 轮询到的任务 id。用 ref 是因为定时器闭包拿不到最新的 state。 */
  const idsRef = useRef<string[]>([]);
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    void importApi
      .sources()
      .then((res) => setSourceHint(res.sources.map((s) => s.label)))
      .catch(() => setSourceHint([]));

    // 打开时先把已有的历史拉一次 —— 上次关掉弹窗之后进来的图，进度在这里。
    void importApi
      .listOfProject(projectId)
      .then((res) => {
        const active = res.tasks.filter((t) => t.status === 'pending' || t.status === 'running');
        setTasks(res.tasks.slice(0, 12));
        idsRef.current = active.map((t) => t.id);
      })
      .catch(() => undefined);
  }, [open, projectId]);

  const poll = useCallback(async () => {
    const ids = idsRef.current;
    if (ids.length === 0) return;
    try {
      const res = await importApi.poll(ids);
      const byId = new Map(res.tasks.map((t) => [t.id, t]));
      setTasks((prev) => prev.map((t) => byId.get(t.id) ?? t));
      // 还活跃的继续轮询，跑完的摘掉
      idsRef.current = res.tasks.filter((t) => t.status === 'pending' || t.status === 'running').map((t) => t.id);

      const finishedNow = res.tasks.some((t) => t.status === 'done' && t.imported > 0);
      if (finishedNow && !notifiedRef.current) {
        notifiedRef.current = true;
        onImported();
      }
      if (idsRef.current.length === 0) notifiedRef.current = false;
    } catch {
      // 轮询失败不打扰用户：下一轮会重试。真正的错误在任务的 errorMessage 里。
    }
  }, [onImported]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, poll]);

  async function start() {
    const urls = text
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter((u) => u !== '');
    if (urls.length === 0) {
      message.warning('先粘至少一条链接');
      return;
    }

    setStarting(true);
    try {
      const res = await importApi.create(projectId, urls);
      setTasks((prev) => [...res.tasks, ...prev].slice(0, 12));
      idsRef.current = [
        ...idsRef.current,
        ...res.tasks.filter((t) => t.status === 'pending').map((t) => t.id),
      ];
      setText('');
      const rejected = res.tasks.filter((t) => t.status === 'failed');
      if (rejected.length > 0) {
        message.warning(`${rejected.length} 条链接认不出来，已标在列表里`);
      } else {
        message.success('已提交，正在后台导入');
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '提交失败');
    } finally {
      setStarting(false);
    }
  }

  async function retry(taskId: string) {
    try {
      const res = await importApi.retry(taskId);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? res.task : t)));
      if (!idsRef.current.includes(taskId)) idsRef.current = [...idsRef.current, taskId];
      message.success('已重新排队');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '重试失败');
    }
  }

  const active = tasks.filter((t) => t.status === 'pending' || t.status === 'running');

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="从链接导入"
      width={640}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button type="primary" loading={starting} onClick={() => void start()}>
            开始导入
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Input.TextArea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'每行粘一条链接，也可以一次粘多条。\n例如：\nhttps://www.pixiv.net/artworks/123456\nhttps://x.com/someone/status/1234567890'}
        />

        {sourceHint.length > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            支持：{sourceHint.join('、')}
          </Typography.Text>
        ) : null}

        <Alert
          type="info"
          showIcon
          message="导入在后台跑，可以关掉这个窗口"
          description="关掉之后导入不会停；再打开这里就能看到进度。跑完的图会直接出现在下面的文件列表里。"
        />

        {active.length > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            有 {active.length} 条链接正在导入……
          </Typography.Text>
        ) : null}

        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onRetry={() => void retry(task.id)} />
        ))}
      </Space>
    </Modal>
  );
}

function TaskCard({ task, onRetry }: { task: ImportTaskRow; onRetry: () => void }) {
  const meta = STATUS_META[task.status] ?? { text: task.status };
  const percent = task.total > 0 ? Math.round((task.done / task.total) * 100) : 0;

  // 链接太长时中间省略：结尾的 id 才是能区分两个链接的部分。
  const shortUrl = task.inputUrl.length > 64
    ? `${task.inputUrl.slice(0, 34)}…${task.inputUrl.slice(-26)}`
    : task.inputUrl;

  return (
    <div style={{ border: `1px solid ${palette.border}`, borderRadius: 8, padding: '10px 12px' }}>
      <Space size={6} style={{ marginBottom: 6 }} wrap>
        <Tag color={meta.color} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {meta.text}
        </Tag>
        {task.total > 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {task.total} 张 · 成功 {task.imported}
            {task.duplicated > 0 ? ` · 重复 ${task.duplicated}` : ''}
            {task.failed > 0 ? ` · 失败 ${task.failed}` : ''}
          </Typography.Text>
        ) : null}
        {task.status === 'failed' || task.failed > 0 ? (
          <Button size="small" type="link" style={{ padding: 0 }} onClick={onRetry}>
            重试失败项
          </Button>
        ) : null}
      </Space>

      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', wordBreak: 'break-all' }}>
        {shortUrl}
      </Typography.Text>

      {task.total > 0 && task.status !== 'done' ? (
        <Progress percent={percent} size="small" style={{ marginTop: 6, marginBottom: 0 }} />
      ) : null}

      {task.errorMessage ? (
        <Typography.Text type="danger" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
          {task.errorMessage}
        </Typography.Text>
      ) : null}

      {task.notes.length > 0 ? (
        <div style={{ marginTop: 4 }}>
          {task.notes.slice(0, 3).map((note, i) => (
            <Typography.Text key={i} type="secondary" style={{ fontSize: 11, display: 'block' }}>
              · {note}
            </Typography.Text>
          ))}
        </div>
      ) : null}
    </div>
  );
}
