import { PlusOutlined, UserAddOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Avatar,
  Button,
  Card,
  Form,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  projectApi,
  type ProjectMemberRow,
} from '../../api/client';
import { comiku } from '../../theme';
import type { ProjectTabProps } from './index';

/**
 * 作品成员。
 *
 * 等级守卫与团队页同一套规则：**只能改动等级严格低于自己的成员**。
 * 因此这里会出现「看得见、但改不了」的行 —— 那种情况下控件是禁用的，
 * 而不是点了才报错。备注里说明原因，免得让人以为界面坏了。
 */
export function MembersTab({ detail, reload, can, goTab }: ProjectTabProps) {
  const { message } = AntApp.useApp();
  const projectId = detail.project.id;

  const [rows, setRows] = useState<ProjectMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [candidates, setCandidates] = useState<
    Array<{ userId: string; username: string; displayName: string; teamRoleName: string }>
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ userId: string; projectRoleId: string }>();

  const myLevel = Math.max(detail.my.role?.level ?? 0, 0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await projectApi.members(projectId);
      setRows(res.members);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '成员加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const assignableRoles = detail.roles
    .filter((role) => detail.my.isSiteAdmin || role.level < myLevel || role.level === myLevel)
    .sort((a, b) => b.level - a.level);

  const roleOptions = assignableRoles.map((role) => ({
    value: role.id,
    label: `${role.name}（等级 ${role.level}）`,
  }));

  async function openAdd() {
    setAdding(true);
    try {
      const res = await projectApi.memberCandidates(projectId);
      setCandidates(res.candidates);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '候选成员加载失败');
    }
  }

  async function submitAdd(values: { userId: string; projectRoleId: string }) {
    setSubmitting(true);
    try {
      await projectApi.addMember(projectId, values.userId, values.projectRoleId);
      message.success('已加入作品');
      setAdding(false);
      form.resetFields();
      void load();
      void reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function changeRole(userId: string, projectRoleId: string) {
    try {
      await projectApi.changeMemberRole(projectId, userId, projectRoleId);
      message.success('已调整角色');
      void load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '调整失败');
    }
  }

  const columns: ColumnsType<ProjectMemberRow> = [
    {
      title: '成员',
      key: 'member',
      render: (_, row) => (
        <Space size={8}>
          <Avatar size={28} style={{ background: comiku.primary, fontSize: 12 }} src={row.avatarKey ?? undefined}>
            {row.displayName.slice(0, 1)}
          </Avatar>
          <Space direction="vertical" size={0}>
            <Typography.Text>{row.displayName}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              @{row.username}
            </Typography.Text>
          </Space>
        </Space>
      ),
    },
    {
      title: '作品角色',
      key: 'role',
      width: 220,
      render: (_, row) => {
        const manageable = detail.my.isSiteAdmin || myLevel > row.roleLevel;
        if (!manageable || !can('project.member.manage')) {
          return (
            <Space size={6}>
              <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
                {row.roleName}
              </Tag>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                等级 {row.roleLevel}
              </Typography.Text>
            </Space>
          );
        }
        return (
          <Select
            size="small"
            value={row.roleId}
            style={{ width: 190 }}
            options={roleOptions}
            onChange={(value) => void changeRole(row.userId, value)}
          />
        );
      },
    },
    {
      title: '加入时间',
      dataIndex: 'joinedAt',
      width: 150,
      render: (value: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {new Date(value).toLocaleDateString()}
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, row) => {
        const removable =
          can('project.member.manage') &&
          row.roleSystemCode !== 'creator' &&
          (detail.my.isSiteAdmin || myLevel > row.roleLevel);
        return (
          <Popconfirm
            title="移出该成员？"
            description="他不会失去团队身份，只是不再参与这部作品。"
            okText="移出"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() =>
              void projectApi
                .removeMember(projectId, row.userId)
                .then(() => {
                  message.success('已移出');
                  void load();
                  void reload();
                })
                .catch((err) => message.error(err instanceof ApiError ? err.message : '移出失败'))
            }
            disabled={!removable}
          >
            <Button size="small" type="link" danger disabled={!removable}>
              移出
            </Button>
          </Popconfirm>
        );
      },
    },
  ];

  return (
    <Card
      title={`参与成员（${rows.length}）`}
      extra={
        can('project.member.manage') ? (
          <Button size="small" type="primary" icon={<UserAddOutlined />} onClick={() => void openAdd()}>
            添加成员
          </Button>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        作品角色决定「在<b>这部作品</b>里能做什么」，与团队角色是两回事。
        团队里等级更高的人可以调整等级低于自己的成员。
        {assignableRoles.length < detail.roles.length ? (
          <>
            {' '}
            有 {detail.roles.length - assignableRoles.length} 个角色因等级不低于你而不可指派 ——{' '}
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => goTab('roles')}>
              查看角色
            </Button>
          </>
        ) : null}
      </Typography.Paragraph>

      <Table rowKey="userId" columns={columns} dataSource={rows} loading={loading} pagination={false} size="small" />

      <Modal
        title="添加作品成员"
        open={adding}
        onCancel={() => setAdding(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="添加"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={submitAdd} requiredMark={false}>
          <Form.Item name="userId" label="成员" rules={[{ required: true, message: '请选择成员' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder={candidates.length === 0 ? '团队里没有可添加的成员了' : '从团队成员中选择'}
              options={candidates.map((c) => ({
                value: c.userId,
                label: `${c.displayName}（${c.teamRoleName}）`,
              }))}
              disabled={candidates.length === 0}
            />
          </Form.Item>
          <Form.Item
            name="projectRoleId"
            label="作品角色"
            rules={[{ required: true, message: '请选择作品角色' }]}
            extra="角色决定他在这部作品里能做什么。"
          >
            <Select options={roleOptions} placeholder="选择一个角色" />
          </Form.Item>
        </Form>
        {candidates.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            <PlusOutlined /> 想加的人不在列表里？先把他加进团队。
          </Typography.Text>
        ) : null}
      </Modal>
    </Card>
  );
}
