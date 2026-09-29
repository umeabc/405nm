import {
  AimOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  DownOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Empty, Input, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useRef } from 'react';
import { checkText, type PositionType } from '@405nm/shared';
import type { SourceWithTranslations, TranslationRow } from '../../api/client';
import { MARKER_FILL, MARKER_TEXT } from './Canvas';

/**
 * 右侧标号列表与译文输入 —— Comiku 卡片式风格。
 *
 * 视觉规范对齐 https://comiku-preview.vercel.app：
 *  - 顶部标号总览与计数；
 *  - 每格独立卡片（圆角 14px，淡雅边框，选中时带柔和紫色阴影）；
 *  - 头部：两位数序号药丸（01、02...）、框内/外切换下拉胶囊、状态徽标、操作图标；
 *  - 中间：浅灰底原文框（支持 OCR 原文展示与编辑）；
 *  - 底部：译文输入域、AI 候选采纳条、排版规范检查提示。
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

  useEffect(() => {
    if (!selectedId) return;
    itemRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  if (sources.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        style={{ marginTop: 60 }}
        description={
          <div style={{ textAlign: 'center' }}>
            <Typography.Text strong style={{ fontSize: 13, color: 'var(--nm-ink)' }}>
              当前页面暂无标号
            </Typography.Text>
            <div style={{ fontSize: 12, color: 'var(--nm-ink-soft)', marginTop: 4 }}>
              左键点击画面添加框内标号，右键添加框外标号
            </div>
          </div>
        }
      />
    );
  }

  return (
    <div className="nm-source-list">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 2px 10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--nm-ink)' }}>标号与译文</span>
          <span className="cm-source-num-badge" style={{ fontSize: 11, padding: '1px 6px' }}>
            {sources.length} 处
          </span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--nm-ink-soft)' }}>按 Ctrl+S 快速保存</div>
      </div>

      {sources.map((source, index) => {
        const selected = source.id === selectedId;
        const value = drafts[source.id] ?? '';
        const issues = mode === 'proofread' ? checkText(value) : [];
        const status = statusOf(source, mode);
        const numStr = String(index + 1).padStart(2, '0');

        // 筛选 AI 机翻或其它候选（排队或已有的不同于当前选中译文的草稿）
        const candidates = source.translations.filter(
          (t) => t.content && t.content !== value && t.content !== source.selected?.content,
        );

        return (
          <div
            key={source.id}
            ref={(element) => {
              if (element) itemRefs.current.set(source.id, element);
              else itemRefs.current.delete(source.id);
            }}
            className={`cm-source-item-card${selected ? ' is-selected' : ''}`}
            onMouseDown={() => onSelect(source.id)}
          >
            {/* ── 卡片头部 ────────────────────────────────────── */}
            <div className="cm-source-card-head">
              <Space size={6} align="center">
                <span className="cm-source-num-badge" style={{ minWidth: 26, textAlign: 'center' }}>
                  {numStr}
                </span>

                {/* 框内/框外下拉切换 */}
                {canEditSource ? (
                  <Dropdown
                    trigger={['click']}
                    menu={{
                      items: [
                        { key: 'in', label: '框内文字' },
                        { key: 'out', label: '框外旁白 / 拟音' },
                      ],
                      onClick: ({ key }) => onPositionTypeChange(source.id, key as PositionType),
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 3,
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        color: MARKER_TEXT[source.positionType],
                        background: MARKER_FILL[source.positionType],
                        userSelect: 'none',
                      }}
                    >
                      <span>{POSITION_LABEL[source.positionType]}</span>
                      <DownOutlined style={{ fontSize: 9 }} />
                    </span>
                  </Dropdown>
                ) : (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 6,
                      color: MARKER_TEXT[source.positionType],
                      background: MARKER_FILL[source.positionType],
                    }}
                  >
                    {POSITION_LABEL[source.positionType]}
                  </span>
                )}

                <StatusTag status={status} />
              </Space>

              <Space size={2}>
                <Tooltip title="在画布上定位">
                  <Button
                    size="small"
                    type="text"
                    icon={<AimOutlined style={{ fontSize: 13 }} />}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(source.id);
                    }}
                  />
                </Tooltip>
                {canDelete ? (
                  <Popconfirm
                    title="删除这个标号？"
                    description="该标号的原文及所有译文也将一同移除。"
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => onDelete(source.id)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined style={{ fontSize: 13 }} />}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </Popconfirm>
                ) : null}
              </Space>
            </div>

            {/* ── 原文展示与编辑 ──────────────────────────────── */}
            {source.content || canEditSource ? (
              <div className="cm-source-origin-box">
                <Input
                  size="small"
                  variant="borderless"
                  style={{ padding: 0, fontSize: 12, color: 'inherit' }}
                  defaultValue={source.content}
                  readOnly={!canEditSource}
                  placeholder="（原文留空）"
                  onBlur={(event) => {
                    if (canEditSource && event.target.value !== source.content) {
                      onSourceTextChange(source.id, event.target.value);
                    }
                  }}
                />
              </div>
            ) : null}

            {/* ── 译文输入框 ─────────────────────────────────── */}
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              value={value}
              style={{
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.6,
                padding: '8px 10px',
              }}
              placeholder={mode === 'proofread' ? '校对后的文本…' : '输入译文…'}
              onChange={(event) => onDraftChange(source.id, event.target.value)}
              onFocus={() => onSelect(source.id)}
            />

            {/* ── 候选译文 / AI 机翻采纳条 ───────────────────── */}
            {candidates.length > 0 ? (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {candidates.slice(0, 2).map((cand) => (
                  <CandidateRow
                    key={cand.id}
                    candidate={cand}
                    onApply={(text) => onDraftChange(source.id, text)}
                  />
                ))}
              </div>
            ) : null}

            {/* ── 排版与标点规范警告 ─────────────────────────── */}
            {issues.length > 0 ? (
              <div className="nm-source-issues" style={{ marginTop: 6 }}>
                {issues.slice(0, 3).map((issue, i) => (
                  <Typography.Text
                    key={`${issue.code}-${i}`}
                    type={issue.severity === 'error' ? 'danger' : 'warning'}
                    style={{ fontSize: 11, display: 'block', lineHeight: 1.4 }}
                  >
                    • {issue.message}
                  </Typography.Text>
                ))}
              </div>
            ) : null}

            {source.note ? (
              <div style={{ fontSize: 11, color: 'var(--nm-ink-soft)', marginTop: 4 }}>
                备注：{source.note}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function CandidateRow({
  candidate,
  onApply,
}: {
  candidate: TranslationRow;
  onApply: (text: string) => void;
}) {
  const isAi = candidate.machineTranslated;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: isAi ? '#f5f3ff' : '#f8fafc',
        border: `1px dashed ${isAi ? '#c4b5fd' : '#e2e8f0'}`,
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 11,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '78%',
          color: isAi ? '#6d28d9' : 'var(--nm-ink)',
        }}
        title={candidate.content}
      >
        {isAi ? <RobotOutlined style={{ fontSize: 11 }} /> : null}
        <span>{isAi ? 'AI 机翻' : candidate.displayName}:</span>
        <span style={{ fontWeight: 500 }}>{candidate.content}</span>
      </div>
      <Button
        size="small"
        type="link"
        icon={<CheckCircleOutlined style={{ fontSize: 11 }} />}
        style={{ padding: '0 4px', fontSize: 11, height: 20 }}
        onClick={() => onApply(candidate.content)}
      >
        采纳
      </Button>
    </div>
  );
}

type Status = 'empty' | 'translated' | 'proofread' | 'stale';

function statusOf(source: SourceWithTranslations, mode: 'translate' | 'proofread'): Status {
  const selected = source.selected;
  if (!selected) return 'empty';
  if (!selected.content.trim()) return 'empty';
  if (selected.proofreadContent.trim()) return 'proofread';
  return mode === 'proofread' ? 'stale' : 'translated';
}

function StatusTag({ status }: { status: Status }) {
  const map: Record<Status, { text: string; bg: string; color: string; border: string }> = {
    empty: { text: '未翻译', bg: '#f3f4f6', color: '#6b7280', border: '#e5e7eb' },
    translated: { text: '已翻译', bg: '#ecfdf5', color: '#059669', border: '#a7f3d0' },
    proofread: { text: '已校对', bg: '#f5f3ff', color: '#7c3aed', border: '#ddd6fe' },
    stale: { text: '待校对', bg: '#fffbeb', color: '#d97706', border: '#fde68a' },
  };
  const meta = map[status];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: 4,
        background: meta.bg,
        color: meta.color,
        border: `1px solid ${meta.border}`,
      }}
    >
      {meta.text}
    </span>
  );
}
