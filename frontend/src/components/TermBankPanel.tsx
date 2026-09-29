/**
 * 团队术语库。术语是**团队资产**：同一部作品谁翻都该用同一套译名。
 *
 * 一条设计上的取舍：批量导入用「粘贴文本、一行一条」，不做 CSV 上传。
 * 术语多半是从聊天记录或表格里直接贴过来的，要求人先整理成文件只会让人不用它。
 */
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { ApiError, projectApi } from '../api/client';
import { termApi, type TermBank, type TermRow } from '../api/ai';

type Language = { code: string; label: string };

export function TermBankPanel({ teamId, canCreate, canEdit }: { teamId: string; canCreate: boolean; canEdit: boolean }) {
  const { message } = AntApp.useApp();
  const [banks, setBanks] = useState<TermBank[]>([]);
  const [activeBank, setActiveBank] = useState<string>('');
  const [rows, setRows] = useState<TermRow[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [language, setLanguage] = useState('zh-CN');
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [form] = Form.useForm();
  const [importForm] = Form.useForm();

  useEffect(() => {
    void (async () => {
      try {
        const [data, langs] = await Promise.all([termApi.banks(teamId), projectApi.languages()]);
        setBanks(data.banks);
        setLanguages(langs.languages);
        setActiveBank((current) => current || (data.banks[0]?.id ?? ''));
      } catch (err) {
        message.error(err instanceof ApiError ? err.message : '加载术语库失败');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  useEffect(() => {
    if (!activeBank) {
      setRows([]);
      return;
    }
    setLoading(true);
    void termApi
      .terms(activeBank, { language, ...(keyword ? { q: keyword } : {}) })
      .then((data) => setRows(data.terms))
      .catch((err) => message.error(err instanceof ApiError ? err.message : '加载失败'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBank, language, keyword]);

  async function reloadBanks() {
    const data = await termApi.banks(teamId);
    setBanks(data.banks);
    if (!data.banks.some((b) => b.id === activeBank)) setActiveBank(data.banks[0]?.id ?? '');
  }

  return (
    <Card
      title="术语库"
      extra={
        canCreate && (
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setCreating(true);
            }}
          >
            新建
          </Button>
        )
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          size="small"
          style={{ minWidth: 180 }}
          value={activeBank || undefined}
          placeholder="选择术语库"
          onChange={setActiveBank}
          options={banks.map((b) => ({ value: b.id, label: `${b.name}（${b.termCount} 条）` }))}
        />
        <Select
          size="small"
          style={{ width: 150 }}
          value={language}
          onChange={setLanguage}
          options={languages.map((l) => ({ value: l.code, label: l.label }))}
        />
        <Input.Search size="small" allowClear placeholder="搜原文" style={{ width: 180 }} onSearch={setKeyword} />
        {canEdit && (
          <Button
            size="small"
            onClick={() => {
              importForm.setFieldsValue({ language, text: '' });
              setImporting(true);
            }}
            disabled={!activeBank}
          >
            批量导入
          </Button>
        )}
        {canEdit && activeBank && (
          <Popconfirm
            title="删除整个术语库？"
            onConfirm={() =>
              termApi.removeBank(activeBank).then(() => {
                message.success('已删除');
                return reloadBanks();
              })
            }
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        )}
      </Space>

      {banks.length === 0 ? (
        <Empty description="还没有术语库。建一个，机翻时命中术语会优先使用你指定的译法。" />
      ) : (
        <Table<TermRow>
          rowKey="id"
          size="small"
          loading={loading}
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          dataSource={rows}
          columns={[
            { title: '原文', dataIndex: 'source' },
            { title: '译文', dataIndex: 'target' },
            { title: '语言', dataIndex: 'language', width: 100 },
            {
              title: '',
              width: 50,
              render: (_, row) =>
                canEdit && (
                  <Popconfirm title="删除这条术语？" onConfirm={() => termApi.removeTerm(row.id).then(() => termApi.terms(activeBank, { language }).then((d) => setRows(d.terms)))}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ),
            },
          ]}
        />
      )}

      <Modal
        open={creating}
        title="新建术语库"
        onCancel={() => setCreating(false)}
        onOk={async () => {
          const values = await form.validateFields();
          try {
            const created = await termApi.createBank(teamId, values);
            message.success('已创建');
            setCreating(false);
            await reloadBanks();
            setActiveBank(created.bank.id);
          } catch (err) {
            message.error(err instanceof ApiError ? err.message : '创建失败');
          }
        }}
        okText="创建"
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '起个名字' }]}>
            <Input placeholder="例如：本作专有名词" maxLength={60} />
          </Form.Item>
          <Form.Item name="intro" label="说明">
            <Input maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={importing}
        title="批量导入术语"
        onCancel={() => setImporting(false)}
        onOk={async () => {
          const values = await importForm.validateFields();
          try {
            const result = await termApi.addTerms(activeBank, values);
            message.success(`已导入 ${result.count} 条`);
            setImporting(false);
            setLanguage(values.language);
            await reloadBanks();
          } catch (err) {
            message.error(err instanceof ApiError ? err.message : '导入失败');
          }
        }}
        okText="导入"
        destroyOnClose
      >
        <Form form={importForm} layout="vertical" requiredMark={false}>
          <Form.Item name="language" label="目标语言" rules={[{ required: true, message: '选择目标语言' }]}>
            <Select options={languages.map((l) => ({ value: l.code, label: l.label }))} />
          </Form.Item>
          <Form.Item
            name="text"
            label="一行一条"
            extra="原文与译文之间用制表符、=> 或逗号分隔；以 # 开头的行会被忽略。同样的原文再次导入会覆盖译文。"
            rules={[{ required: true, message: '粘贴几行术语' }]}
          >
            <Input.TextArea rows={8} placeholder={'魔王\t魔王大人\nこれは => 这是'} />
          </Form.Item>
        </Form>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          机翻时只会带上
          <Typography.Text strong>这一批原文里出现过</Typography.Text>
          的词（长词优先），不会把整库塞给模型。
        </Typography.Text>
      </Modal>
    </Card>
  );
}
