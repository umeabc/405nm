import { LockOutlined, NumberOutlined, SmileOutlined, UserOutlined } from '@ant-design/icons';
import { App as AntApp, Button, Card, Form, Input, Tabs, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, authApi } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { comiku } from '../theme';

type LoginForm = { username: string; password: string };
type RegisterForm = { username: string; password: string; displayName?: string; inviteCode: string };

export default function LoginPage() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { message } = AntApp.useApp();

  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [submitting, setSubmitting] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);

  // 注册开关由后端决定（没有可用邀请码时就是关闭的），前端不猜。
  useEffect(() => {
    authApi
      .registrationStatus()
      .then((res) => setRegistrationOpen(res.open))
      .catch(() => setRegistrationOpen(false));
  }, []);

  // ?next= 只接受站内相对路径，避免被当成开放跳转使。
  const nextParam = params.get('next');
  const nextPath = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  const finish = (user: Parameters<typeof setUser>[0]) => {
    setUser(user);
    navigate(nextPath, { replace: true });
  };

  async function handleLogin(values: LoginForm) {
    setSubmitting(true);
    try {
      const { user } = await authApi.login(values.username, values.password);
      finish(user);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRegister(values: RegisterForm) {
    setSubmitting(true);
    try {
      const { user } = await authApi.register(values);
      message.success('注册成功，已自动登录');
      finish(user);
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : '注册失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  const loginForm = (
    <Form<LoginForm> layout="vertical" onFinish={handleLogin} requiredMark={false}>
      <Form.Item
        name="username"
        label="用户名"
        rules={[{ required: true, message: '请输入用户名' }]}
      >
        <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" size="large" />
      </Form.Item>

      <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="密码"
          autoComplete="current-password"
          size="large"
        />
      </Form.Item>

      <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
        登录
      </Button>
    </Form>
  );

  const registerForm = (
    <Form<RegisterForm> layout="vertical" onFinish={handleRegister} requiredMark={false}>
      <Form.Item
        name="username"
        label="用户名"
        rules={[{ required: true, message: '请输入用户名' }]}
        extra="3 ~ 32 个字符，可用字母、数字、下划线、点、连字符或中文"
      >
        <Input prefix={<UserOutlined />} placeholder="用户名" autoComplete="username" size="large" />
      </Form.Item>

      <Form.Item name="displayName" label="昵称（可选）">
        <Input prefix={<SmileOutlined />} placeholder="展示用的名字，留空则与用户名相同" size="large" />
      </Form.Item>

      <Form.Item
        name="password"
        label="密码"
        rules={[{ required: true, message: '请输入密码' }]}
        extra="至少 8 位"
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="密码"
          autoComplete="new-password"
          size="large"
        />
      </Form.Item>

      <Form.Item
        name="inviteCode"
        label="邀请码"
        rules={[{ required: true, message: '请输入邀请码' }]}
        extra="向团队管理员索取"
      >
        <Input
          prefix={<NumberOutlined />}
          placeholder="XXXX-XXXX-XXXX"
          size="large"
          style={{ textTransform: 'uppercase' }}
        />
      </Form.Item>

      <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
        注册并登录
      </Button>
    </Form>
  );

  const tabs = [
    { key: 'login', label: '登录', children: loginForm },
    ...(registrationOpen
      ? [{ key: 'register', label: '注册', children: registerForm }]
      : []),
  ];

  return (
    <div className="nm-centered">
      <Card style={{ width: 400, boxShadow: '0 12px 32px rgba(58,50,48,0.10)' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <Typography.Title level={3} style={{ marginBottom: 4 }}>
            405nm
          </Typography.Title>
          <Typography.Text type="secondary">把喜欢的故事，分享给更多人</Typography.Text>
        </div>

        <Tabs
          activeKey={tab}
          onChange={(key) => setTab(key as 'login' | 'register')}
          items={tabs}
          centered
        />

        <Typography.Paragraph
          type="secondary"
          style={{ marginTop: 12, marginBottom: 0, fontSize: 12, color: comiku.inkSoft, textAlign: 'center' }}
        >
          {registrationOpen === false
            ? '当前未开放注册 —— 需要邀请码，请联系站点管理员。'
            : '忘记密码请联系站点管理员重置。'}
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
