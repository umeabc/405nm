import { KeyOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Col, Descriptions, Form, Input, Row, Space, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, authApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { PageHeader } from '../components/AppShell';

type PasswordForm = { currentPassword: string; newPassword: string; confirmPassword: string };

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<PasswordForm>();
  const [submitting, setSubmitting] = useState(false);

  async function handleChangePassword(values: PasswordForm) {
    setSubmitting(true);
    try {
      await authApi.changePassword(values.currentPassword, values.newPassword);
      message.success('密码已修改，请用新密码重新登录');
      form.resetFields();
      // 改密码会把所有会话踢掉（包括当前这条），所以这边主动退出并回登录页，
      // 而不是等下一个请求 401 之后莫名其妙地被登出。
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '修改失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="个人资料" description="昵称用于展示；登录与日志使用注册时的用户名。" />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title={<Space><UserOutlined />基本信息</Space>}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="显示昵称">{user?.displayName}</Descriptions.Item>
              <Descriptions.Item label="登录用户名">{user?.username}</Descriptions.Item>
              <Descriptions.Item label="站点管理员">
                {user?.isSiteAdmin ? '是' : '否'}
              </Descriptions.Item>
            </Descriptions>

            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 16, marginBottom: 0 }}>
              用户名不可修改 —— 操作日志与署名记录都以它为准。
            </Typography.Paragraph>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title={<Space><KeyOutlined />修改密码</Space>}>
            <Form form={form} layout="vertical" onFinish={handleChangePassword} requiredMark={false}>
              <Form.Item
                name="currentPassword"
                label="当前密码"
                rules={[{ required: true, message: '请输入当前密码' }]}
              >
                <Input.Password autoComplete="current-password" />
              </Form.Item>

              <Form.Item
                name="newPassword"
                label="新密码"
                rules={[
                  { required: true, message: '请输入新密码' },
                  { min: 8, max: 128, message: '密码长度需为 8 ~ 128 个字符' },
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>

              <Form.Item
                name="confirmPassword"
                label="确认新密码"
                dependencies={['newPassword']}
                rules={[
                  { required: true, message: '请再次输入新密码' },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('newPassword') === value) return Promise.resolve();
                      return Promise.reject(new Error('两次输入的新密码不一致'));
                    },
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>

              <Button type="primary" htmlType="submit" loading={submitting}>
                修改密码
              </Button>

              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
                修改后所有设备上的登录都会失效。忘记密码请联系站点管理员重置。
              </Typography.Paragraph>
            </Form>
          </Card>
        </Col>
      </Row>
    </>
  );
}
