import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { ApiError, projectApi, type LanguageOption, type ProjectTarget } from '../../api/client';
import { comiku } from '../../theme';
import type { ProjectTabProps } from './index';

/**
 * 目标语言。
 *
 * 这是**译文归属的维度**：每种语言下面各自有一份译文与进度，
 * 所以删掉一种语言等于删掉那一整套译文 —— 因此删除是危险操作，
 * 确认框里必须把这件事说清楚，而不是含糊地说「确定删除吗」。
 * 源语言不在这个列表里：它是作品的属性，不是目标。
 */
export function TargetsTab({ detail, reload, can }: ProjectTabProps) {
  const { message } = AntApp.useApp();
  const projectId = detail.project.id;

  const [languages, setLanguages] = useState<LanguageOption[]>([]);
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<{ language: string; label?: string }>();

  useEffect(() => {
    void projectApi
      .languages()
      .then((res) => setLanguages(res.languages))
      .catch(() => undefined);
  }, []);

  const sourceLanguage = detail.project.sourceLanguage;
  const taken = new Set(detail.targets.map((t) => t.language));

  async function submitAdd(values: { language: string; label?: string }) {
    setSubmitting(true);
    try {
      await projectApi.addTarget(projectId, values.language, values.label);
      message.success('已添加目标语言');
      setAdding(false);
      form.resetFields();
      void reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setSubmitting(false);
    }
  }

  const columns: ColumnsType<ProjectTarget> = [
    {
      title: '语言',
      key: 'language',
      render: (_, row) => (
        <Space size={8}>
          <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
            {row.label}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.language}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'kind',
      render: () => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          译文与进度在 M3 接入
        </Typography.Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      render: (_, row) =>
        can('target.delete') ? (
          <Popconfirm
            title={`删除「${row.label}」？`}
            description="该语言下的全部译文也会一并删除，且无法恢复。"
            okText="删除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() =>
              void projectApi
                .removeTarget(projectId, row.id)
                .then(() => {
                  message.success('已删除');
                  void reload();
                })
                .catch((err) => message.error(err instanceof ApiError ? err.message : '删除失败'))
            }
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  return (
    <Card
      title={`目标语言（${detail.targets.length}）`}
      extra={
        can('target.add') ? (
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
            新增语言
          </Button>
        ) : null
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        源语言是 <Tag style={{ marginInlineEnd: 0 }}>{sourceLanguage}</Tag>，
        它由作品资料决定，不在下面的目标列表里。
        每种目标语言各自保存一份译文，互不干扰。
      </Typography.Paragraph>

      <Table rowKey="id" columns={columns} dataSource={detail.targets} pagination={false} size="small" />

      <Modal
        title="新增目标语言"
        open={adding}
        onCancel={() => setAdding(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        okText="添加"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={submitAdd} requiredMark={false}>
          <Form.Item name="language" label="语言" rules={[{ required: true, message: '请选择语言' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="选择一种语言"
              options={languages
                .filter((l) => l.code !== sourceLanguage && !taken.has(l.code))
                .map((l) => ({ value: l.code, label: `${l.label}（${l.code}）` }))}
            />
          </Form.Item>
          <Form.Item name="label" label="显示名（可选）" extra="留空则用语言的默认名称">
            <Input maxLength={40} placeholder="例如：简体中文" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
