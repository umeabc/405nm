import { ArrowLeftOutlined, ReadOutlined, SettingOutlined, UploadOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Space, Spin, Tag, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, projectApi, type ProjectDetail } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { ProjectFormModal } from '../../components/ProjectFormModal';
import { comiku, stageColors } from '../../theme';
import { FilesTab } from './FilesTab';
import { MembersTab } from './MembersTab';
import { RolesTab } from './RolesTab';
import { SettingsTab } from './SettingsTab';
import { TargetsTab } from './TargetsTab';

const STAGE_LABEL: Record<string, string> = {
  translating: '翻译中',
  proofreading: '校对中',
  typesetting: '嵌字中',
  publishable: '待发布',
  published: '已发布',
};

/** 各 tab 拿到的共享上下文。抽成类型是为了让每个 tab 的依赖一目了然。 */
export type ProjectTabProps = {
  detail: ProjectDetail;
  reload: () => Promise<void>;
  /** 权限判定。**只用于界面**；每个动作在后端都会再判一次。 */
  can: (code: string) => boolean;
  /** 切到别的 tab（如从成员页跳到角色页） */
  goTab: (key: string) => void;
};

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { user } = useAuth();
  const { message } = AntApp.useApp();

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('files');
  const [editing, setEditing] = useState(false);
  const [uploadSignal, setUploadSignal] = useState(0);
  /** 自增即表示「请打开第一张图的翻校页」——页头按钮用，文件列表知道第一张是谁。 */
  const [translateSignal, setTranslateSignal] = useState(0);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      setDetail(await projectApi.detail(projectId));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '作品加载失败');
    } finally {
      setLoading(false);
    }
  }, [projectId, message]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <div className="nm-centered">
        <Spin size="large" />
      </div>
    );
  }

  if (!detail || !projectId) {
    return (
      <Card>
        <Space direction="vertical">
          <Typography.Text>作品不存在，或你没有访问权限。</Typography.Text>
          <Link to="/">
            <Button type="link" icon={<ArrowLeftOutlined />} style={{ paddingLeft: 0 }}>
              回到工作台
            </Button>
          </Link>
        </Space>
      </Card>
    );
  }

  const { project, my } = detail;
  const can = (code: string) => my.permissions.includes(code);

  return (
    <>
      <Link to="/">
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} style={{ paddingLeft: 0, marginBottom: 8 }}>
          工作台
        </Button>
      </Link>

      <Card styles={{ body: { padding: '18px 20px' } }} style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <Space size={6} wrap style={{ marginBottom: 6 }}>
              <Tag style={{ marginInlineEnd: 0 }}>#{project.serial}</Tag>
              <Tag color={stageColors[project.stage]} style={{ marginInlineEnd: 0 }}>
                {STAGE_LABEL[project.stage] ?? project.stage}
              </Tag>
              {project.status === 'archived' ? <Tag style={{ marginInlineEnd: 0 }}>已归档</Tag> : null}
              {my.role ? (
                <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
                  我是{my.role.name}
                </Tag>
              ) : my.viaTeamRole ? (
                <Tag color={comiku.primary} style={{ marginInlineEnd: 0 }}>
                  团队角色授权
                </Tag>
              ) : null}
            </Space>

            <Typography.Title level={3} style={{ marginBottom: 2 }}>
              {project.name}
            </Typography.Title>

            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {[
                project.author ? `原作 ${project.author}` : '',
                project.teamName,
                project.setName ?? '未归类',
                `${project.progress.fileCount} 页`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>

            {project.intro ? (
              <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginTop: 8, marginBottom: 0 }}>
                {project.intro}
              </Typography.Paragraph>
            ) : null}
          </div>

          <Space wrap>
            {can('project.edit') ? (
              <Button icon={<SettingOutlined />} onClick={() => setEditing(true)}>
                作品资料
              </Button>
            ) : null}
            {can('tra.add') || can('tra.proofread') ? (
              <Button
                icon={<ReadOutlined />}
                onClick={() => {
                  setTab('files');
                  setTranslateSignal((n) => n + 1);
                }}
              >
                翻校
              </Button>
            ) : null}
            {can('file.add') ? (
              <Button
                type="primary"
                icon={<UploadOutlined />}
                onClick={() => {
                  setTab('files');
                  setUploadSignal((n) => n + 1);
                }}
              >
                上传图片
              </Button>
            ) : null}
          </Space>
        </div>
      </Card>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'files',
            label: '图片',
            children: (
              <FilesTab
                detail={detail}
                reload={reload}
                can={can}
                goTab={setTab}
                openUploadSignal={uploadSignal}
                openTranslateSignal={translateSignal}
              />
            ),
          },
          { key: 'members', label: '成员', children: <MembersTab detail={detail} reload={reload} can={can} goTab={setTab} /> },
          { key: 'targets', label: '目标语言', children: <TargetsTab detail={detail} reload={reload} can={can} goTab={setTab} /> },
          { key: 'roles', label: '角色与权限', children: <RolesTab detail={detail} reload={reload} can={can} goTab={setTab} /> },
          {
            key: 'settings',
            label: '设置',
            children: <SettingsTab detail={detail} reload={reload} can={can} goTab={setTab} />,
          },
        ]}
      />

      {editing ? (
        <ProjectFormModal
          open
          mode="edit"
          teamId={project.teamId}
          project={project}
          onClose={() => setEditing(false)}
          onSaved={() => void reload()}
        />
      ) : null}

      {/* 站点管理员的身份提示：界面给了全套入口，但要让人知道自己为什么能点。 */}
      {user?.isSiteAdmin && !my.role ? (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 12 }}>
          你以站点管理员身份访问该作品，拥有全部权限。
        </Typography.Text>
      ) : null}
    </>
  );
}
