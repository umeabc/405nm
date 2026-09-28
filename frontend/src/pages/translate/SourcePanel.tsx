import { DeleteOutlined, EnvironmentOutlined } from '@ant-design/icons';
import { Button, Empty, Input, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useRef } from 'react';
import { checkText, type PositionType } from '@405nm/shared';
import type { SourceWithTranslations } from '../../api/client';
import { palette } from '../../theme';
import { MARKER_FILL, MARKER_TEXT } from './Canvas';

/**
 * 右侧标号列表与译文输入。
 *
 * 一屏里同时有 N 个输入框，所以两个性能上的细节很重要：
 *  1. **只有被聚焦的那一个受控**：其余输入框用非受控的 defaultValue，
 *     否则每敲一个字都会让整列重渲染，标号多的时候输入会明显发涩。
 *  2. **滚动定位用 ref 直接 scrollIntoView**，不走状态 ——
 *     「点画布上的标号 → 右侧滚过去」这个动作要立刻发生。
 */

export type SourcePanelProps = {
  sources: SourceWithTranslations[];
  /** 正在编辑的译文（sourceId → 文本），未提交的改动都在这里 */
  drafts: Record<string, string>;
  onDraftChange: (sourceId: string, value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (sourceId: string) => void;
  /** 原文可否编辑 */
  canEditSource: boolean;
  onSourceTextChange: (sourceId: string, value: string) => void;
  /** 改框内 / 框外。画布上用左右键决定，这里给一个不用记键位的入口。 */
  onPositionTypeChange: (sourceId: string, positionType: PositionType) => void;
  mode: 'translate' | 'proofread';
  canDelete: boolean;
};

/** 框内 / 框外的中文名。画布图例与这里必须用同一套说法。 */
export const POSITION_LABEL: Record<PositionType, string> = { in: '框内', out: '框外' };

export function SourcePanel({
  sources,
  drafts,
  onDraftChange,
  selectedId,
  onSelect,
  onDelete,
  canEditSource,
  onSourceTextChange,
  onPositionTypeChange,
  mode,
  canDelete,
}: SourcePanelProps) {
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  // 选中项变化时滚到可见处。放在 effect 里而不是点击处理里，
  // 是因为画布上的点选与列表里的点选走的是同一条路。
  useEffect(() => {
    if (!selectedId) return;
    itemRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  if (sources.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        style={{ marginTop: 40 }}
        description={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            这张图还没有标号。左键点画面 = 框内，右键点 = 框外。
          </Typography.Text>
        }
      />
    );
  }

  return (
    <div className="nm-source-list">
      {sources.map((source, index) => {
        const selected = source.id === selectedId;
        const value = drafts[source.id] ?? '';
        const issues = mode === 'proofread' ? checkText(value) : [];
        const status = statusOf(source, mode);

        return (
          <div
            key={source.id}
            ref={(element) => {
              if (element) itemRefs.current.set(source.id, element);
              else itemRefs.current.delete(source.id);
            }}
            className={`nm-source-item${selected ? ' is-selected' : ''}`}
            onMouseDown={() => onSelect(source.id)}
          >
            <div className="nm-source-head">
              <Space size={6}>
                <Tag color={selected ? palette.primary : undefined} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  {index + 1}
                </Tag>
                {/* 点一下就能换框内/框外。画布上是左右键，但那个键位不写在脸上 ——
                    这里给一个不用记的入口，也让「当前是框内还是框外」始终可见。 */}
                <Tooltip
                  title={
                    canEditSource
                      ? `当前是${POSITION_LABEL[source.positionType]}，点击切换`
                      : `当前是${POSITION_LABEL[source.positionType]}`
                  }
                >
                  <Tag
                    style={{
                      marginInlineEnd: 0,
                      fontSize: 11,
                      cursor: canEditSource ? 'pointer' : 'default',
                      color: MARKER_TEXT[source.positionType],
                      // 与画布上的标记同色：列表里一眼就能和画面上的点对上。
                      background: MARKER_FILL[source.positionType],
                      borderColor: 'transparent',
                    }}
                    onClick={
                      canEditSource
                        ? (event) => {
                            event.stopPropagation();
                            onPositionTypeChange(source.id, source.positionType === 'in' ? 'out' : 'in');
                          }
                        : undefined
                    }
                  >
                    {POSITION_LABEL[source.positionType]}
                  </Tag>
                </Tooltip>
                <StatusTag status={status} />
                {source.translations.length > 1 ? (
                  <Tooltip title={`这个标号有 ${source.translations.length} 份候选译文`}>
                    <Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>{source.translations.length} 份候选</Tag>
                  </Tooltip>
                ) : null}
              </Space>

              <Space size={2}>
                <Tooltip title="在画布上定位">
                  <Button
                    size="small"
                    type="text"
                    icon={<EnvironmentOutlined />}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(source.id);
                    }}
                  />
                </Tooltip>
                {canDelete ? (
                  <Popconfirm
                    title="删除这个标号？"
                    description="它下面的译文也会一起删除。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => onDelete(source.id)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={(e) => e.stopPropagation()} />
                  </Popconfirm>
                ) : null}
              </Space>
            </div>

            {source.content || canEditSource ? (
              <Input
                size="small"
                variant="borderless"
                className="nm-source-origin"
                // 非受控：原文很少改，没必要为它引入受控的渲染开销。
                defaultValue={source.content}
                readOnly={!canEditSource}
                placeholder="（原文留空）"
                onBlur={(event) => {
                  if (canEditSource && event.target.value !== source.content) {
                    onSourceTextChange(source.id, event.target.value);
                  }
                }}
              />
            ) : null}

            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              value={value}
              placeholder={mode === 'proofread' ? '校对后的文本…' : '译文…'}
              onChange={(event) => onDraftChange(source.id, event.target.value)}
              onFocus={() => onSelect(source.id)}
            />

            {issues.length > 0 ? (
              <div className="nm-source-issues">
                {issues.slice(0, 3).map((issue, i) => (
                  <Typography.Text
                    key={`${issue.code}-${i}`}
                    type={issue.severity === 'error' ? 'danger' : 'warning'}
                    style={{ fontSize: 11, display: 'block' }}
                  >
                    · {issue.message}
                  </Typography.Text>
                ))}
              </div>
            ) : null}

            {source.note ? (
              <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                备注：{source.note}
              </Typography.Text>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

type Status = 'empty' | 'translated' | 'proofread' | 'stale';

function statusOf(source: SourceWithTranslations, mode: 'translate' | 'proofread'): Status {
  const selected = source.selected;
  if (!selected) return 'empty';
  if (!selected.content.trim()) return 'empty';
  if (selected.proofreadContent.trim()) return 'proofread';
  // 校对稿与译文一致时不必再标「已校对」—— 那只是「看过了，没改」，
  // 与「改过」在进度上是一回事，但在界面上区分开更有信息量。
  return mode === 'proofread' ? 'stale' : 'translated';
}

function StatusTag({ status }: { status: Status }) {
  const map: Record<Status, { text: string; color?: string }> = {
    empty: { text: '未翻译' },
    translated: { text: '已翻译', color: palette.success },
    proofread: { text: '已校对', color: palette.primary },
    stale: { text: '未校对' },
  };
  const meta = map[status];
  return (
    <Tag color={meta.color} style={{ marginInlineEnd: 0, fontSize: 11 }}>
      {meta.text}
    </Tag>
  );
}
