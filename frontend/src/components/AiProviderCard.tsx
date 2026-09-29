/**
 * 「我的模型配置」卡片（个人资料页）。
 *
 * 每个用户配自己的 key：机翻是谁点谁付费，共享一份 key 会让「额度被谁用完」无从追查。
 * 界面上有三条不能省的提示：
 *  - key 只显示末 4 位，**任何时候都不回显明文**；
 *  - 出口留空 = 直连（自建模型多在内网，跟随站点代理反而连不上）；
 *  - 识图模型与对话模型是两件事，只配一个的话对应的按钮会明确拒绝。
 */
import { DeleteOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Form, Input, Modal, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { aiApi, type AiProvider } from '../api/ai';

export function AiProviderCard() {
  const { message } = AntApp.useApp();
  const [rows, setRows] = useState<AiProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [proxyConfigured, setProxyConfigured] = useState(false);
  const [editing, setEditing] = useState<AiProvider | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  async function reload() {
    setLoading(true);
    try {
      const data = await aiApi.providers();
      setRows(data.providers);
      setProxyConfigured(data.site.defaultProxyConfigured);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        baseUrl: values.baseUrl,
        chatModel: values.chatModel ?? '',
        visionModel: values.visionModel ?? '',
        proxyUrl: values.proxyUrl ?? '',
        isDefault: values.isDefault ?? false,
        // 编辑时留空表示「不改动已存的 key」，所以只在填了东西时才带上这个字段
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      };
      if (editing === 'new') await aiApi.createProvider(payload);
      else if (editing) await aiApi.updateProvider(editing.id, payload);
      message.success('已保存');
      setEditing(null);
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      title={
        <Space>
          <RobotOutlined />
          AI 机翻模型
        </Space>
      }
      extra={
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => {
            form.resetFields();
            setEditing('new');
          }}
        >
          添加
        </Button>
      }
      loading={loading}
    >
      <Table<AiProvider>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={rows}
        locale={{ emptyText: '还没有配置模型。机翻与自动标号都需要一份 OpenAI 兼容的配置。' }}
        columns={[
          {
            title: '名称',
            dataIndex: 'name',
            render: (name: string, row) => (
              <Space size={6}>
                <span>{name}</span>
                {row.isDefault && <Tag color="blue">默认</Tag>}
                {!row.enabled && <Tag>已停用</Tag>}
              </Space>
            ),
          },
          { title: '接口地址', dataIndex: 'baseUrl', ellipsis: true },
          {
            title: '模型',
            render: (_, row) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                识别 {row.visionModel || '—'} / 对话 {row.chatModel || '—'}
              </Typography.Text>
            ),
          },
          {
            title: 'Key',
            render: (_, row) => (row.hasKey ? <Tag color="green">{row.credentials.apiKey}</Tag> : <Tag color="red">未填</Tag>),
          },
          {
            title: '',
            width: 120,
            render: (_, row) => (
              <Space size={4}>
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    form.setFieldsValue({ ...row, apiKey: '' });
                    setEditing(row);
                  }}
                >
                  编辑
                </Button>
                <Popconfirm title="删除这份配置？" onConfirm={() => aiApi.removeProvider(row.id).then(reload)}>
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        Key 加密存放，界面上只显示末 4 位。出口留空表示
        <Typography.Text strong>直连</Typography.Text>
        （自建/内网模型通常如此）
        {proxyConfigured && '；本站配了抓取代理，若你的模型在公网上，需要在「出口」里显式填同一个代理地址'}。
      </Typography.Paragraph>

      <Modal
        open={editing !== null}
        title={editing === 'new' ? '添加模型配置' : '编辑模型配置'}
        onCancel={() => setEditing(null)}
        onOk={save}
        confirmLoading={saving}
        okText="保存"
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '给它起个名字' }]}>
            <Input placeholder="例如：自建 one-api" maxLength={40} />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="接口地址（OpenAI 兼容）"
            rules={[{ required: true, message: '填完整的接口根地址' }]}
          >
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item name="visionModel" label="识图模型（自动标号用）">
            <Input placeholder="例如 gpt-4o-mini" />
          </Form.Item>
          <Form.Item name="chatModel" label="对话模型（机翻用）">
            <Input placeholder="例如 gpt-4o-mini" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key">
            <Input.Password placeholder={editing === 'new' ? 'sk-...' : '留空表示不改动'} autoComplete="off" />
          </Form.Item>
          <Form.Item name="proxyUrl" label="出口代理（留空 = 直连）">
            <Input placeholder="http://主机:端口" />
          </Form.Item>
          <Form.Item name="isDefault" label="设为默认" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
