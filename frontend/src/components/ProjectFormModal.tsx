import { App as AntApp, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  projectApi,
  type LanguageOption,
  type ProjectCard,
  type ProjectSetRow,
} from '../api/client';

/**
 * 新建 / 编辑作品。
 *
 * 同一个表单承担两种用途，是因为两者的字段几乎完全重合 ——
 * 拆成两个组件的话，「源语言不能与目标语言重复」这类规则就要写两遍，
 * 而两遍里必然有一遍会被忘记更新。
 *
 * 编辑态**不允许改目标语言**：目标语言一旦有了译文就涉及数据归属
 * （译文挂在语言上），改语言的正确做法是加一种、而不是重命名一种。
 */

export type ProjectFormModalProps = {
  open: boolean;
  mode: 'create' | 'edit';
  /** 新建时必填 */
  teamId: string;
  /** 编辑时必填 */
  project?: ProjectCard | null;
  onClose: () => void;
  onSaved: (project: { id: string; name: string; serial?: number }) => void;
};

type FormValues = {
  name: string;
  author?: string;
  intro?: string;
  sourceLanguage: string;
  targetLanguages: string[];
  setId?: string | null;
};

export function ProjectFormModal({ open, mode, teamId, project, onClose, onSaved }: ProjectFormModalProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<FormValues>();
  const [languages, setLanguages] = useState<LanguageOption[]>([]);
  const [sets, setSets] = useState<ProjectSetRow[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const loadOptions = useCallback(async () => {
    try {
      const [langRes, setRes] = await Promise.all([projectApi.languages(), projectApi.sets(teamId)]);
      setLanguages(langRes.languages);
      setSets(setRes.sets);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '选项加载失败');
    }
  }, [message, teamId]);

  useEffect(() => {
    if (!open) return;
    void loadOptions();
  }, [open, loadOptions]);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && project) {
      form.setFieldsValue({
        name: project.name,
        author: project.author,
        intro: project.intro,
        sourceLanguage: project.sourceLanguage,
        targetLanguages: [],
        setId: project.setId,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({ sourceLanguage: 'ja', targetLanguages: ['zh-CN'] });
    }
  }, [open, mode, project, form]);

  async function submit(values: FormValues) {
    setSubmitting(true);
    try {
      if (mode === 'create') {
        const res = await projectApi.create(teamId, {
          name: values.name,
          intro: values.intro,
          author: values.author,
          sourceLanguage: values.sourceLanguage,
          setId: values.setId ?? null,
          targetLanguages: values.targetLanguages,
        });
        message.success(`作品「${res.project.name}」已创建`);
        onSaved({ id: res.project.id, name: res.project.name, serial: res.project.serial });
      } else if (project) {
        await projectApi.update(project.id, {
          name: values.name,
          intro: values.intro,
          author: values.author,
          sourceLanguage: values.sourceLanguage,
          setId: values.setId ?? null,
        });
        message.success('已保存');
        onSaved({ id: project.id, name: values.name });
      }
      onClose();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSubmitting(false);
    }
  }

  const languageOptions = languages.map((l) => ({ value: l.code, label: `${l.label}（${l.code}）` }));

  return (
    <Modal
      open={open}
      title={mode === 'create' ? '新建作品' : '作品资料'}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      okText={mode === 'create' ? '创建' : '保存'}
      cancelText="取消"
      destroyOnHidden
      width={520}
    >
      <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
        <Form.Item
          name="name"
          label="作品名"
          rules={[{ required: true, message: '请填写作品名' }, { max: 120, message: '最多 120 个字符' }]}
        >
          <Input placeholder="例如：夜行猫" autoFocus />
        </Form.Item>

        <Form.Item name="author" label="原作者（可选）">
          <Input placeholder="署名行会用到" maxLength={80} />
        </Form.Item>

        <Form.Item name="setId" label="所属作品集（可选）">
          <Select
            allowClear
            placeholder="不归类"
            options={sets.map((s) => ({ value: s.id, label: s.name }))}
            notFoundContent="该团队还没有作品集"
          />
        </Form.Item>

        <Form.Item name="sourceLanguage" label="源语言" rules={[{ required: true, message: '请选择源语言' }]}>
          <Select options={languageOptions} showSearch optionFilterProp="label" />
        </Form.Item>

        {mode === 'create' ? (
          <Form.Item
            name="targetLanguages"
            label="目标语言"
            rules={[{ required: true, message: '至少选一种目标语言' }]}
            extra="决定译文按哪种语言分开存放，创建后可以再加。"
          >
            <Select mode="multiple" options={languageOptions} optionFilterProp="label" />
          </Form.Item>
        ) : (
          <Form.Item label="目标语言">
            <Space direction="vertical" size={2} style={{ width: '100%' }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                在作品页的「目标语言」里增删。这里不能改 —— 译文是挂在语言上的，
                重命名语言会让已有译文归属不明。
              </Typography.Text>
            </Space>
          </Form.Item>
        )}

        <Form.Item name="intro" label="简介（可选）">
          <Input.TextArea rows={3} maxLength={2000} showCount />
        </Form.Item>
      </Form>
    </Modal>
  );
}
