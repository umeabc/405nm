/**
 * 工作台里的「AI」面板：自动标号 + 本页机翻。
 *
 * 设计上只有一条主张：**模型给的东西一定先摊在桌子上**。
 * 所以两个动作都走「提案 → 人看一眼、改一改、勾掉不要的 → 应用」，
 * 没有「一键静默写入」。代价是多点一下，换来的是：写进库的每一行都有人过目，
 * 而且机翻永远进的是候选位（不选中、不动别人的稿）。
 */
import { ExperimentOutlined, ThunderboltOutlined } from '@ant-design/icons';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Select,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { aiApi, type AiProvider, type MarkerProposal, type TranslationProposal } from '../api/ai';

type Mode = 'markers' | 'translations';

type MarkerRow = MarkerProposal & { key: string; include: boolean };
type TranslationRow = TranslationProposal & { key: string; include: boolean };

export function AiModal({
  fileId,
  targetId,
  targetLabel,
  dirty,
  sourceCount,
  onDone,
}: {
  fileId: string;
  targetId: string;
  targetLabel: string;
  /** 画布上有未保存的改动时先不让跑：模型写库与草稿叠加会让人分不清哪份是最新的 */
  dirty: boolean;
  sourceCount: number;
  onDone: () => void;
}) {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('translations');
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [providerId, setProviderId] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [markers, setMarkers] = useState<MarkerRow[]>([]);
  const [translations, setTranslations] = useState<TranslationRow[]>([]);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const data = await aiApi.providers();
        setProviders(data.providers);
        setProviderId((current) => current ?? data.providers.find((p) => p.isDefault)?.id ?? data.providers[0]?.id);
      } catch {
        /* 配置加载失败时下面会给出「没有配置」的提示，不额外弹错 */
      }
    })();
  }, [open]);

  function reset() {
    setMarkers([]);
    setTranslations([]);
    setNote('');
  }

  async function propose() {
    setRunning(true);
    reset();
    try {
      if (mode === 'markers') {
        const data = await aiApi.proposeMarkers(fileId, { providerId });
        setMarkers(data.proposals.map((p, i) => ({ ...p, key: `m${i}`, include: true })));
        setNote(
          `识别到 ${data.proposals.length} 处（已有 ${data.existing} 个标号；` +
            `与已有标号重叠跳过 ${data.skipped}，空文本丢弃 ${data.dropped}）`,
        );
      } else {
        const data = await aiApi.proposeTranslations(fileId, { targetId, providerId });
        setTranslations(data.proposals.map((p, i) => ({ ...p, key: `t${i}`, include: true })));
        setNote(
          `译了 ${data.proposals.length}/${data.requested} 条` +
            (data.missing ? `（模型漏了 ${data.missing} 条）` : '') +
            (data.glossary.length ? `；命中术语 ${data.glossary.length} 条` : ''),
        );
      }
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '调用失败');
    } finally {
      setRunning(false);
    }
  }

  async function apply() {
    setApplying(true);
    try {
      if (mode === 'markers') {
        const picked = markers
          .filter((m) => m.include && m.text.trim())
          .map(({ key, include, ...rest }) => rest);
        if (picked.length === 0) {
          message.warning('没有勾选任何标号');
          return;
        }
        const result = await aiApi.applyMarkers(fileId, picked);
        message.success(`已写入 ${result.created} 个标号`);
      } else {
        const picked = translations.filter((t) => t.include && t.translated.trim()).map((t) => ({ sourceId: t.sourceId, translated: t.translated }));
        if (picked.length === 0) {
          message.warning('没有勾选任何译文');
          return;
        }
        const result = await aiApi.applyTranslations(fileId, { targetId, items: picked });
        const skipNote = result.skipped.length ? `，跳过 ${result.skipped.length} 条（你自己的稿子或已选中的）` : '';
        message.success(`新增 ${result.created} 条、更新 ${result.updated} 条机翻候选${skipNote}`);
      }
      setOpen(false);
      reset();
      onDone();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '应用失败');
    } finally {
      setApplying(false);
    }
  }

  const noProvider = providers.length === 0;

  return (
    <>
      <Tooltip title={dirty ? '先保存当前改动' : '自动标号 / 机翻本页'}>
        <Button
          size="small"
          icon={<ThunderboltOutlined />}
          disabled={dirty}
          onClick={() => {
            setMode(sourceCount === 0 ? 'markers' : 'translations');
            setOpen(true);
          }}
        >
          AI
        </Button>
      </Tooltip>

      <Modal
        open={open}
        title="AI 机翻"
        width={860}
        onCancel={() => setOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setOpen(false)}>关闭</Button>
            <Button type="primary" loading={applying} disabled={running} onClick={apply}>
              应用勾选的结果
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Segmented
              value={mode}
              onChange={(value) => {
                setMode(value as Mode);
                reset();
              }}
              options={[
                { label: '识别标号', value: 'markers' },
                { label: `机翻本页（${targetLabel}）`, value: 'translations' },
              ]}
            />
            {providers.length > 1 && (
              <Select
                size="small"
                style={{ width: 160 }}
                value={providerId}
                onChange={setProviderId}
                options={providers.map((p) => ({ value: p.id, label: p.name }))}
              />
            )}
            <Button size="small" type="primary" loading={running} disabled={noProvider} onClick={propose}>
              生成提案
            </Button>
            {note && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {note}
              </Typography.Text>
            )}
          </Space>

          {noProvider && (
            <Alert
              type="info"
              showIcon
              message="还没有模型配置"
              description="到「个人资料 → AI 机翻模型」里添加一份 OpenAI 兼容的配置（接口地址、Key、识图模型、对话模型）后即可使用。"
            />
          )}

          {mode === 'markers' && markers.length > 0 && (
            <Table<MarkerRow>
              rowKey="key"
              size="small"
              pagination={false}
              scroll={{ y: 380 }}
              dataSource={markers}
              columns={[
                {
                  title: '',
                  width: 40,
                  render: (_, row) => (
                    <Checkbox
                      checked={row.include}
                      onChange={(e) =>
                        setMarkers((prev) => prev.map((m) => (m.key === row.key ? { ...m, include: e.target.checked } : m)))
                      }
                    />
                  ),
                },
                {
                  title: '原文',
                  render: (_, row) => (
                    <Input
                      size="small"
                      value={row.text}
                      onChange={(e) =>
                        setMarkers((prev) => prev.map((m) => (m.key === row.key ? { ...m, text: e.target.value } : m)))
                      }
                    />
                  ),
                },
                {
                  title: '类型',
                  width: 90,
                  render: (_, row) => (
                    <Select
                      size="small"
                      value={row.positionType}
                      style={{ width: 74 }}
                      onChange={(value) =>
                        setMarkers((prev) => prev.map((m) => (m.key === row.key ? { ...m, positionType: value } : m)))
                      }
                      options={[
                        { value: 'in', label: '框内' },
                        { value: 'out', label: '框外' },
                      ]}
                    />
                  ),
                },
                {
                  title: '位置（归一化）',
                  width: 230,
                  render: (_, row) => (
                    <Space size={4}>
                      <InputNumber
                        size="small"
                        step={0.01}
                        min={0}
                        max={1}
                        value={Number(row.x.toFixed(4))}
                        onChange={(v) => setMarkers((prev) => prev.map((m) => (m.key === row.key ? { ...m, x: Number(v ?? 0) } : m)))}
                      />
                      <InputNumber
                        size="small"
                        step={0.01}
                        min={0}
                        max={1}
                        value={Number(row.y.toFixed(4))}
                        onChange={(v) => setMarkers((prev) => prev.map((m) => (m.key === row.key ? { ...m, y: Number(v ?? 0) } : m)))}
                      />
                    </Space>
                  ),
                },
              ]}
            />
          )}

          {mode === 'translations' && translations.length > 0 && (
            <Table<TranslationRow>
              rowKey="key"
              size="small"
              pagination={false}
              scroll={{ y: 380 }}
              dataSource={translations}
              columns={[
                {
                  title: '',
                  width: 40,
                  render: (_, row) => (
                    <Checkbox
                      checked={row.include}
                      onChange={(e) =>
                        setTranslations((prev) => prev.map((t) => (t.key === row.key ? { ...t, include: e.target.checked } : t)))
                      }
                    />
                  ),
                },
                { title: '原文', dataIndex: 'original', width: 260 },
                {
                  title: '机翻候选',
                  render: (_, row) => (
                    <Input
                      size="small"
                      value={row.translated}
                      onChange={(e) =>
                        setTranslations((prev) => prev.map((t) => (t.key === row.key ? { ...t, translated: e.target.value } : t)))
                      }
                    />
                  ),
                },
                {
                  title: '术语',
                  width: 140,
                  render: (_, row) =>
                    row.terms.length ? (
                      <Space size={2} wrap>
                        {row.terms.map((t) => (
                          <Tag key={t} color="blue" style={{ fontSize: 11 }}>
                            {t}
                          </Tag>
                        ))}
                      </Space>
                    ) : null,
                },
              ]}
            />
          )}

          {mode === 'translations' && translations.length > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <ExperimentOutlined /> 应用后写入的是
              <Typography.Text strong>机翻候选</Typography.Text>
              （标记为机翻、默认不选中），你自己写过或已经被选中的那条不会被覆盖。
            </Typography.Text>
          )}
        </Space>
      </Modal>
    </>
  );
}
