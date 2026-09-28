import {
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, adminApi, type NoticeRow, type PublicUser } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/AppShell';
import { invalidateBranding, useBranding } from '../hooks/useBranding';
import { palette } from '../theme';

const STATUS_LABEL: Record<string, { text: string; color: string }> = {
  active: { text: '正常', color: 'green' },
  disabled: { text: '已停用', color: 'orange' },
  deactivated: { text: '已注销', color: 'default' },
};

const SITE_SETTING_FIELDS: Array<{ key: string; label: string; placeholder?: string }> = [
  { key: 'site.name', label: '站点名称', placeholder: '405nm' },
  { key: 'site.englishName', label: '英文名', placeholder: '405nm' },
  { key: 'site.slogan', label: '标语', placeholder: '把喜欢的故事，分享给更多人' },
  { key: 'site.description', label: '站点描述' },
  { key: 'site.footer', label: '页脚文案' },
];

export default function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('users');

  // 后端会对每个接口再校验一次；这里只是不给无用入口。
  if (!user?.isSiteAdmin) {
    return (
      <Card>
        <Typography.Text type="secondary">该页面仅站点管理员可见。</Typography.Text>
      </Card>
    );
  }

  return (
    <>
      <PageHeader title="站点后台" description="全站用户、团队、站点设置与公告。" />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: 'users', label: '用户', children: <UsersTab /> },
          { key: 'teams', label: '团队概览', children: <TeamsTab /> },
          { key: 'settings', label: '站点设置', children: <SettingsTab /> },
          { key: 'notices', label: '公告', children: <NoticesTab /> },
        ]}
      />
    </>
  );
}

// ── 用户 ────────────────────────────────────────────────────

