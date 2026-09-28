import { PictureOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons';
import { Avatar, Button, Card, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { fileApi, type ProjectCard as ProjectCardData } from '../api/client';
import { comiku, stageColors } from '../theme';

/**
 * 作品卡 —— 工作台的主视觉单元。
 *
 * 设计上刻意遵守一条规则：**每张卡只有一个主操作**，且这个主操作由
 * 「我的角色」决定，而不是把能做的操作都堆上去。工作台上十张卡各带五个按钮，
 * 结果就是每个都要读一遍才知道点哪个 —— 那还不如列表。
 *
 * 主操作的**去向**直接落到那张图的工作页（`/workbench/<第一张图>`），
 * 而不是先到作品页再让用户点一次。卡片是「今天该干什么」的入口，
 * 多一跳就少一分「一眼看出该动哪个」的价值。
 */

export function primaryActionOf(card: ProjectCardData): { label: string; to: string; kind: string } {
  const code = card.myRole?.systemCode;
  const project = `/projects/${card.id}`;
  // 没有图片时无处可去（也谈不上翻校），落到作品页去上传。
  const workbench = card.firstFileId ? `${project}/workbench/${card.firstFileId}` : project;

  if (card.progress.fileCount === 0) return { label: '上传图片', to: project, kind: 'upload' };
  if (code === 'translator') return { label: '继续翻译', to: workbench, kind: 'translate' };
  if (code === 'proofreader') return { label: '开始校对', to: workbench, kind: 'proofread' };
  // 嵌字的工作页在 M5，现在先落到作品页（那里有图片与导出入口）。
  if (code === 'typesetter') return { label: '上传成品', to: project, kind: 'typeset' };
  if (code === 'creator' || code === 'admin' || code === 'supervisor') {
    return { label: '管理作品', to: project, kind: 'manage' };
  }
  return { label: '查看作品', to: project, kind: 'view' };
}

const STAGE_LABEL: Record<string, string> = {
  translating: '翻译中',
  proofreading: '校对中',
  typesetting: '嵌字中',
  publishable: '待发布',
  published: '已发布',
};

function percentage(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((done / total) * 100);
}

/** 进度条：三条细线，分别对应「译」「校」「页」。 */
function ProgressLine({ label, done, total }: { label: string; done: number; total: number }) {
  const percent = percentage(done, total);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Typography.Text type="secondary" style={{ fontSize: 11, width: 26, flex: 'none' }}>
        {label}
      </Typography.Text>
      <Progress
        percent={percent}
        showInfo={false}
        size="small"
        strokeColor={percent >= 100 ? comiku.success : comiku.primary}
        style={{ flex: 1, margin: 0 }}
      />
      <Typography.Text type="secondary" style={{ fontSize: 11, width: 44, textAlign: 'right', flex: 'none' }}>
        {done}/{total}
      </Typography.Text>
    </div>
  );
}

export function ProjectCard({ card, todoCount = 0 }: { card: ProjectCardData; todoCount?: number }) {
  const navigate = useNavigate();
  const action = primaryActionOf(card);
  const total = card.progress.fileCount;

  return (
    <Card
      hoverable
      onClick={() => navigate(`/projects/${card.id}`)}
      styles={{ body: { padding: 16 } }}
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      <div style={{ display: 'flex', gap: 14 }}>
        {/* 封面：用缩略图而不是原图。列表页十几张卡，原图会把带宽吃光。 */}
        <div
          style={{
            width: 76,
            height: 100,
            flex: 'none',
            borderRadius: 10,
            overflow: 'hidden',
            background: 'var(--comiku-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {card.coverFileId ? (
            <img
              src={fileApi.mediaUrl(card.coverFileId, 'thumb')}
              alt=""
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <PictureOutlined style={{ fontSize: 22, color: comiku.inkSoft }} />
          )}
        </div>

        <div style={{ minWidth: 0, flex: 1 }}>
          <Space size={6} style={{ marginBottom: 4 }} wrap>
            <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>#{card.serial}</Tag>
            {/* 待办角标：这张作品里有多少张图正卡在「该我接」的那一步。
                有它才能一眼看出「今天该动哪部作品」。 */}
            {todoCount > 0 ? (
              <Tooltip title={`有 ${todoCount} 张图正等着你处理`}>
                <Tag color={comiku.warning} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  待办 {todoCount}
                </Tag>
              </Tooltip>
            ) : null}
            <Tag color={stageColors[card.stage]} style={{ marginInlineEnd: 0, fontSize: 11 }}>
              {STAGE_LABEL[card.stage] ?? card.stage}
            </Tag>
            {card.status === 'archived' ? <Tag style={{ marginInlineEnd: 0, fontSize: 11 }}>已归档</Tag> : null}
          </Space>

          <Typography.Text strong ellipsis style={{ display: 'block', fontSize: 15 }}>
            {card.name}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {card.author ? `原作 ${card.author}` : card.teamName}
          </Typography.Text>

          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <ProgressLine label="译" done={card.progress.translatedCount} total={total} />
            <ProgressLine label="校" done={card.progress.proofreadCount} total={total} />
            <ProgressLine label="页" done={card.progress.typesetCount} total={total} />
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: `1px solid var(--comiku-border)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Space size={4} style={{ minWidth: 0 }}>
          {card.members.length > 0 ? (
            <Avatar.Group
              max={{ count: 3 }}
              size={24}
              // 头像堆叠的 tooltip 用角色名，比只显示昵称更有信息量 ——
              // 「谁在翻译」比「有哪几个人」更能说明这部作品的处境。
            >
              {card.members.map((m) => (
                <Tooltip key={m.userId} title={`${m.displayName} · ${m.roleName}`}>
                  <Avatar
                    size={24}
                    style={{ background: comiku.primary, fontSize: 11 }}
                    src={m.avatarKey ?? undefined}
                  >
                    {m.displayName.slice(0, 1)}
                  </Avatar>
                </Tooltip>
              ))}
            </Avatar.Group>
          ) : (
            <Space size={4}>
              <UserOutlined style={{ fontSize: 11, color: comiku.inkSoft }} />
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {total > 0 ? `${total} 页` : '还没有图片'}
              </Typography.Text>
            </Space>
          )}

          {card.members.length > 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              <TeamOutlined style={{ marginRight: 3 }} />
              {total} 页
            </Typography.Text>
          ) : null}
        </Space>

        <Button
          type="primary"
          size="small"
          onClick={(event) => {
            // 卡片整块可点，但主操作不该顺手把人带到别处 —— 拦一下冒泡。
            event.stopPropagation();
            navigate(action.to);
          }}
        >
          {action.label}
        </Button>
      </div>
    </Card>
  );
}
