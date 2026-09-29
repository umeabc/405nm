import { Alert, App as AntApp, Button, DatePicker, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, publishApi, type PublishJobRow, type PublishPrepare } from '../api/client';
import { palette } from '../theme';

/**
 * 生成发布草稿 + 这个作品的发布任务列表。
 *
 * 交互上两处刻意的选择：
 *  1. **草稿与队列放在同一个弹窗里**。生成完草稿紧接着就是「什么时候发」，
 *     分成两个页面会让人来回跳。
 *  2. **「还没到已嵌字」的图数摆在最上面**。状态机要求作品内全部文件
 *     ≥ typeset 才算可发布，不先讲清楚，用户会对着禁用的按钮发懵。
 */

type Props = {
  open: boolean;
  projectId: string;
  onClose: () => void;
};

const STATUS_META: Record<string, { text: string; color: string }> = {
  draft: { text: '草稿', color: 'default' },
  pending: { text: '待发布', color: 'processing' },
  publishing: { text: '发布中', color: 'processing' },
  published: { text: '已发布', color: 'success' },
  failed: { text: '失败', color: 'error' },
  needs_review: { text: '待人工确认', color: 'warning' },
  canceled: { text: '已取消', color: 'default' },
};

export function PublishModal({ open, projectId, onClose }: Props) {
  const { message } = AntApp.useApp();
  const [prepare, setPrepare] = useState<PublishPrepare | null>(null);
  const [jobs, setJobs] = useState<PublishJobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const [kind, setKind] = useState('原创');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [accountId, setAccountId] = useState<string | undefined>();
  const [templateId, setTemplateId] = useState<string | undefined>();
  const [variables, setVariables] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, j] = await Promise.all([publishApi.prepare(projectId, kind), publishApi.projectJobs(projectId)]);
      setPrepare(p);
      setJobs(j.jobs);
      setAccountId((prev) => prev ?? p.accounts[0]?.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取发布素材失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, kind]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function create() {
    setCreating(true);
    try {
      const res = await publishApi.createDraft(projectId, {
        kind,
        title,
        text,
        accountId,
        templateId,
        variables,
        slots: prepare?.slots ?? {},
      });
      message.success(res.reused ? '这条草稿已经生成过了' : '草稿已生成，下面可以排期了');
      setText('');
      setTitle('');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '生成草稿失败');
    } finally {
      setCreating(false);
    }
  }

  async function schedule(job: PublishJobRow, at: string | null) {
    try {
      await publishApi.schedule(job.id, at);
      message.success(at ? '已排期' : '已加入队列，马上会发');
      await load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '排期失败');
    }
  }

  const blocked = prepare ? !prepare.canPublish : true;
  const template = prepare?.templates.find((t) => t.id === templateId);

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={640} title="发布到 B 站" destroyOnHidden>
      {loading && !prepare ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : null}

      {error ? <Alert type="warning" showIcon message={error} style={{ marginBottom: 12 }} /> : null}

      {prepare ? (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {/* 门槛摆在最上面：说不清楚的话，用户只会对着禁用的按钮发懵 */}
          {blocked ? (
            <Alert
              type="warning"
              showIcon
              message="还不能发布"
              description={
                prepare.filesTotal === 0
                  ? '这个作品还没有图片。'
                  : `作品内还有 ${prepare.filesNotReady} 张图没到「已嵌字」，全部完成之后才能发布。`
              }
            />
          ) : null}

          {prepare.accounts.length === 0 ? (
            <Alert
              type="info"
              showIcon
              message="团队还没有配发布账号"
              description="到「团队 → 发布」里添加一个 B 站账号（需要 SESSDATA 与 bili_jct），之后才能安排发布。"
            />
          ) : null}

          <Space size={8} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={kind}
              onChange={setKind}
              options={prepare.kinds.map((k) => ({ value: k, label: k }))}
            />
            <Select
              size="small"
              style={{ width: 200 }}
              placeholder="选择模板（可不用）"
              value={templateId}
              onChange={setTemplateId}
              allowClear
              options={prepare.templates.map((t) => ({ value: t.id, label: t.name }))}
            />
            <Select
              size="small"
              style={{ width: 180 }}
              placeholder="发布账号"
              value={accountId}
              onChange={setAccountId}
              options={prepare.accounts.map((a) => ({
                value: a.id,
                label: `${a.label}${a.platformName ? `（${a.platformName}）` : ''}`,
              }))}
            />
          </Space>

          <Input size="small" placeholder="标题（可空）" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />

          {/* 用模板时只填模板声明的变量，不让用户去猜 {{}} 怎么写 */}
          {template
            ? template.variables.map((v) => (
                <Input
                  key={v.key}
                  size="small"
                  placeholder={`${v.label}${v.placeholder ? ` —— ${v.placeholder}` : ''}`}
                  value={variables[v.key] ?? ''}
                  onChange={(e) => setVariables({ ...variables, [v.key]: e.target.value })}
                />
              ))
            : null}

          {!template ? (
            <Input.TextArea
              rows={4}
              placeholder="正文（署名行会在发布时自动追加）"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={4000}
            />
          ) : null}

          <Space size={8} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              会带上 {prepare.languages[0]?.count ?? 0} 张该语言的成品图
            </Typography.Text>
            {Object.entries(prepare.slots).map(([key, slot]) =>
              slot ? (
                <Tag key={key}>
                  {prepare.slotLabels[key] ?? key}：{slot.handle ? `@${slot.handle}` : slot.name}
                  {slot.uid ? '' : '（@ 不可点击）'}
                </Tag>
              ) : null,
            )}
          </Space>

          <Button
            type="primary"
            size="small"
            icon={<SendOutlined />}
            loading={creating}
            disabled={blocked || prepare.accounts.length === 0}
            onClick={() => void create()}
          >
            生成草稿
          </Button>

          {jobs.length > 0 ? (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                这个作品的发布任务
              </Typography.Text>
              <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 6 }}>
                {jobs.map((job) => (
                  <JobRow key={job.id} job={job} onSchedule={schedule} onChanged={() => void load()} />
                ))}
              </Space>
            </div>
          ) : null}
        </Space>
      ) : null}
    </Modal>
  );
}

