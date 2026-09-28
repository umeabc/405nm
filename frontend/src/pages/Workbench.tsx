import { PlusOutlined, RightOutlined, TeamOutlined } from '@ant-design/icons';
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Input,
  List,
  Row,
  Segmented,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
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
import { ContentTitle } from '../components/AppShell';
import { ProjectCard } from '../components/ProjectCard';
import { ProjectFormModal } from '../components/ProjectFormModal';
import { STAGE_TABS } from '../components/StageChips';
import { palette } from '../theme';
import { timeAgo } from '../utils/time';

/** 按时间问候 —— 设计稿里就是「早上好，小凛」，这里保持一致。 */
function greetingOf(date: Date): string {
  const hour = date.getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/**
 * 工作台 —— 需求里「登录后基于职务进入工作」的落点。
 *
 * 做法不是加权限墙，而是：默认列出**我所在团队的全部作品**（可切到「只看我参与的」），
 * 每张卡给出**一个下一步动作**（映射规则见 ProjectCard）。
 * 过滤与计数都交给后端 —— 前端过滤只是体验层的便利，
 * 真正的边界永远在后端：不属于我所在团队的作品，后端根本不会返回。
 */
export default function WorkbenchPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();

  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [cards, setCards] = useState<ProjectCardData[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  /** 作品 id → 卡在我这一环的图片数。来自署名台账 + 当前状态。 */
  const [todos, setTodos] = useState<Record<string, number>>({});
  const [stage, setStage] = useState<StageKey | 'all'>('all');
  const [mine, setMine] = useState(false);
  const [keyword, setKeyword] = useState('');
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
      .catch(() => {
        // 侧栏加载失败不该影响主区域可用性，静默即可。
      });
  }, []);

  const creatableTeams = teams.filter((t) => t.myPermissions.includes('project.create'));
  // 一个作品都没有时，chips 上全是 0 只是噪音 —— 只在真有作品时才显示计数。
  const hasAnyProject = Object.values(counts).some((n) => n > 0);

  return (
    <>
      <ContentTitle
        title={`${greetingOf(new Date())}，${user?.displayName ?? ''}`}
        description="故事的下一页，从这里开始。"
        extra={
          creatableTeams.length > 0 ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              新建作品
            </Button>
          ) : null
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={17}>
          <div className="nm-chips" style={{ marginBottom: 12 }}>
            <Segmented
              value={stage}
              onChange={(next) => setStage(next as StageKey | 'all')}
              options={STAGE_TABS.map((tab) => ({
                value: tab.key,
                label:
                  tab.key === 'all' || !counts[tab.key]
                    ? tab.label
                    : `${tab.label} ${counts[tab.key]}`,
              }))}
            />
          </div>

          <Space style={{ marginBottom: 14 }} size={12} wrap>
            <Input.Search
              allowClear
              placeholder="搜索作品名或原作者"
              style={{ width: 240 }}
              onSearch={(value) => setKeyword(value)}
            />
            <Space size={6}>
              <Switch size="small" checked={mine} onChange={setMine} />
              <Typography.Text style={{ fontSize: 13 }}>只看我参与的</Typography.Text>
            </Space>
          </Space>

          {loading ? (
            <Card loading />
          ) : cards.length === 0 ? (
            <Card>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Space direction="vertical" size={4}>
                    <Typography.Text>
                      {hasAnyProject ? '没有符合条件的作品' : '还没有作品'}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {hasAnyProject
                        ? '换个档位，或清掉搜索条件再看看。'
                        : creatableTeams.length > 0
                          ? '建一个作品，把图片传上来就可以开工了。'
                          : '你所在的团队还没有作品；等人拉你进作品，或找管理员开一个。'}
                    </Typography.Text>
                  </Space>
                }
              />
            </Card>
          ) : (
            <Row gutter={[14, 14]}>
              {cards.map((card) => (
                <Col xs={24} md={12} key={card.id}>
                  <ProjectCard card={card} todoCount={todos[card.id] ?? 0} />
                </Col>
              ))}
            </Row>
          )}
        </Col>

        <Col xs={24} lg={7}>
          <Card
            title="我的团队"
            size="small"
            extra={
              <Button type="link" size="small" onClick={() => navigate('/teams')}>
                全部
              </Button>
            }
          >
            {teams.length === 0 ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                  还没有加入任何团队。
                </Typography.Text>
                <Button size="small" icon={<PlusOutlined />} onClick={() => navigate('/teams')}>
                  创建或加入
                </Button>
              </Space>
            ) : (
              <List
                size="small"
                dataSource={teams}
                renderItem={(team) => (
                  <List.Item
                    style={{ cursor: 'pointer', padding: '8px 0' }}
                    onClick={() => navigate(`/teams/${team.id}`)}
                  >
                    <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                      <Space size={8}>
                        <TeamOutlined style={{ color: palette.primary }} />
                        <Space direction="vertical" size={0}>
                          <Typography.Text>{team.name}</Typography.Text>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            {team.memberCount} 位成员
                          </Typography.Text>
                        </Space>
                      </Space>
                      <Space size={4}>
                        <Tag color={palette.primary} style={{ marginInlineEnd: 0 }}>
                          {team.myRole.name}
                        </Tag>
                        <RightOutlined style={{ fontSize: 10, color: palette.inkSoft }} />
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>

          <Card title="团队动态" size="small" style={{ marginTop: 16 }}>
            {activity.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                谁把哪部作品推进到了哪一步，会出现在这里。
              </Typography.Text>
            ) : (
              <List
                size="small"
                dataSource={activity.slice(0, 12)}
                renderItem={(item) => (
                  <List.Item
                    style={{
                      padding: '8px 0',
                      cursor: item.targetType === 'project' ? 'pointer' : 'default',
                    }}
                    onClick={() => {
                      if (item.targetType === 'project') navigate(`/projects/${item.targetId}`);
                    }}
                  >
                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                      <Typography.Text style={{ fontSize: 13 }}>
                        <Typography.Text strong>{item.actor?.displayName ?? '系统'}</Typography.Text>{' '}
                        {item.text}
                      </Typography.Text>
                      <Space size={6}>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          {timeAgo(item.createdAt)}
                        </Typography.Text>
                        {item.teamName ? (
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            · {item.teamName}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>

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
    </>
  );
}
