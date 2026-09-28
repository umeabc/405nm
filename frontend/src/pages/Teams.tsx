import { PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Col, Empty, Form, Input, Modal, Row, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, teamApi, type TeamSummary } from '../api/client';
import { PageHeader } from '../components/AppShell';
import { comiku } from '../theme';

export default function TeamsPage() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ name: string; intro?: string }>();

  async function load() {
    setLoading(true);
    try {
      const res = await teamApi.mine();
      setTeams(res.teams);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '团队列表加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(values: { name: string; intro?: string }) {
    setSubmitting(true);
    try {
      const res = await teamApi.create(values.name, values.intro);
      message.success('团队已创建');
      setCreating(false);
      form.resetFields();
      navigate(`/teams/${res.team.id}`);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="团队"
        description="你加入的团队。团队之上再挂作品集与作品。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            创建团队
          </Button>
        }
      />

      {teams.length === 0 && !loading ? (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text>还没有加入任何团队</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  用管理员给你的邀请码注册会自动入团；也可以自己创建一个。
                </Typography.Text>
              </Space>
            }
          />
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          {teams.map((team) => (
            <Col xs={24} sm={12} lg={8} key={team.id}>
              <Card
                hoverable
                loading={loading}
                onClick={() => navigate(`/teams/${team.id}`)}
                styles={{ body: { minHeight: 132 } }}
              >
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Typography.Text strong>{team.name}</Typography.Text>
                    <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
                      {team.myRole.name}
                    </Tag>
                  </Space>
                  <Typography.Paragraph
                    type="secondary"
                    style={{ fontSize: 12, marginBottom: 0, minHeight: 34 }}
                    ellipsis={{ rows: 2 }}
                  >
                    {team.intro || '（暂无简介）'}
                  </Typography.Paragraph>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {team.memberCount} 位成员
                  </Typography.Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Modal
        title="创建团队"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleCreate} requiredMark={false}>
          <Form.Item
            name="name"
            label="团队名称"
            rules={[
              { required: true, message: '请输入团队名称' },
              { min: 2, max: 32, message: '团队名称长度需为 2 ~ 32 个字符' },
            ]}
          >
            <Input placeholder="例如：夏莱烤肉屋" />
          </Form.Item>
          <Form.Item name="intro" label="简介（可选）">
            <Input.TextArea rows={3} maxLength={200} showCount placeholder="一句话介绍这个团队" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
