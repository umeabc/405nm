import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  permissionApi,
  teamApi,
  type InviteRow,
  type PermissionInfo,
  type RoleInfo,
  type TeamDetail,
  type TeamMemberRow,
} from '../api/client';
import { PageHeader } from '../components/AppShell';
import { PermissionPicker, groupPermissions } from '../components/PermissionPicker';
import { useAuth } from '../auth/AuthContext';
import { comiku } from '../theme';
import { TeamProjectsTab } from './team/ProjectsTab';

export default function TeamDetailPage() {
  const { teamId = '' } = useParams();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [tab, setTab] = useState('overview');

  const loadDetail = useCallback(async () => {
    try {
      const res = await teamApi.detail(teamId);
      setDetail(res);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '团队加载失败');
      navigate('/teams', { replace: true });
    } finally {
      setLoading(false);
    }
  }, [teamId, message, navigate]);

  const loadMembers = useCallback(async () => {
    try {
      const res = await teamApi.members(teamId);
      setMembers(res.members);
    } catch {
      /* 无权限时不报错，界面上自然没有这块内容 */
    }
  }, [teamId]);

  const loadInvites = useCallback(async () => {
    try {
      const res = await teamApi.invites(teamId);
      setInvites(res.invites);
    } catch {
      /* 同上 */
    }
  }, [teamId]);

  useEffect(() => {
    void loadDetail();
    void permissionApi.list().then((res) => setPermissions(res.permissions)).catch(() => undefined);
  }, [loadDetail]);

  useEffect(() => {
    if (tab === 'members') void loadMembers();
    if (tab === 'invites') void loadInvites();
  }, [tab, loadMembers, loadInvites]);

  const myPermissions = detail?.my.permissions ?? [];
  const myLevel = detail?.my.role?.level ?? (detail?.my.isSiteAdmin ? 9999 : 0);
  const can = (code: string) => myPermissions.includes(code);

  /** 只能管等级严格低于自己的角色 —— 与后端同一套规则，界面上提前把不可选项灰掉。 */
  const assignableRoles = (currentLevel?: number) =>
    (detail?.roles ?? []).filter((r) => r.level < myLevel || r.level === currentLevel);

  return (
    <>
      <PageHeader
        title={detail?.team.name ?? '团队'}
        description={detail?.team.intro || undefined}
        extra={
          <Space>
            <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
              {detail?.my.isSiteAdmin ? '站点管理员' : (detail?.my.role?.name ?? '—')}
            </Tag>
          </Space>
        }
      />

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'overview',
            label: '概览',
            children: (
              <OverviewTab
                detail={detail}
                loading={loading}
                canEdit={can('team.edit')}
                canDelete={can('team.delete')}
                onSaved={loadDetail}
                onDeleted={() => navigate('/teams', { replace: true })}
              />
            ),
          },
          {
            key: 'members',
            label: '成员',
            children: (
              <MembersTab
                teamId={teamId}
                members={members}
                roles={detail?.roles ?? []}
                assignableRoles={assignableRoles}
                canInvite={can('team.member.invite')}
                canChangeRole={can('team.member.change_role')}
                canRemove={can('team.member.remove')}
                reload={loadMembers}
              />
            ),
          },
          {
            // 作品放在成员之后、角色之前：这个顺序与团队里实际的关注度一致 ——
            // 先看「有哪些作品」，再看「谁在这部作品里干什么」，最后才是角色的权限定义。
            key: 'projects',
            label: '作品',
            children: <TeamProjectsTab teamId={teamId} can={can} />,
          },
          {
            key: 'roles',
            label: '角色',
            children: (
              <RolesTab
                teamId={teamId}
                roles={detail?.roles ?? []}
                permissions={permissions}
                myLevel={myLevel}
                myPermissions={myPermissions}
                isSiteAdmin={Boolean(detail?.my.isSiteAdmin)}
                canCreate={can('team.role.create')}
                canEdit={can('team.role.edit')}
                canDelete={can('team.role.delete')}
                reload={loadDetail}
              />
            ),
          },
          ...(can('team.invite.manage')
            ? [
                {
                  key: 'invites',
                  label: '邀请码',
                  children: (
                    <InvitesTab
                      teamId={teamId}
                      invites={invites}
                      roles={detail?.roles ?? []}
                      reload={loadInvites}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}

// ── 概览 ────────────────────────────────────────────────────

function OverviewTab({
  detail,
  loading,
  canEdit,
  canDelete,
  onSaved,
  onDeleted,
}: {
  detail: TeamDetail | null;
  loading: boolean;
  canEdit: boolean;
  canDelete: boolean;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<{ name: string; intro?: string }>();

  async function save(values: { name: string; intro?: string }) {
    if (!detail) return;
    setSaving(true);
    try {
      await teamApi.update(detail.team.id, values);
      message.success('已保存');
      setEditing(false);
      onSaved();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!detail) return;
    try {
      await teamApi.remove(detail.team.id);
      message.success('团队已解散');
      onDeleted();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '解散失败');
    }
  }

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} lg={14}>
        <Card
          title="团队信息"
          loading={loading}
          extra={
            canEdit && !editing ? (
              <Button
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  form.setFieldsValue({ name: detail?.team.name, intro: detail?.team.intro });
                  setEditing(true);
                }}
              >
                编辑
              </Button>
            ) : null
          }
        >
          {editing ? (
            <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
              <Form.Item
                name="name"
                label="团队名称"
                rules={[
                  { required: true, message: '请输入团队名称' },
                  { min: 2, max: 32, message: '团队名称长度需为 2 ~ 32 个字符' },
                ]}
              >
                <Input />
              </Form.Item>
              <Form.Item name="intro" label="简介">
                <Input.TextArea rows={3} maxLength={200} showCount />
              </Form.Item>
              <Space>
                <Button type="primary" htmlType="submit" loading={saving}>
                  保存
                </Button>
                <Button onClick={() => setEditing(false)}>取消</Button>
              </Space>
            </Form>
          ) : (
            <Descriptions column={1} size="small">
              <Descriptions.Item label="名称">{detail?.team.name}</Descriptions.Item>
              <Descriptions.Item label="简介">{detail?.team.intro || '（暂无）'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {detail?.team.createdAt ? new Date(detail.team.createdAt).toLocaleString() : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="我的角色">
                {detail?.my.isSiteAdmin ? '站点管理员（拥有全部权限）' : detail?.my.role?.name}
              </Descriptions.Item>
              <Descriptions.Item label="我的权限数">{myPermissionsCount(detail)}</Descriptions.Item>
            </Descriptions>
          )}
        </Card>
      </Col>

      {canDelete ? (
        <Col xs={24} lg={10}>
          <Card title="危险操作" loading={loading}>
            <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
              解散团队会同时删除团队的角色、成员关系与邀请码，且不可恢复。
            </Typography.Paragraph>
            <Popconfirm
              title="确认解散该团队？"
              description="此操作不可撤销。"
              okText="确认解散"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={remove}
            >
              <Button danger icon={<DeleteOutlined />}>
                解散团队
              </Button>
            </Popconfirm>
          </Card>
        </Col>
      ) : null}
    </Row>
  );
}

function myPermissionsCount(detail: TeamDetail | null): number {
  return detail?.my.permissions.length ?? 0;
}

// ── 成员 ────────────────────────────────────────────────────

function MembersTab({
  teamId,
  members,
  roles,
  assignableRoles,
  canInvite,
  canChangeRole,
  canRemove,
  reload,
}: {
  teamId: string;
  members: TeamMemberRow[];
  roles: RoleInfo[];
  assignableRoles: (currentLevel?: number) => RoleInfo[];
  canInvite: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  reload: () => void;
}) {
  const { message } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ username: string; roleId: string }>();

  async function addMember(values: { username: string; roleId: string }) {
    setSubmitting(true);
    try {
      await teamApi.addMember(teamId, values.username, values.roleId);
      message.success('已加入团队');
      setAdding(false);
      form.resetFields();
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function changeRole(userId: string, roleId: string) {
    try {
      await teamApi.changeMemberRole(teamId, userId, roleId);
      message.success('角色已调整');
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '调整失败');
      reload();
    }
  }

  async function removeMember(userId: string) {
    try {
      await teamApi.removeMember(teamId, userId);
      message.success('已移出团队');
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '移除失败');
    }
  }

  const columns: ColumnsType<TeamMemberRow> = [
    {
      title: '成员',
      dataIndex: 'displayName',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{row.displayName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            @{row.username}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '角色',
      dataIndex: 'roleId',
      width: 200,
      render: (_, row) => {
        const options = assignableRoles(row.roleLevel);
        const locked = !canChangeRole || row.roleSystemCode === 'creator';
        return (
          <Tooltip title={row.roleSystemCode === 'creator' ? '团队创建人的角色不可变更' : undefined}>
            <Select
              size="small"
              value={row.roleId}
              disabled={locked}
              style={{ width: '100%' }}
              options={options.map((r) => ({ value: r.id, label: `${r.name}（${r.level}）` }))}
              onChange={(roleId) => void changeRole(row.userId, roleId)}
            />
          </Tooltip>
        );
      },
    },
    {
      title: '加入时间',
      dataIndex: 'joinedAt',
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
      width: 90,
      render: (_, row) =>
        canRemove && row.roleSystemCode !== 'creator' ? (
          <Popconfirm
            title="移出该成员？"
            okText="移出"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void removeMember(row.userId)}
          >
            <Button size="small" type="text" danger>
              移出
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <Card
      title="团队成员"
      extra={
        canInvite ? (
          <Button size="small" icon={<UserAddOutlined />} onClick={() => setAdding(true)}>
            添加成员
          </Button>
        ) : null
      }
    >
      <Table rowKey="userId" columns={columns} dataSource={members} pagination={false} size="small" />

      <Modal
        title="添加成员"
        open={adding}
        onCancel={() => setAdding(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="添加"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={addMember} requiredMark={false}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: '请输入已注册用户的用户名' }]}
            extra="对方需要先通过邀请码完成注册"
          >
            <Input placeholder="对方的登录用户名" />
          </Form.Item>
          <Form.Item name="roleId" label="角色" rules={[{ required: true, message: '请选择角色' }]}>
            <Select
              placeholder="选择角色"
              options={roles
                .filter((r) => assignableRoles().some((a) => a.id === r.id))
                .map((r) => ({ value: r.id, label: `${r.name}（${r.level}）` }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ── 角色 ────────────────────────────────────────────────────

function RolesTab({
  teamId,
  roles,
  permissions,
  myLevel,
  myPermissions,
  isSiteAdmin,
  canCreate,
  canEdit,
  canDelete,
  reload,
}: {
  teamId: string;
  roles: RoleInfo[];
  permissions: PermissionInfo[];
  myLevel: number;
  myPermissions: string[];
  isSiteAdmin: boolean;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  reload: () => void;
}) {
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState<RoleInfo | 'new' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ name: string; level: number; intro?: string; permissions: string[]; autoProjectAdmin: boolean }>();

  // 团队角色只能用团队域的权限码；分组逻辑与作品角色共用同一份实现。
  const groups = useMemo(
    () => groupPermissions(permissions.filter((p) => p.scope === 'team')),
    [permissions],
  );

  const isNew = editing === 'new';

  async function save(values: { name: string; level: number; intro?: string; permissions: string[]; autoProjectAdmin: boolean }) {
    setSubmitting(true);
    try {
      if (isNew) {
        await teamApi.createRole(teamId, values);
        message.success('角色已创建');
      } else if (editing) {
        await teamApi.updateRole(teamId, editing.id, values);
        message.success('角色已更新');
      }
      setEditing(null);
      form.resetFields();
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(role: RoleInfo) {
    try {
      await teamApi.removeRole(teamId, role.id);
      message.success('角色已删除');
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    }
  }

  return (
    <Card
      title="角色与权限"
      extra={
        canCreate ? (
          <Button size="small" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            新建角色
          </Button>
        ) : null
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {[...roles].sort((a, b) => b.level - a.level).map((role) => {
          const manageable = isSiteAdmin || role.level < myLevel;
          return (
            <Card key={role.id} size="small" styles={{ body: { padding: 14 } }}>
              <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }} align="start">
                <Space size={8}>
                  <Typography.Text strong>{role.name}</Typography.Text>
                  <Tag>等级 {role.level}</Tag>
                  {role.isSystem ? <Tag color="blue">系统内置</Tag> : null}
                  {role.autoProjectAdmin ? <Tag color="gold">自动成为作品管理员</Tag> : null}
                </Space>
                <Space size={4}>
                  {canEdit && manageable ? (
                    <Button
                      size="small"
                      type="text"
                      onClick={() => {
                        form.setFieldsValue({
                          name: role.name,
                          level: role.level,
                          intro: role.intro,
                          permissions: role.permissions,
                          autoProjectAdmin: role.autoProjectAdmin,
                        });
                        setEditing(role);
                      }}
                    >
                      编辑
                    </Button>
                  ) : null}
                  {canDelete && !role.isSystem && manageable ? (
                    <Popconfirm
                      title="删除该角色？"
                      description="仍有成员或邀请码引用时无法删除。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={() => void remove(role)}
                    >
                      <Button size="small" type="text" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
              </Space>

              {role.intro ? (
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                  {role.intro}
                </Typography.Paragraph>
              ) : null}

              <Space size={[4, 4]} wrap>
                {role.permissions.length === 0 ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    无任何权限
                  </Typography.Text>
                ) : (
                  role.permissions.map((code) => (
                    <Tag key={code} style={{ fontSize: 11 }}>
                      {permissions.find((p) => p.code === code)?.label ?? code}
                    </Tag>
                  ))
                )}
              </Space>
            </Card>
          );
        })}
      </Space>

      <Modal
        title={isNew ? '新建角色' : `编辑角色：${editing ? editing.name : ''}`}
        open={editing !== null}
        onCancel={() => {
          setEditing(null);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark={false} initialValues={{ level: 200, autoProjectAdmin: false, permissions: [] }}>
          <Row gutter={12}>
            <Col span={14}>
              <Form.Item
                name="name"
                label="角色名"
                rules={[{ required: true, message: '请填写角色名' }, { max: 16, message: '最多 16 个字符' }]}
              >
                <Input placeholder="例如：嵌字" />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item
                name="level"
                label="等级"
                rules={[{ required: true, message: '请填写等级' }]}
                extra={`需低于你自己的等级（${isSiteAdmin ? '站点管理员不受限' : myLevel}）`}
              >
                <InputNumber min={1} max={isSiteAdmin ? 499 : Math.max(1, myLevel - 1)} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="intro" label="说明（可选）">
            <Input maxLength={100} placeholder="这个角色负责什么" />
          </Form.Item>

          <Form.Item
            name="autoProjectAdmin"
            label="自动成为作品管理员"
            valuePropName="checked"
            extra="勾选后，持有该角色的成员在团队下所有作品中自动获得管理员级别权限"
          >
            <Switch />
          </Form.Item>

          <Divider orientation="left" plain style={{ marginTop: 8 }}>
            权限
          </Divider>

          <Form.Item name="permissions" noStyle>
            <PermissionPicker groups={groups} myPermissions={myPermissions} isSiteAdmin={isSiteAdmin} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ── 邀请码 ──────────────────────────────────────────────────

function InvitesTab({
  teamId,
  invites,
  roles,
  reload,
}: {
  teamId: string;
  invites: InviteRow[];
  roles: RoleInfo[];
  reload: () => void;
}) {
  const { message } = AntApp.useApp();
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ roleId?: string; maxUses?: number; note?: string; count: number }>();

  async function create(values: { roleId?: string; maxUses?: number; note?: string; count: number }) {
    setSubmitting(true);
    try {
      const res = await teamApi.createInvites(teamId, {
        roleId: values.roleId ?? null,
        maxUses: values.maxUses ?? null,
        note: values.note,
        count: values.count,
      });
      message.success(`已生成 ${res.invites.length} 个邀请码`);
      setCreating(false);
      form.resetFields();
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '生成失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function toggle(row: InviteRow) {
    try {
      await teamApi.toggleInvite(teamId, row.id, !row.enabled);
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    }
  }

  async function remove(row: InviteRow) {
    try {
      await teamApi.removeInvite(teamId, row.id);
      message.success('已删除');
      reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '删除失败');
    }
  }

  function copy(code: string) {
    void navigator.clipboard
      .writeText(code)
      .then(() => message.success('已复制'))
      .catch(() => message.warning('复制失败，请手动选择复制'));
  }

  const columns: ColumnsType<InviteRow> = [
    {
      title: '邀请码',
      dataIndex: 'code',
      render: (code: string, row) => (
        <Space size={6}>
          <Typography.Text code copyable={false} style={{ fontSize: 13 }}>
            {code}
          </Typography.Text>
          <Button type="text" size="small" icon={<CopyOutlined />} onClick={() => copy(code)} />
          <Tag color={row.enabled ? 'green' : 'default'}>{row.enabled ? '启用' : '已停用'}</Tag>
        </Space>
      ),
    },
    {
      title: '绑定角色',
      dataIndex: 'roleName',
      width: 130,
      render: (name: string | null) => name ?? <Typography.Text type="secondary">默认角色</Typography.Text>,
    },
    {
      title: '使用情况',
      key: 'usage',
      width: 120,
      render: (_, row) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {row.usedCount} / {row.maxUses ?? '不限'}
        </Typography.Text>
      ),
    },
    {
      title: '备注',
      dataIndex: 'note',
      render: (note: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {note || '—'}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_, row) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => void toggle(row)}>
            {row.enabled ? '停用' : '启用'}
          </Button>
          <Popconfirm
            title="删除该邀请码？"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => void remove(row)}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="邀请码"
      extra={
        <Button size="small" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
          生成邀请码
        </Button>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        拿到邀请码的人注册后会**自动加入本团队**，并按这里绑定的角色入团。
      </Typography.Paragraph>

      <Table rowKey="id" columns={columns} dataSource={invites} pagination={false} size="small" />

      <Modal
        title="生成邀请码"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="生成"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={create} requiredMark={false} initialValues={{ count: 1 }}>
          <Form.Item name="roleId" label="绑定角色" extra="留空则使用团队默认角色（见习成员）">
            <Select
              allowClear
              placeholder="默认角色"
              options={roles.map((r) => ({ value: r.id, label: `${r.name}（${r.level}）` }))}
            />
          </Form.Item>
          <Form.Item name="maxUses" label="可用次数" extra="留空表示不限次数">
            <InputNumber min={1} max={1000} style={{ width: '100%' }} placeholder="不限" />
          </Form.Item>
          <Form.Item name="count" label="生成数量">
            <InputNumber min={1} max={20} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注（可选）">
            <Input maxLength={60} placeholder="给谁用的，方便以后辨认" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
