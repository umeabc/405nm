import { DeleteOutlined, InboxOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Descriptions, Popconfirm, Space, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, projectApi } from '../../api/client';
import { formatBytes } from '../../utils/time';
import type { ProjectTabProps } from './index';

/**
 * 作品设置：危险操作与事实清单。
 *
 * 「结项」与「删除」刻意分开，且用词不同：
 *  - 结项 = 归档：作品还在、图还在、随时能取消归档，只是不再出现在默认视图里；
 *  - 删除 = 从库里抹掉作品记录（图片与标号随后由清理任务回收）。
 * 把两者做成同一个按钮是常见的省事做法，但用户按下时想的是完全不同的事。
 */
export function SettingsTab({ detail, reload, can }: ProjectTabProps) {
  const navigate = useNavigate();
  const { message, modal } = AntApp.useApp();
  const [busy, setBusy] = useState(false);

  const { project } = detail;
  const archived = project.status === 'archived';

  async function toggleArchive() {
    setBusy(true);
    try {
      if (archived) {
        await projectApi.unarchive(project.id);
        message.success('已取消归档');
      } else {
        await projectApi.archive(project.id);
        message.success('已结项归档');
      }
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  function removeProject() {
    modal.confirm({
      title: `删除作品「${project.name}」？`,
      content: (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          作品的记录、图片条目、标号与译文都会从库里移除，**无法撤销**。
          磁盘上的图片字节会保留，直到运行清理任务。
        </Typography.Text>
      ),
      okText: '确认删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await projectApi.remove(project.id);
          message.success('作品已删除');
          navigate('/');
        } catch (err) {
          message.error(err instanceof ApiError ? err.message : '删除失败');
          throw err;
        }
      },
    });
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="作品信息">
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label="编号">#{project.serial}</Descriptions.Item>
          <Descriptions.Item label="所属团队">{project.teamName}</Descriptions.Item>
          <Descriptions.Item label="作品集">{project.setName ?? '未归类'}</Descriptions.Item>
          <Descriptions.Item label="原作者">{project.author || '—'}</Descriptions.Item>
          <Descriptions.Item label="源语言">{project.sourceLanguage}</Descriptions.Item>
          <Descriptions.Item label="目标语言">
            {detail.targets.length > 0 ? detail.targets.map((t) => t.label).join('、') : '未设置'}
          </Descriptions.Item>
          <Descriptions.Item label="图片">{project.progress.fileCount} 张</Descriptions.Item>
          <Descriptions.Item label="状态">{archived ? '已归档' : '进行中'}</Descriptions.Item>
          <Descriptions.Item label="创建于">
            {new Date(project.createdAt).toLocaleString()}
          </Descriptions.Item>
          <Descriptions.Item label="更新于">
            {new Date(project.updatedAt).toLocaleString()}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="进度">
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Typography.Text style={{ fontSize: 13 }}>
            已翻译 {project.progress.translatedCount} / {project.progress.fileCount} 张
          </Typography.Text>
          <Typography.Text style={{ fontSize: 13 }}>
            已校对 {project.progress.proofreadCount} / {project.progress.fileCount} 张
          </Typography.Text>
          <Typography.Text style={{ fontSize: 13 }}>
            已嵌字 {project.progress.typesetCount} / {project.progress.fileCount} 张
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            这些数字是**按文件当前状态实时算出来的**，没有可漂移的计数器，
            也不需要任何「重算」按钮。
          </Typography.Text>
        </Space>
      </Card>

      <Card title="危险操作">
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space direction="vertical" size={0}>
              <Typography.Text>结项归档</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {archived
                  ? '作品当前已归档。取消后会重新出现在工作台里。'
                  : '归档后作品不再出现在工作台的默认列表中，但仍可随时查看与取消归档。'}
              </Typography.Text>
            </Space>
            <Button
              icon={<InboxOutlined />}
              loading={busy}
              disabled={!can('project.finish')}
              onClick={() => void toggleArchive()}
            >
              {archived ? '取消归档' : '结项归档'}
            </Button>
          </Space>

          <Space style={{ justifyContent: 'space-between', width: '100%' }}>
            <Space direction="vertical" size={0}>
              <Typography.Text type="danger">删除作品</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                连同图片条目、标号与译文一起删除，无法撤销。
              </Typography.Text>
            </Space>
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={!can('project.delete')}
              onClick={removeProject}
            >
              删除作品
            </Button>
          </Space>
        </Space>
      </Card>
    </Space>
  );
}