function JobRow({
  job,
  onSchedule,
  onChanged,
}: {
  job: PublishJobRow;
  onSchedule: (job: PublishJobRow, at: string | null) => Promise<void>;
  onChanged: () => void;
}) {
  const { message } = AntApp.useApp();
  const meta = STATUS_META[job.status] ?? { text: job.status, color: 'default' };

  async function cancel() {
    try {
      await publishApi.cancel(job.id);
      message.success('已取消');
      onChanged();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '取消失败');
    }
  }

  async function resolve(outcome: 'confirmed' | 'notPublished') {
    try {
      await publishApi.resolve(job.id, outcome, '');
      message.success(outcome === 'confirmed' ? '已标记为发布成功' : '已重新排队');
      onChanged();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '处理失败');
    }
  }

  return (
    <div style={{ border: `1px solid ${palette.border}`, borderRadius: 6, padding: '8px 10px' }}>
      <Space size={6} wrap>
        <Tag color={meta.color}>{meta.text}</Tag>
        <Typography.Text style={{ fontSize: 12 }}>{job.kind}</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          {job.images.length} 张图
          {job.scheduledAt ? ` · 排期 ${new Date(job.scheduledAt).toLocaleString()}` : ''}
        </Typography.Text>
      </Space>

      {/* ⚠️ 「待人工确认」要显眼，且把两个选项的后果写清楚 ——
          它是「我们不确定发出去没有」的状态，随手点会造成重复动态。 */}
      {job.status === 'needs_review' ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 6 }}
          message="不确定这条发出去了没有"
          description={
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Typography.Text style={{ fontSize: 12 }}>
                上一次发布请求发出后进程中断了。
                <Typography.Text strong>系统不会自动重发</Typography.Text>
                {' '}—— 请先到 B 站主页确认，再选下面一项。
              </Typography.Text>
              <Space size={6}>
                <Button size="small" onClick={() => void resolve('confirmed')}>
                  已发出去了（收尾）
                </Button>
                <Button size="small" danger onClick={() => void resolve('notPublished')}>
                  确实没发出去（重发）
                </Button>
              </Space>
            </Space>
          }
        />
      ) : null}

      {job.lastError && job.status !== 'needs_review' ? (
        <Typography.Text type={job.status === 'failed' ? 'danger' : 'secondary'} style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
          {job.lastError}
        </Typography.Text>
      ) : null}

      <Space size={6} style={{ marginTop: 6 }} wrap>
        {job.status === 'draft' ? (
          <>
            <Button size="small" type="primary" onClick={() => void onSchedule(job, null)}>
              立即发布
            </Button>
            <DatePicker
              size="small"
              showTime
              placeholder="选个时间"
              onChange={(value) => {
                if (value) void onSchedule(job, value.toDate().toISOString());
              }}
            />
          </>
        ) : null}

        {['draft', 'pending', 'failed'].includes(job.status) ? (
          <Button size="small" onClick={() => void cancel()}>
            取消
          </Button>
        ) : null}

        {job.externalUrl ? (
          <Typography.Link href={job.externalUrl} target="_blank" style={{ fontSize: 12 }}>
            查看动态
          </Typography.Link>
        ) : null}
      </Space>
    </div>
  );
}