function UsersTab() {
  const { user: me } = useAuth();
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ username: string; password: string; displayName?: string; isSiteAdmin: boolean }>();

  const load = useCallback(async (q?: string) => {
    setLoading(true);
    try {
      const res = await adminApi.users({ q: q || undefined, pageSize: 100 });
      setRows(res.users);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createUser(values: { username: string; password: string; displayName?: string; isSiteAdmin: boolean }) {
    setSubmitting(true);
    try {
      await adminApi.createUser(values);
      message.success('用户已创建');
      setCreating(false);
      form.resetFields();
      void load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function wrap(action: () => Promise<unknown>, ok: string, reload = true) {
    try {
      await action();
      message.success(ok);
      if (reload) void load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    }
  }

  const columns: ColumnsType<PublicUser> = [
    {
      title: '用户',
      key: 'user',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text>{row.displayName}</Typography.Text>
            {row.isSiteAdmin ? <Tag color={palette.primary}>站点管理员</Tag> : null}
            {row.id === me?.id ? <Tag>我</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            @{row.username}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: string) => {
        const meta = STATUS_LABEL[status] ?? { text: status, color: 'default' };
        return <Tag color={meta.color}>{meta.text}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 340,
      render: (_, row) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            // 不能收回自己的管理员权限 —— 后端会拦（CANNOT_DEMOTE_SELF），
            // 这里提前禁用，别给一个点了必定报错的按钮。
            disabled={row.id === me?.id && row.isSiteAdmin}
            onClick={() =>
              void wrap(() => adminApi.setSiteAdmin(row.id, !row.isSiteAdmin), row.isSiteAdmin ? '已收回管理员' : '已设为管理员')
            }
          >
            {row.isSiteAdmin ? '收回管理员' : '设为管理员'}
          </Button>

          {row.status === 'disabled' ? (
            <Button size="small" type="link" onClick={() => void wrap(() => adminApi.updateUser(row.id, { status: 'active' }), '已启用')}>
              启用
            </Button>
          ) : (
            <Button
              size="small"
              type="link"
              disabled={row.id === me?.id}
              onClick={() => void wrap(() => adminApi.updateUser(row.id, { status: 'disabled' }), '已停用')}
            >
              停用
            </Button>
          )}

          <Popconfirm
            title="重置该用户的密码？"
            description="系统会生成随机密码并只显示一次，对方所有登录会立即失效。"
            okText="重置"
            cancelText="取消"
            onConfirm={() =>
              void wrap(async () => {
                const res = await adminApi.resetPassword(row.id);
                if (res.generatedPassword) {
                  Modal.info({
                    title: '新的随机密码（只显示这一次）',
                    content: (
                      <Space direction="vertical">
                        <Typography.Text code copyable style={{ fontSize: 15 }}>
                          {res.generatedPassword}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          请立即转告该用户。
                        </Typography.Text>
                      </Space>
                    ),
                  });
                }
              }, '密码已重置', false)
            }
          >
            <Button size="small" type="link">
              重置密码
            </Button>
          </Popconfirm>

          <Popconfirm
            title="注销该用户？"
            description="会抹去其用户名与昵称、退出所有团队并停用账号。已有的翻译与标号记录会保留但显示为 [Redacted]。"
            okText="确认注销"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void wrap(() => adminApi.deactivateUser(row.id), '已注销')}
          >
            <Button size="small" type="link" danger disabled={row.id === me?.id || row.status === 'deactivated'}>
              注销
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="全站用户"
      extra={
        <Space>
          <Input.Search
            allowClear
            placeholder="搜索用户名或昵称"
            style={{ width: 220 }}
            onSearch={(value) => {
              setKeyword(value);
              void load(value);
            }}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load(keyword)} />
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setCreating(true)}>
            创建用户
          </Button>
        </Space>
      }
    >
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={false} size="small" />

      <Modal
        title="创建用户"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={createUser} requiredMark={false} initialValues={{ isSiteAdmin: false }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="3 ~ 32 个字符，可含中文" />
          </Form.Item>
          <Form.Item name="displayName" label="昵称（可选）">
            <Input placeholder="留空则与用户名相同" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[{ required: true, message: '请输入密码' }, { min: 8, message: '密码长度需为 8 ~ 128 个字符' }]}
          >
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Form.Item name="isSiteAdmin" label="设为站点管理员" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ── 团队概览 ────────────────────────────────────────────────

function TeamsTab() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<Array<{ id: string; name: string; intro: string; status: string; memberCount: number; createdAt: string }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi
      .teams()
      .then((res) => setRows(res.teams))
      .catch((err) => message.error(err instanceof ApiError ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [message]);

  const columns: ColumnsType<(typeof rows)[number]> = [
    { title: '团队', dataIndex: 'name' },
    {
      title: '简介',
      dataIndex: 'intro',
      render: (intro: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {intro || '—'}
        </Typography.Text>
      ),
    },
    { title: '成员数', dataIndex: 'memberCount', width: 90 },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {new Date(value).toLocaleString()}
        </Typography.Text>
      ),
    },
  ];

  return (
    <Card title="全部团队">
      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={false} size="small" />
    </Card>
  );
}

// ── 站点设置 ────────────────────────────────────────────────

function SettingsTab() {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<Record<string, string>>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminApi
      .settings()
      .then((res) => {
        form.setFieldsValue(
          Object.fromEntries(
            SITE_SETTING_FIELDS.map((f) => [f.key, (res.settings[f.key] as string | null) ?? '']),
          ),
        );
      })
      .catch((err) => message.error(err instanceof ApiError ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [form, message]);

  async function save(values: Record<string, string>) {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const field of SITE_SETTING_FIELDS) {
        const value = values[field.key];
        if (value !== undefined) patch[field.key] = value;
      }
      const res = await adminApi.saveSettings(patch);
      // 站名与标语也出现在顶栏和登录页上，改完立刻广播，否则要刷新才看得到。
      invalidateBranding(res.branding);
      message.success('已保存');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title="站点设置" loading={loading}>
      <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
        <Row gutter={16}>
          {SITE_SETTING_FIELDS.map((field) => (
            <Col xs={24} md={12} key={field.key}>
              <Form.Item name={field.key} label={field.label} extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{field.key}</Typography.Text>}>
                <Input placeholder={field.placeholder} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        <Button type="primary" htmlType="submit" loading={saving}>
          保存
        </Button>
      </Form>

      <MascotCard />
    </Card>
  );
}

/**
 * 站点立绘。
 *
 * **独立成一张卡、选中即上传**，不并进上面那个表单：上面是一组文本框、按「保存」提交，
 * 立绘是一张图、选完就该立刻生效。放进同一个表单会让人以为它也要点保存才生效，
 * 表现是「传了图、没点保存、以为坏了」。
 */
function MascotCard() {
  const { message } = AntApp.useApp();
  const branding = useBranding();
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setPercent(0);
    try {
      const res = await adminApi.uploadMascot(file, (loaded, total) => {
        setPercent(total > 0 ? Math.round((loaded / total) * 100) : 0);
      });
      invalidateBranding(res.branding);
      message.success('立绘已更新');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '上传失败');
    } finally {
      setBusy(false);
      setPercent(null);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const res = await adminApi.clearMascot();
      invalidateBranding(res.branding);
      message.success('已清除立绘');
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '清除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 20, paddingTop: 20, borderTop: `1px solid ${palette.border}` }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        站点立绘
      </Typography.Title>

      <Space align="start" size={20} wrap>
        <div
          style={{
            width: 140,
            height: 180,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 10,
            border: `1px dashed ${palette.borderStrong}`,
            background: palette.paper,
            overflow: 'hidden',
          }}
        >
          {branding.mascotUrl ? (
            <img
              src={branding.mascotUrl}
              alt="站点立绘"
              style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
            />
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              未设置
            </Typography.Text>
          )}
        </div>

        <Space direction="vertical" size={8} style={{ maxWidth: 340 }}>
          <Upload
            accept="image/png,image/jpeg,image/webp,image/gif"
            showUploadList={false}
            // 返回 false 拦住 antd 自己的上传：我们要用带进度的通道，
            // 而且失败时要拿到 ApiError 的中文提示，不是 antd 的通用文案。
            beforeUpload={(file) => {
              void upload(file as unknown as File);
              return false;
            }}
          >
            <Button icon={<UploadOutlined />} loading={busy} disabled={busy}>
              {branding.hasMascot ? '更换立绘' : '上传立绘'}
            </Button>
          </Upload>

          {percent !== null ? <Progress percent={percent} size="small" /> : null}

          <Button danger size="small" disabled={busy || !branding.hasMascot} onClick={clear}>
            清除立绘
          </Button>

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            显示在登录页左侧。建议用透明底 PNG，高度 400–800px；<br />
            尺寸不匹配也不会拉伸，按原比例内接显示。
          </Typography.Text>
        </Space>
      </Space>
    </div>
  );
}

// ── 公告 ────────────────────────────────────────────────────

function NoticesTab() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<NoticeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<NoticeRow | 'new' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ title?: string; content: string; enabled: boolean }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.notices();
      setRows(res.notices);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(values: { title?: string; content: string; enabled: boolean }) {
    setSubmitting(true);
    try {
      if (editing === 'new') {
        await adminApi.createNotice(values);
        message.success('公告已发布');
      } else if (editing) {
        await adminApi.updateNotice(editing.id, values);
        message.success('公告已更新');
      }
      setEditing(null);
      form.resetFields();
      void load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  const columns: ColumnsType<NoticeRow> = [
    {
      title: '标题',
      dataIndex: 'title',
      render: (title: string, row) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text>{title || '（无标题）'}</Typography.Text>
            {row.enabled === false ? <Tag>已停用</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {row.content.length > 60 ? `${row.content.slice(0, 60)}…` : row.content}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '已读', dataIndex: 'readCount', width: 80 },
    {
      title: '发布时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {new Date(value).toLocaleString()}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, row) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            onClick={() => {
              form.setFieldsValue({ title: row.title, content: row.content, enabled: row.enabled ?? true });
              setEditing(row);
            }}
          >
            编辑
          </Button>
          <Popconfirm
            title="删除该公告？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() =>
              void adminApi
                .removeNotice(row.id)
                .then(() => {
                  message.success('已删除');
                  void load();
                })
                .catch((err) => message.error(err instanceof ApiError ? err.message : '删除失败'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="公告"
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
          发布公告
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        公告会出现在所有登录用户的铃铛里；停用后不再显示。
      </Typography.Paragraph>

      <Table rowKey="id" columns={columns} dataSource={rows} loading={loading} pagination={false} size="small" />

      <Modal
        title={editing === 'new' ? '发布公告' : '编辑公告'}
        open={editing !== null}
        onCancel={() => {
          setEditing(null);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark={false} initialValues={{ enabled: true }}>
          <Form.Item name="title" label="标题（可选）">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="content" label="内容" rules={[{ required: true, message: '请填写公告内容' }]}>
            <Input.TextArea rows={6} maxLength={4000} showCount />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
