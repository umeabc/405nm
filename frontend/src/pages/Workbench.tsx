import {
  AppstoreOutlined,
  BarsOutlined,
  BookOutlined,
  CheckCircleOutlined,
  PlusOutlined,
  RightOutlined,
  RocketOutlined,
  SearchOutlined,
  TeamOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import {
  App as AntApp,
  Checkbox,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  projectApi,
  teamApi,
  workflowApi,
  type ActivityItem,
  type ProjectCard as ProjectCardData,
  type StageKey,
  type TeamSummary,
} from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { ProjectCard, primaryActionOf } from '../components/ProjectCard';
import { ProjectFormModal } from '../components/ProjectFormModal';
import { StageChips } from '../components/StageChips';
import { timeAgo } from '../utils/time';

/** 按时间问候 —— 对齐 Comiku 风格 */
function greetingOf(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function padZero(num: number): string {
  return num < 10 ? `0${num}` : String(num);
}

/** 头像背景色彩轮换 */
const AVATAR_PALETTE = [
  { bg: '#ede9fe', text: '#6d28d9' },
  { bg: '#fef3c7', text: '#b45309' },
  { bg: '#e0e7ff', text: '#4338ca' },
  { bg: '#fce7f3', text: '#be185d' },
  { bg: '#ccfbf1', text: '#0f766e' },
];

export default function WorkbenchPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();

  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [cards, setCards] = useState<ProjectCardData[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [todos, setTodos] = useState<Record<string, number>>({});
  const [stage, setStage] = useState<StageKey | 'all'>('all');
  const [mine, setMine] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'serial'>('updated');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const loadCards = useCallback(async () => {
    setLoading(true);
    try {
      const res = await projectApi.workbench({
        ...(stage === 'all' ? {} : { stage }),
        ...(mine ? { mine: true } : {}),
        ...(keyword ? { keyword } : {}),
      });
      setCards(res.projects);
      setCounts(res.counts);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '作品加载失败');
    } finally {
      setLoading(false);
    }
  }, [stage, mine, keyword, message]);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  useEffect(() => {
    void Promise.all([teamApi.mine(), projectApi.activity(), workflowApi.myTodos()])
      .then(([teamRes, actRes, todoRes]) => {
        setTeams(teamRes.teams);
        setActivity(actRes.activity);
        setTodos(todoRes.byProject);
      })
      .catch(() => {});
  }, []);

  const creatableTeams = teams.filter((t) => t.myPermissions.includes('project.create'));

  // 排序
  const sortedCards = useMemo(() => {
    const list = [...cards];
    if (sortBy === 'serial') list.sort((a, b) => b.serial - a.serial);
    return list;
  }, [cards, sortBy]);

  // 4 个指标卡统计
  const inProgressCount =
    (counts.translating ?? 0) + (counts.proofreading ?? 0) + (counts.typesetting ?? 0);
  const translatingCount = counts.translating ?? 0;
  const proofreadingCount = counts.proofreading ?? 0;
  const publishedCount = counts.published ?? 0;

  // 上次或当前待办作品
  const lastProject = useMemo(() => {
    return cards.find((c) => (todos[c.id] ?? 0) > 0) ?? cards[0] ?? null;
  }, [cards, todos]);

  // 成员总人数
  const totalMemberCount = useMemo(() => {
    const allMembers = new Map<string, string>();
    for (const c of cards) {
      for (const m of c.members) allMembers.set(m.userId, m.displayName || '?');
    }
    return Math.max(allMembers.size, teams.reduce((s, t) => s + t.memberCount, 0));
  }, [cards, teams]);

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', paddingBottom: 48 }}>
      {/* ── 顶部 Hero 问候与主动作 ──────────────────────────────── */}
      <div className="cm-hero">
        <div className="cm-hero-kicker">
          <span>— A LITTLE PROGRESS, EVERY DAY</span>
        </div>

        <div className="cm-hero-title-row">
          <h1 className="cm-hero-title">
            {greetingOf(new Date())}，{user?.displayName ?? '伙伴'}{' '}
            <span className="cm-hero-sparkle">✳</span>
            <span className="cm-hero-dot">.</span>
          </h1>

          {creatableTeams.length > 0 && (
            <button
              type="button"
              className="cm-hero-create-btn"
              onClick={() => setCreating(true)}
            >
              <PlusOutlined style={{ fontSize: 13 }} />
              <span>新建作品</span>
            </button>
          )}
        </div>

        <p className="cm-hero-subtitle">故事的下一页，从这里开始。今天也一起加油吧。</p>

        {/* ── 4 个快捷指标卡 ──────────────────────────────────── */}
        <div className="cm-metrics-grid">
          <div className="cm-metric-card" onClick={() => setStage('all')}>
            <div className="cm-metric-head">
              <span className="cm-metric-label">进行中的作品</span>
              <div
                className="cm-metric-icon-box"
                style={{ background: '#f5f3ff', color: '#6c5ce7' }}
              >
                <BookOutlined />
              </div>
            </div>
            <div className="cm-metric-num-row">
              <span className="cm-metric-num">{padZero(inProgressCount)}</span>
              <span className="cm-metric-arrow">↗</span>
            </div>
            <p className="cm-metric-sub">• 每个故事都在向前</p>
          </div>

          <div className="cm-metric-card" onClick={() => setStage('translating')}>
            <div className="cm-metric-head">
              <span className="cm-metric-label">等待翻译</span>
              <div
                className="cm-metric-icon-box"
                style={{ background: '#ecfdf5', color: '#059669' }}
              >
                <TranslationOutlined />
              </div>
            </div>
            <div className="cm-metric-num-row">
              <span className="cm-metric-num">{padZero(translatingCount)}</span>
              <span className="cm-metric-arrow">↗</span>
            </div>
            <p className="cm-metric-sub">• 用文字传递心意</p>
          </div>

          <div className="cm-metric-card" onClick={() => setStage('proofreading')}>
            <div className="cm-metric-head">
              <span className="cm-metric-label">等待校对</span>
              <div
                className="cm-metric-icon-box"
                style={{ background: '#fffbeb', color: '#d97706' }}
              >
                <CheckCircleOutlined />
              </div>
            </div>
            <div className="cm-metric-num-row">
              <span className="cm-metric-num">{padZero(proofreadingCount)}</span>
              <span className="cm-metric-arrow">↗</span>
            </div>
            <p className="cm-metric-sub">• 好作品值得再读一遍</p>
          </div>

          <div className="cm-metric-card" onClick={() => setStage('published')}>
            <div className="cm-metric-head">
              <span className="cm-metric-label">已发布作品</span>
              <div
                className="cm-metric-icon-box"
                style={{ background: '#fdf2f8', color: '#db2777' }}
              >
                <RocketOutlined />
              </div>
            </div>
            <div className="cm-metric-num-row">
              <span className="cm-metric-num">{padZero(publishedCount)}</span>
              <span className="cm-metric-arrow">↗</span>
            </div>
            <p className="cm-metric-sub">• 又有故事被更多人看见</p>
          </div>
        </div>
      </div>

      {/* ── 主体双栏区域 ────────────────────────────────────────── */}
      <Row gutter={[24, 24]}>
        <Col xs={24} lg={17}>
          {/* 作品区标题 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              marginBottom: 10,
            }}
          >
            <h2
              style={{
                fontSize: 18,
                fontWeight: 800,
                color: 'var(--nm-ink)',
                margin: 0,
              }}
            >
              最近的作品
            </h2>
            <span style={{ fontSize: 13, color: 'var(--nm-ink-soft)' }}>
              {cards.length} 部作品
            </span>
          </div>

          {/* Comiku 状态滑动选项卡 */}
          <StageChips value={stage} onChange={setStage} counts={counts} />

          {/* 搜索与过滤控制栏 */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 20,
            }}
          >
            <Input
              allowClear
              prefix={<SearchOutlined style={{ color: 'var(--nm-ink-soft)' }} />}
              placeholder="搜索作品、作者或编号..."
              style={{
                width: 280,
                borderRadius: 999,
                background: 'var(--nm-surface)',
              }}
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />

            <Space size={16} wrap>
              <Checkbox checked={mine} onChange={(e) => setMine(e.target.checked)}>
                <span style={{ fontSize: 13, color: 'var(--nm-ink)' }}>只看我参与的</span>
              </Checkbox>

              <Select
                size="small"
                value={sortBy}
                onChange={setSortBy}
                style={{ width: 110 }}
                options={[
                  { value: 'updated', label: '最新更新' },
                  { value: 'serial', label: '作品编号' },
                ]}
              />

              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  background: 'var(--nm-surface)',
                  border: '1px solid var(--nm-border)',
                  borderRadius: 8,
                  padding: 2,
                }}
              >
                <button
                  type="button"
                  style={{
                    background: viewMode === 'grid' ? '#f0eefb' : 'transparent',
                    color: viewMode === 'grid' ? 'var(--nm-primary)' : 'var(--nm-ink-soft)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onClick={() => setViewMode('grid')}
                  title="卡片视图"
                >
                  <AppstoreOutlined style={{ fontSize: 14 }} />
                </button>
                <button
                  type="button"
                  style={{
                    background: viewMode === 'list' ? '#f0eefb' : 'transparent',
                    color: viewMode === 'list' ? 'var(--nm-primary)' : 'var(--nm-ink-soft)',
                    border: 'none',
                    borderRadius: 6,
                    padding: '4px 8px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                  onClick={() => setViewMode('list')}
                  title="列表视图"
                >
                  <BarsOutlined style={{ fontSize: 14 }} />
                </button>
              </div>
            </Space>
          </div>

          {/* 作品卡片网格 */}
          {loading ? (
            <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--nm-ink-soft)' }}>
              加载中…
            </div>
          ) : sortedCards.length === 0 ? (
            <div
              style={{
                background: 'var(--nm-surface)',
                border: '1px solid var(--nm-border)',
                borderRadius: 16,
                padding: '60px 20px',
              }}
            >
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Space direction="vertical" size={4}>
                    <Typography.Text strong style={{ fontSize: 15 }}>
                      没有找到符合条件的作品
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                      换个状态标签、或者清掉搜索框关键词再试一次。
                    </Typography.Text>
                  </Space>
                }
              />
            </div>
          ) : (
            <Row gutter={[18, 18]}>
              {sortedCards.map((card) => (
                <Col xs={24} sm={12} key={card.id}>
                  <ProjectCard card={card} todoCount={todos[card.id] ?? 0} />
                </Col>
              ))}
            </Row>
          )}

          {/* 底部小脚注文案 */}
          <div
            style={{
              textAlign: 'center',
              marginTop: 40,
              paddingTop: 24,
              borderTop: '1px solid var(--nm-border)',
              color: 'var(--nm-ink-soft)',
              fontSize: 12,
            }}
          >
            <span>每一个故事，都在慢慢完成 · </span>
            <span style={{ color: 'var(--nm-primary)' }}>今天，继续一点点 ✦</span>
          </div>
        </Col>

        {/* ── 右侧故事进度与动态栏 ──────────────────────────────── */}
        <Col xs={24} lg={7}>
          {/* 卡片 1：你的故事进度 */}
          {lastProject && (
            <div className="cm-sidebar-card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  fontWeight: 700,
                  color: 'var(--nm-primary)',
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}
              >
                <span>✦</span>
                <span>你的故事进度</span>
              </div>
              <p style={{ fontSize: 13, color: 'var(--nm-ink)', margin: '0 0 12px 0', lineHeight: 1.5 }}>
                还有 <strong style={{ color: 'var(--nm-primary)' }}>{cards.length}</strong>{' '}
                部作品，等你接着写下去。
              </p>
              <button
                type="button"
                className="cm-card-action-btn"
                style={{ fontSize: 13 }}
                onClick={() => {
                  const act = primaryActionOf(lastProject);
                  navigate(act.to);
                }}
              >
                <span>回到上次的作品</span>
                <RightOutlined style={{ fontSize: 10 }} />
              </button>
            </div>
          )}

          {/* 卡片 2：团队动态 */}
          <div className="cm-sidebar-card">
            <div className="cm-sidebar-card-title">
              <span>团队动态</span>
              <button
                type="button"
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: 12,
                  color: 'var(--nm-primary)',
                  cursor: 'pointer',
                  padding: 0,
                }}
                onClick={() => navigate('/teams')}
              >
                查看全部 →
              </button>
            </div>

            {activity.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--nm-ink-soft)', margin: 0 }}>
                谁把哪部作品推进到了哪一步，会出现在这里。
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {activity.slice(0, 5).map((item, idx) => {
                  const color = AVATAR_PALETTE[idx % AVATAR_PALETTE.length]!;
                  const initial = (item.actor?.displayName ?? '系统').slice(0, 1);
                  return (
                    <div
                      key={item.id}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        fontSize: 13,
                        lineHeight: 1.4,
                      }}
                    >
                      <div
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: '50%',
                          background: color.bg,
                          color: color.text,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 11,
                          fontWeight: 700,
                          flex: 'none',
                          marginTop: 2,
                        }}
                      >
                        {initial}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ color: 'var(--nm-ink)' }}>
                          <strong>{item.actor?.displayName ?? '系统'}</strong>{' '}
                          <span style={{ color: 'var(--nm-ink-soft)' }}>{item.text}</span>
                        </div>
                        <div
                          style={{
                            fontSize: 11,
                            color: '#9ba1b0',
                            marginTop: 2,
                            display: 'flex',
                            gap: 4,
                          }}
                        >
                          <span>{timeAgo(item.createdAt)}</span>
                          {item.teamName && <span>· {item.teamName}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* 卡片 3：一起创作的人 */}
          <div className="cm-sidebar-card">
            <div className="cm-sidebar-card-title">
              <span>一起创作的人</span>
              <TeamOutlined style={{ color: 'var(--nm-ink-soft)', fontSize: 14 }} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
              {/* 头像堆叠 */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {teams.slice(0, 5).map((team, idx) => {
                  const color = AVATAR_PALETTE[idx % AVATAR_PALETTE.length]!;
                  const initial = team.name.slice(0, 1);
                  return (
                    <Tooltip key={team.id} title={`${team.name}（${team.memberCount} 人）`}>
                      <div
                        style={{
                          width: 28,
                          height: 28,
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
                          cursor: 'pointer',
                        }}
                        onClick={() => navigate(`/teams/${team.id}`)}
                      >
                        {initial}
                      </div>
                    </Tooltip>
                  );
                })}
              </div>
              <span style={{ fontSize: 12, color: 'var(--nm-ink-soft)', marginLeft: 4 }}>
                {totalMemberCount} 位伙伴
              </span>
            </div>

            <button
              type="button"
              className="cm-card-action-btn"
              style={{ fontSize: 12 }}
              onClick={() => navigate('/teams')}
            >
              <span>查看团队成员</span>
              <RightOutlined style={{ fontSize: 9 }} />
            </button>
          </div>

          {/* 卡片 4：金句名片卡 */}
          <div className="cm-quote-card">
            <div className="cm-quote-mark">“</div>
            <div className="cm-quote-line">因为喜欢，</div>
            <div className="cm-quote-line" style={{ fontWeight: 600, color: 'var(--nm-ink)' }}>
              所以想让更多人读到。
            </div>
            <div className="cm-quote-kicker">
              <span>MADE WITH LOVE, TOGETHER.</span>
              <span>✦</span>
            </div>
          </div>
        </Col>
      </Row>

      {/* 新建作品弹窗 */}
      {creating && creatableTeams[0] ? (
        <ProjectFormModal
          open
          mode="create"
          teamId={creatableTeams[0].id}
          onClose={() => setCreating(false)}
          onSaved={(project) => {
            void loadCards();
            modal.confirm({
              title: '作品已创建',
              content: '现在去上传图片吗？',
              okText: '去上传',
              cancelText: '稍后',
              onOk: () => navigate(`/projects/${project.id}`),
            });
          }}
        />
      ) : null}
    </div>
  );
}
