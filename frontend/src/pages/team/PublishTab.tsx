import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, publishApi, type PublishAccountRow, type PublishJobRow } from '../../api/client';
import { palette } from '../../theme';

/**
 * 团队的发布设置与队列。
 *
 * 放在团队页而不是作品页：**发布账号归团队**（一个团队可以有多个发布号），
 * 队列也是团队级的事实 —— 运营关心的是「这个号接下来要发什么」，
 * 而不是「某个作品发了什么」。
 */

const COOKIE_META: Record<string, { text: string; color: string }> = {
  ok: { text: '正常', color: 'success' },
  expired: { text: '已失效', color: 'error' },
  unknown: { text: '未校验', color: 'default' },
};

const JOB_STATUS: Record<string, { text: string; color: string }> = {
  draft: { text: '草稿', color: 'default' },
  pending: { text: '待发布', color: 'processing' },
  publishing: { text: '发布中', color: 'processing' },
  published: { text: '已发布', color: 'success' },
  failed: { text: '失败', color: 'error' },
  needs_review: { text: '待人工确认', color: 'warning' },
  canceled: { text: '已取消', color: 'default' },
};

type Props = { teamId: string };

export function PublishTab({ teamId }: Props) {
  const { message } = AntApp.useApp();
  const [accounts, setAccounts] = useState<PublishAccountRow[]>([]);
  const [jobs, setJobs] = useState<PublishJobRow[]>([]);
  const [credits, setCredits] = useState<Array<{ id: string; name: string; handle: string; platformUid: string; status: string; mentionable: boolean }>>([]);
  const [loading, setLoading] = useState(false);

  const [adding, setAdding] = useState(false);
  const [cookieFor, setCookieFor] = useState<PublishAccountRow | null>(null);
  const [creditOpen, setCreditOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, j, c] = await Promise.all([
        publishApi.accounts(teamId),
        publishApi.teamJobs(teamId),
        publishApi.credits(teamId),
      ]);
      setAccounts(a.accounts);
      setJobs(j.jobs);
      setCredits(c.entries);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '读取发布设置失败');
    } finally {
      setLoading(false);
    }
  }, [teamId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card
        size="small"
        title="发布账号"
        extra={
          <Space size={6}>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
              添加账号
            </Button>
          </Space>
        }
      >
        {accounts.length === 0 ? (
          <Empty description="还没有发布账号">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              需要 B 站的 SESSDATA 与 bili_jct。
              <Typography.Text strong>添加时会先向 B 站校验，通不过不会存下来</Typography.Text>。
            </Typography.Text>
          </Empty>
        ) : (
          <List
            size="small"
            dataSource={accounts}
            renderItem={(account) => {
              const meta = COOKIE_META[account.cookieStatus] ?? { text: account.cookieStatus, color: 'default' };
              return (
                <List.Item
                  actions={[
                    <Button
                      key="verify"
                      size="small"
                      onClick={() =>
                        void publishApi
                          .verifyAccount(teamId, account.id)
                          .then((res) => {
                            message[res.ok ? 'success' : 'warning'](res.ok ? '凭据可用' : (res.error ?? '凭据不可用'));
                            void load();
                          })
                          .catch((err) => message.error(err instanceof ApiError ? err.message : '校验失败'))
                      }
                    >
                      校验
                    </Button>,
                    <Button key="cookie" size="small" onClick={() => setCookieFor(account)}>
                      改 Cookie
                    </Button>,
                    <Popconfirm
                      key="del"
                      title="删除这个发布账号？"
                      description="有未完成的发布任务用着它时会被拒绝。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() =>
                        void publishApi
                          .removeAccount(teamId, account.id)
                          .then(() => {
                            message.success('已删除');
                            void load();
                          })
                          .catch((err) => message.error(err instanceof ApiError ? err.message : '删除失败'))
                      }
                    >
                      <Button size="small" type="text" danger>
                        删除
                      </Button>
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space size={6} wrap>
                        <Typography.Text style={{ fontSize: 13 }}>{account.label}</Typography.Text>
                        <Tag color={meta.color}>{meta.text}</Tag>
                        {account.platformName ? <Tag>{account.platformName}</Tag> : null}
                        {!account.enabled ? <Tag>已停用</Tag> : null}
                      </Space>
                    }
                    description={
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {account.credentials?.sessdata ? `凭据 ${account.credentials.sessdata}` : '还没有凭据'}
                        {account.cookieCheckedAt ? ` · 上次校验 ${new Date(account.cookieCheckedAt).toLocaleString()}` : ''}
                        {account.cookieMessage ? ` · ${account.cookieMessage}` : ''}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </Card>

      {/* ⚠️ 「待人工确认」单独提出来放最上面：它是**需要人做决定**的状态，
          埋在长列表里会一直没人处理。 */}
      {jobs.some((j) => j.status === 'needs_review') ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${jobs.filter((j) => j.status === 'needs_review').length} 条发布任务需要人工确认`}
          description={
            <>
              系统不确定它们发出去了没有，<Typography.Text strong>不会自动重发</Typography.Text>
              。到对应作品的发布弹窗里处置。
            </>
          }
        />
      ) : null}

      <Card size="small" title="发布队列">
        {jobs.length === 0 ? (
          <Empty description="还没有发布任务" />
        ) : (
          <Table
            size="small"
            rowKey="id"
            loading={loading}
            dataSource={jobs}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={[
              {
                title: '状态',
                dataIndex: 'status',
                width: 110,
                render: (status: string) => {
                  const meta = JOB_STATUS[status] ?? { text: status, color: 'default' };
                  return <Tag color={meta.color}>{meta.text}</Tag>;
                },
              },
              { title: '类型', dataIndex: 'kind', width: 70 },
              {
                title: '标题 / 正文',
                dataIndex: 'text',
                ellipsis: true,
                render: (_: string, row: PublishJobRow) => row.title || row.text.slice(0, 40) || '（无正文）',
              },
              { title: '图片', width: 60, render: (_: unknown, row: PublishJobRow) => `${row.images.length} 张` },
              {
                title: '排期',
                dataIndex: 'scheduledAt',
                width: 160,
                render: (value: string | null) => (value ? new Date(value).toLocaleString() : '-'),
              },
              {
                title: '链接',
                dataIndex: 'externalUrl',
                width: 80,
                render: (url: string) =>
                  url ? (
                    <Typography.Link href={url} target="_blank">
                      查看
                    </Typography.Link>
                  ) : (
                    '-'
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        size="small"
        title="账号库（署名成员）"
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={() => setCreditOpen(true)}>
            添加成员
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          署名片段里的 <Typography.Text code>@handle</Typography.Text> 靠这份名单才能变成
          <Typography.Text strong>可点击的 @</Typography.Text>
          {' '}—— 所以「平台 uid」那一栏要填对方的 B 站 uid，不填的话 @ 只是普通文字。
        </Typography.Paragraph>
        <List
          size="small"
          dataSource={credits}
          renderItem={(entry) => (
            <List.Item>
              <Space size={6} wrap>
                <Typography.Text style={{ fontSize: 13 }}>{entry.name}</Typography.Text>
                <Tag>@{entry.handle}</Tag>
                {entry.mentionable ? (
                  <Tag color={palette.success}>@ 可点击</Tag>
                ) : (
                  <Tag color="default">只当文字</Tag>
                )}
                {entry.status === 'left' ? <Tag>已离岗</Tag> : null}
              </Space>
            </List.Item>
          )}
        />
      </Card>

      <AddAccountModal
        teamId={teamId}
        open={adding}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          void load();
        }}
      />

      <CookieModal
        teamId={teamId}
        account={cookieFor}
        onClose={() => setCookieFor(null)}
        onDone={() => {
          setCookieFor(null);
          void load();
        }}
      />

      <AddCreditModal
        teamId={teamId}
        open={creditOpen}
        onClose={() => setCreditOpen(false)}
        onDone={() => {
          setCreditOpen(false);
          void load();
        }}
      />
    </Space>
  );
}

function AddAccountModal({
  teamId,
  open,
  onClose,
  onDone,
}: {
  teamId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntApp.useApp();
  const [label, setLabel] = useState('');
  const [sessdata, setSessdata] = useState('');
  const [biliJct, setBiliJct] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await publishApi.createAccount(teamId, { platform: 'bilibili', label, sessdata, biliJct });
      if (res.verified) message.success('账号已添加并通过校验');
      // 校验不过也**照样建出来了**（只是标成不可用）—— 如实说，别让人以为存上了
      else message.warning(`账号已创建，但校验没通过：${res.warning ?? '请检查 Cookie'}。它现在不可用。`);
      setLabel('');
      setSessdata('');
      setBiliJct('');
      onDone();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onCancel={onClose} onOk={() => void submit()} confirmLoading={busy} okText="添加并校验" title="添加发布账号" destroyOnHidden>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Input placeholder="账号名（如「主号」）" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} />
        <Input.Password placeholder="SESSDATA" value={sessdata} onChange={(e) => setSessdata(e.target.value)} />
        <Input.Password placeholder="bili_jct" value={biliJct} onChange={(e) => setBiliJct(e.target.value)} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          从浏览器登录 B 站后的 Cookie 里取这两个值。**会先向 B 站校验，通不过不会覆盖已存的凭据**。
        </Typography.Text>
      </Space>
    </Modal>
  );
}

function CookieModal({
  teamId,
  account,
  onClose,
  onDone,
}: {
  teamId: string;
  account: PublishAccountRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntApp.useApp();
  const [sessdata, setSessdata] = useState('');
  const [biliJct, setBiliJct] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!account) return;
    setBusy(true);
    try {
      const res = await publishApi.saveCredentials(teamId, account.id, { sessdata, biliJct });
      message.success(`凭据已更新（${res.profile.name}）`);
      setSessdata('');
      setBiliJct('');
      onDone();
    } catch (err) {
      // 后端会**原样保留旧凭据**，只在错误里说明；这里把这一点讲清楚，
      // 否则用户会担心「我这次填错了，是不是把能用的那个覆盖掉了」
      message.error(
        err instanceof ApiError ? `${err.message}（旧凭据未被覆盖）` : '保存失败',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={account !== null}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={busy}
      okText="校验并保存"
      title={`修改 Cookie —— ${account?.label ?? ''}`}
      destroyOnHidden
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="先校验、通过才覆盖"
          description="填错了不会把正在用的凭据弄坏 —— 校验不通过时旧凭据原样保留。"
        />
        <Input.Password placeholder="SESSDATA" value={sessdata} onChange={(e) => setSessdata(e.target.value)} />
        <Input.Password placeholder="bili_jct" value={biliJct} onChange={(e) => setBiliJct(e.target.value)} />
      </Space>
    </Modal>
  );
}

function AddCreditModal({
  teamId,
  open,
  onClose,
  onDone,
}: {
  teamId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = AntApp.useApp();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [platformUid, setPlatformUid] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await publishApi.createCredit(teamId, { name, handle, platformUid });
      message.success('已添加');
      setName('');
      setHandle('');
      setPlatformUid('');
      onDone();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onCancel={onClose} onOk={() => void submit()} confirmLoading={busy} okText="添加" title="添加署名成员" destroyOnHidden>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Input placeholder="显示名（如「翻译小王」）" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <Input placeholder="@ 用的 handle（不含 @）" value={handle} onChange={(e) => setHandle(e.target.value)} maxLength={60} />
        <Input
          placeholder="B 站 uid（不填的话 @ 只是普通文字）"
          value={platformUid}
          onChange={(e) => setPlatformUid(e.target.value)}
          maxLength={40}
        />
      </Space>
    </Modal>
  );
}
