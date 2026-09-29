import { PictureOutlined, RightOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import { useNavigate } from 'react-router-dom';
import { fileApi, type ProjectCard as ProjectCardData } from '../api/client';
import { stageColors } from '../theme';

/**
 * 作品卡 —— Comiku 风格。
 *
 * 视觉规范对齐 https://comiku-preview.vercel.app：
 *  - 顶部横幅大封面 + 页面角标（`8 P`）；
 *  - 编号（`CM-128`）+ 圆角状态药丸（`• 翻译中`）；
 *  - 单一主力环节进度条；
 *  - 底部左侧头像堆叠（首字彩底圆圈），右侧单一动作高亮链接（`继续翻译 →`）。
 */

export function primaryActionOf(card: ProjectCardData): { label: string; to: string; kind: string } {
  const code = card.myRole?.systemCode;
  const project = `/projects/${card.id}`;
  const workbench = card.firstFileId ? `${project}/workbench/${card.firstFileId}` : project;

  if (card.progress.fileCount === 0) return { label: '上传图片', to: project, kind: 'upload' };
  if (code === 'translator') return { label: '继续翻译', to: workbench, kind: 'translate' };
  if (code === 'proofreader') return { label: '开始校对', to: workbench, kind: 'proofread' };
  if (code === 'typesetter') return { label: '上传成品', to: project, kind: 'typeset' };
  if (code === 'creator' || code === 'admin' || code === 'supervisor') {
    return { label: '管理作品', to: project, kind: 'manage' };
  }
  return { label: '查看作品', to: project, kind: 'view' };
}

const STAGE_META: Record<string, { label: string; dot: string; bg: string; text: string; progressLabel: string }> = {
  translating: {
    label: '翻译中',
    dot: '#10b981',
    bg: '#ecfdf5',
    text: '#059669',
    progressLabel: '译文进度',
  },
  proofreading: {
    label: '校对中',
    dot: '#f59e0b',
    bg: '#fffbeb',
    text: '#d97706',
    progressLabel: '校对进度',
  },
  typesetting: {
    label: '嵌字中',
    dot: '#8b5cf6',
    bg: '#f5f3ff',
    text: '#7c3aed',
    progressLabel: '页面进度',
  },
  publishable: {
    label: '待发布',
    dot: '#3b82f6',
    bg: '#eff6ff',
    text: '#2563eb',
    progressLabel: '页面进度',
  },
  published: {
    label: '已发布',
    dot: '#059669',
    bg: '#f0fdf4',
    text: '#059669',
    progressLabel: '发布进度',
  },
};

/** 头像背景色彩轮换：浅紫 / 暖黄 / 淡蓝 / 浅粉 / 薄荷绿 */
const AVATAR_PALETTE = [
  { bg: '#ede9fe', text: '#6d28d9' },
  { bg: '#fef3c7', text: '#b45309' },
  { bg: '#e0e7ff', text: '#4338ca' },
  { bg: '#fce7f3', text: '#be185d' },
  { bg: '#ccfbf1', text: '#0f766e' },
];

export function ProjectCard({ card, todoCount = 0 }: { card: ProjectCardData; todoCount?: number }) {
  const navigate = useNavigate();
  const action = primaryActionOf(card);
  const total = card.progress.fileCount;
  const meta = STAGE_META[card.stage] ?? STAGE_META.translating!;

  // 依据当前环节挑出最有信息量的那条进度值
  let done = card.progress.translatedCount;
  if (card.stage === 'proofreading') done = card.progress.proofreadCount;
  else if (card.stage === 'typesetting' || card.stage === 'publishable') done = card.progress.typesetCount;
  else if (card.stage === 'published') done = card.progress.publishedCount;

  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const coverUrl = card.coverFileId ? fileApi.mediaUrl(card.coverFileId, 'thumb') : null;

  return (
    <div className="cm-project-card" onClick={() => navigate(`/projects/${card.id}`)}>
      {/* 顶部大横幅封面 */}
      <div className="cm-card-cover-wrap">
        {coverUrl ? (
          <img src={coverUrl} alt="" className="cm-card-cover-img" loading="lazy" />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(108, 92, 231, 0.45)',
            }}
          >
            <PictureOutlined style={{ fontSize: 32 }} />
          </div>
        )}

        <div className="cm-card-page-badge">
          <PictureOutlined style={{ fontSize: 10 }} />
          <span>{total > 0 ? `${total} P` : '0 P'}</span>
        </div>

        <div className="cm-card-watermark">
          {card.author ? `${card.author.toUpperCase()} · STORY` : 'COMIC STORIES ・ 夏の記録'}
        </div>
      </div>

      {/* 卡片主体 */}
      <div className="cm-card-body">
        <div className="cm-card-header-row">
          <span className="cm-card-code">CM-{card.serial}</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {todoCount > 0 && (
              <Tooltip title={`有 ${todoCount} 张图正等着你处理`}>
                <span
                  className="cm-status-pill"
                  style={{ background: '#fef3c7', color: '#b45309', border: '1px solid rgba(180,83,9,0.15)' }}
                >
                  待办 {todoCount}
                </span>
              </Tooltip>
            )}
            <span
              className="cm-status-pill"
              style={{
                background: meta.bg,
                color: meta.text,
                border: `1px solid ${meta.text}22`,
              }}
            >
              <span className="cm-status-dot" style={{ background: meta.dot }} />
              {meta.label}
            </span>
          </div>
        </div>

        <div className="cm-card-title" title={card.name}>
          {card.name}
        </div>

        <div className="cm-card-meta">
          {card.author ? `${card.author} · ` : ''}
          {card.teamName || '原创短篇'}
        </div>

        {/* 进度条 */}
        <div className="cm-card-progress-wrap">
          <div className="cm-card-progress-label">
            <span>{meta.progressLabel}</span>
            <span className="cm-card-progress-num">
              {done} <span style={{ color: 'var(--nm-ink-soft)', fontWeight: 400 }}>/</span> {total}
            </span>
          </div>
          <div className="cm-card-progress-track">
            <div
              className="cm-card-progress-fill"
              style={{
                width: `${percent}%`,
                background: percent >= 100 ? '#10b981' : stageColors[card.stage] || '#6c5ce7',
              }}
            />
          </div>
        </div>

        {/* 底部：成员头像堆叠与主操作 */}
        <div className="cm-card-footer">
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {card.members.length > 0 ? (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {card.members.slice(0, 4).map((m, idx) => {
                  const color = AVATAR_PALETTE[idx % AVATAR_PALETTE.length]!;
                  const initial = (m.displayName || '?').trim().slice(0, 1);
                  return (
                    <Tooltip key={m.userId} title={`${m.displayName} · ${m.roleName}`}>
                      <div
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: '50%',
                          background: color.bg,
                          color: color.text,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 12,
                          fontWeight: 700,
                          border: '2px solid var(--nm-surface)',
                          marginLeft: idx === 0 ? 0 : -8,
                          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
                          cursor: 'default',
                        }}
                      >
                        {initial}
                      </div>
                    </Tooltip>
                  );
                })}
                {card.members.length > 4 && (
                  <span style={{ fontSize: 11, color: 'var(--nm-ink-soft)', marginLeft: 4 }}>
                    +{card.members.length - 4}
                  </span>
                )}
              </div>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--nm-ink-soft)' }}>未分派成员</span>
            )}
          </div>

          <button
            type="button"
            className="cm-card-action-btn"
            onClick={(event) => {
              event.stopPropagation();
              navigate(action.to);
            }}
          >
            <span>{action.label}</span>
            <RightOutlined style={{ fontSize: 10 }} />
          </button>
        </div>
      </div>
    </div>
  );
}
