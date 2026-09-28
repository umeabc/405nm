import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Space,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, projectApi, type ProjectCard as ProjectCardData, type ProjectSetRow } from '../../api/client';
import { ProjectCard } from '../../components/ProjectCard';
import { ProjectFormModal } from '../../components/ProjectFormModal';

/**
 * 团队页的「作品」tab：作品集 + 作品列表 + 归类管理。
 *
 * 与工作台的分工：工作台是「我该干什么」，这里是「这个团队有哪些东西」。
 * 所以这里按作品集归类、带管理动作，而工作台按进度档位筛选、只给下一步动作。
 */
export function TeamProjectsTab({
  teamId,
  can,
}: {
  teamId: string;
  can: (code: string) => boolean;
}) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();

  const [sets, setSets] = useState<ProjectSetRow[]>([]);
  const [cards, setCards] = useState<ProjectCardData[]>([]);
  const [loading, setLoading] = useState(true);
  /** 'all' | 'ungrouped' | 作品集 id */
  const [filter, setFilter] = useState<string>('all');

  const [creatingProject, setCreatingProject] = useState(false);
  const [editingSet, setEditingSet] = useState<ProjectSetRow | 'new' | null>(null);
  const [setSubmitting, setSetSubmitting] = useState(false);
  const [setForm] = Form.useForm<{ name: string; intro?: string }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [setRes, projectRes] = await Promise.all([
        projectApi.sets(teamId),
        projectApi.list(teamId, {
          ...(filter === 'ungrouped' ? { ungrouped: true } : filter === 'all' ? {} : { setId: filter }),
        }),
      ]);
      setSets(setRes.sets);
      setCards(projectRes.projects);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '作品加载失败');
    } finally {
      setLoading(false);
    }
  }, [teamId, filter, message]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSet(values: { name: string; intro?: string }) {
    setSetSubmitting(true);
    try {
      if (editingSet === 'new') {
        await projectApi.createSet(teamId, values);
        message.success('作品集已创建');
      } else if (editingSet) {
        await projectApi.updateSet(teamId, editingSet.id, values);
        message.success('作品集已更新');
      }
      setEditingSet(null);
      setForm.resetFields();
      void load();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSetSubmitting(false);
    }
  }

  const totalCount = sets.reduce((sum, s) => sum + s.projectCount, 0);

  return (
    <Row gutter={[16, 16]}>
      <Col xs={24} md={7} lg={6}>
        <Card
          size="small"
          title="作品集"
          extra={
            can('project_set.create') ? (
              <Button
                size="small"
                type="text"
                icon={<PlusOutlined />}
                onClick={() => {
                  setForm.resetFields();
                  setEditingSet('new');
                }}
              />
            ) : null
          }
        >
          <List
            size="small"
            dataSource={[
              { id: 'all', name: '全部作品', projectCount: totalCount, intro: '', orderIndex: 0 },
              { id: 'ungrouped', name: '未归类', projectCount: 0, intro: '', orderIndex: 0 },
              ...sets,
            ]}
            renderItem={(item) => {
              const active = filter === item.id;
              return (
                <List.Item
                  style={{
                    cursor: 'pointer',
                    padding: '8px 8px',
                    borderRadius: 8,
                    background: active ? 'rgba(240,131,106,0.10)' : undefined,
                  }}
                  onClick={() => setFilter(item.id)}
                  actions={
                    item.id === 'all' || item.id === 'ungrouped'
                      ? []
                      : [
                          can('project_set.edit') ? (
                            <Button
                              key="edit"
                              size="small"
                              type="text"
                              icon={<EditOutlined />}
                              onClick={(event) => {
                                event.stopPropagation();
                                setForm.setFieldsValue({ name: item.name, intro: item.intro });
                                setEditingSet(item as ProjectSetRow);
                              }}
                            />
                          ) : null,
                          can('project_set.delete') ? (
                            <Popconfirm
                              key="delete"
                              title={`删除作品集「${item.name}」？`}
                              description="里面的作品不会被删除，只会变成「未归类」。"
                              okText="删除"
                              okButtonProps={{ danger: true }}
                              cancelText="取消"
                              onConfirm={() =>
                                void projectApi
                                  .removeSet(teamId, item.id)
                                  .then(() => {
                                    message.success('已删除');
                                    setFilter('all');
                                    void load();
                                  })
                                  .catch((err) => message.error(err instanceof ApiError ? err.message : '删除失败'))
                              }
                            >
                              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                            </Popconfirm>
                          ) : null,
                        ].filter(Boolean)
                  }
                >
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text style={{ fontSize: 13 }}>{item.name}</Typography.Text>
                    {item.id !== 'ungrouped' ? (
                      <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>{item.projectCount}</Tag>
                    ) : null}
                  </Space>
                </List.Item>
              );
            }}
          />
        </Card>
      </Col>

      <Col xs={24} md={17} lg={18}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            共 {cards.length} 部作品
          </Typography.Text>
          {can('project.create') ? (
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreatingProject(true)}>
              新建作品
            </Button>
          ) : null}
        </div>

        {loading ? (
          <Card loading />
        ) : cards.length === 0 ? (
          <Card>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  {filter === 'all' ? '这个团队还没有作品' : '这一栏还没有作品'}
                </Typography.Text>
              }
            />
          </Card>
        ) : (
          <Row gutter={[14, 14]}>
            {cards.map((card) => (
              <Col xs={24} lg={12} key={card.id}>
                <ProjectCard card={card} />
              </Col>
            ))}
          </Row>
        )}
      </Col>

      {creatingProject ? (
        <ProjectFormModal
          open
          mode="create"
          teamId={teamId}
          onClose={() => setCreatingProject(false)}
          onSaved={(project) => {
            void load();
            navigate(`/projects/${project.id}`);
          }}
        />
      ) : null}

      <Modal
        title={editingSet === 'new' ? '新建作品集' : '编辑作品集'}
        open={editingSet !== null}
        onCancel={() => setEditingSet(null)}
        onOk={() => setForm.submit()}
        confirmLoading={setSubmitting}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={setForm} layout="vertical" onFinish={saveSet} requiredMark={false}>
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请填写作品集名称' }, { max: 60, message: '最多 60 个字符' }]}
          >
            <Input placeholder="例如：2026 春番" autoFocus />
          </Form.Item>
          <Form.Item name="intro" label="简介（可选）">
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
    </Row>
  );
}
