import { DeleteOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, permissionApi, projectApi, type PermissionInfo, type ProjectRoleRow } from '../../api/client';
import { PermissionPicker, groupPermissions } from '../../components/PermissionPicker';
import { palette } from '../../theme';
import type { ProjectTabProps } from './index';

/**
 * 作品角色与权限。
 *
 * 两条规则贯穿全页，界面上都做了对应处理：
 *  1. **系统内置角色不能改名、不能改等级**（权限可以调）。名字与等级参与
 *     「谁能管谁」的判定，改它们会静默改变治理结构 —— 所以后端拦、界面也禁。
 *  2. **不能授出自己没有的权限**，所以自己没有的权限码在勾选器里是灰的。
 */
export function RolesTab({ detail, reload, can }: ProjectTabProps) {
  const { message } = AntApp.useApp();
  const projectId = detail.project.id;

  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [editing, setEditing] = useState<ProjectRoleRow | 'new' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{
    name: string;
    level: number;
    intro?: string;
    permissions: string[];
  }>();

  useEffect(() => {
    void permissionApi
      .list()
      .then((res) => setPermissions(res.permissions))
      .catch(() => undefined);
  }, []);

  // 作品角色只能用**作品域**的权限 —— 团队域权限挂到作品角色上没有意义，
  // 后端也会拒绝（assertProjectScopePermissions）。
  const groups = useMemo(
    () => groupPermissions(permissions.filter((p) => p.scope === 'project')),
    [permissions],
  );

  const myPermissions = detail.my.permissions;
  const isSiteAdmin = detail.my.isSiteAdmin;
  const myLevel = detail.my.role?.level ?? 0;

  function openEdit(role: ProjectRoleRow | 'new') {
    setEditing(role);
    if (role === 'new') {
      form.resetFields();
      form.setFieldsValue({ level: 200, permissions: [] });
    } else {
      form.setFieldsValue({
        name: role.name,
        level: role.level,
        intro: role.intro,
        permissions: role.permissions,
      });
    }
  }

  async function save(values: { name: string; level: number; intro?: string; permissions: string[] }) {
    if (!editing) return;
    setSubmitting(true);
    try {
      if (editing === 'new') {
        await projectApi.createRole(projectId, values);
        message.success('角色已创建');
      } else {
        const isSystem = editing.isSystem;
        await projectApi.updateRole(projectId, editing.id, {
          // 系统角色只提交权限与说明，名字/等级由后端锁定。
          ...(isSystem ? {} : { name: values.name, level: values.level }),
          intro: values.intro,
          permissions: values.permissions,
        });
        message.success('角色已更新');
      }
      setEditing(null);
      void reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card
      title={`角色与权限（${detail.roles.length}）`}
      extra={
        <Space size={6}>
          {can('project.member.manage') ? (
            <Tooltip title="把代码里的默认权限补给本作品的系统角色（只加不减，不会覆盖你手工加过的权限）">
              <Button
                size="small"
                icon={<SyncOutlined />}
                onClick={() =>
                  void projectApi
                    .syncRoles(projectId)
                    .then((res) => {
                      if (res.report.length === 0) message.success('默认权限已是最新');
                      else
                        message.success(
                          `已补 ${res.report.reduce((n, r) => n + r.added.length, 0)} 项权限：` +
                            res.report.map((r) => `${r.role} +${r.added.length}`).join('、'),
                        );
                      void reload();
                    })
                    .catch((err) => message.error(err instanceof ApiError ? err.message : '同步失败'))
                }
              >
                同步默认权限
              </Button>
            </Tooltip>
          ) : null}
          {can('project.member.manage') ? (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => openEdit('new')}>
              新建角色
            </Button>
          ) : null}
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        这里的角色属于<b>这部作品</b>：改动它们不会影响同一团队下的其他作品。
        新建作品时会从团队的角色模板复制一份，之后各自独立。
      </Typography.Paragraph>

      <Row gutter={[12, 12]}>
        {detail.roles
          .slice()
          .sort((a, b) => b.level - a.level)
          .map((role) => {
            const editable =
              can('project.member.manage') && (isSiteAdmin || myLevel >= role.level);
            return (
              <Col xs={24} md={12} key={role.id}>
                <Card
                  size="small"
                  styles={{ body: { padding: 14 } }}
                  title={
                    <Space size={6}>
                      <span>{role.name}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 11, fontWeight: 400 }}>
                        等级 {role.level}
                      </Typography.Text>
                      {role.isSystem ? <Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>内置</Tag> : null}
                    </Space>
                  }
                  extra={
                    <Space size={2}>
                      {editable ? (
                        <Button size="small" type="link" onClick={() => openEdit(role)}>
                          编辑
                        </Button>
                      ) : null}
                      {editable && !role.isSystem ? (
                        <Popconfirm
                          title="删除该角色？"
                          description="角色下还有成员时无法删除。"
                          okText="删除"
                          okButtonProps={{ danger: true }}
                          cancelText="取消"
                          onConfirm={() =>
                            void projectApi
                              .removeRole(projectId, role.id)
                              .then(() => {
                                message.success('已删除');
                                void reload();
                              })
                              .catch((err) => message.error(err instanceof ApiError ? err.message : '删除失败'))
                          }
                        >
                          <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      ) : null}
                    </Space>
                  }
                >
                  {role.intro ? (
                    <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                      {role.intro}
                    </Typography.Paragraph>
                  ) : null}
                  <Space size={[4, 4]} wrap>
                    {role.permissions.length === 0 ? (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        暂无权限
                      </Typography.Text>
                    ) : (
                      role.permissions.map((code) => (
                        <Tag key={code} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                          {permissions.find((p) => p.code === code)?.label ?? code}
                        </Tag>
                      ))
                    )}
                  </Space>
                </Card>
              </Col>
            );
          })}
      </Row>

      <Modal
        title={editing === 'new' ? '新建作品角色' : `编辑角色：${editing?.name ?? ''}`}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        width={640}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={save} requiredMark={false}>
          <Row gutter={16}>
            <Col span={14}>
              <Form.Item
                name="name"
                label="角色名"
                rules={[{ required: true, message: '请填写角色名' }, { max: 16, message: '最多 16 个字符' }]}
                extra={editing !== 'new' && editing?.isSystem ? '系统内置角色不可改名' : undefined}
              >
                <Input disabled={editing !== 'new' && Boolean(editing?.isSystem)} maxLength={16} />
              </Form.Item>
            </Col>
            <Col span={10}>
              <Form.Item
                name="level"
                label="等级"
                rules={[{ required: true, message: '请填写等级' }]}
                extra={
                  editing !== 'new' && editing?.isSystem
                    ? '系统内置角色不可改等级'
                    : `只能管理等级低于 ${myLevel} 的成员`
                }
              >
                <InputNumber
                  min={1}
                  max={499}
                  style={{ width: '100%' }}
                  disabled={editing !== 'new' && Boolean(editing?.isSystem)}
                />
              </Form.Item>
            </Col>
          </Row>

          <Form.Item name="intro" label="说明（可选）">
            <Input maxLength={100} placeholder="一句话说明这个角色做什么" />
          </Form.Item>

          <Form.Item name="permissions" label="权限">
            <PermissionPicker groups={groups} myPermissions={myPermissions} isSiteAdmin={isSiteAdmin} />
          </Form.Item>
        </Form>

        <Typography.Text type="secondary" style={{ fontSize: 11, color: palette.inkSoft }}>
          灰色且不可勾选的权限，是你自己也没有的 —— 不能把权限授到超出自己的范围。
        </Typography.Text>
      </Modal>
    </Card>
  );
}
