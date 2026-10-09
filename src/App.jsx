import React, { useState, useEffect, useRef } from 'react';
import { Bubble, Sender, XProvider, Welcome } from '@ant-design/x';
import { ConfigProvider, App as AntdApp, theme, Input, Button, Card, List, Layout, Popconfirm } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import axios from 'axios';

const API_BASE = "http://localhost:8000";

// 用独立 axios 实例，token 通过 defaults 注入，不再每次 render 注册拦截器
const api = axios.create({ baseURL: API_BASE });

const ChatApp = () => {
  const [token, setToken] = useState(localStorage.getItem("async_demo_token") || "");
  const [isLogin, setIsLogin] = useState(!!token);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sessionList, setSessionList] = useState([]);
  const abortControllerRef = useRef(null);
  const messagesEndRef = useRef(null);

  // token 变化时同步到请求实例
  useEffect(() => {
    if (token) {
      api.defaults.headers.common.Authorization = `Bearer ${token}`;
    } else {
      delete api.defaults.headers.common.Authorization;
    }
  }, [token]);

  // 登录后才拉会话列表
  useEffect(() => {
    if (isLogin) loadSessionList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLogin]);

  // 新消息自动滚到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 用 AntdApp.useApp() 拿到带 context 的 message（修复静态方法告警）
  const { message } = AntdApp.useApp();

  // 统一的登录态清除（登录过期时调用）
  const forceLogout = (tip = "登录已过期，请重新登录") => {
    localStorage.removeItem("async_demo_token");
    setToken("");
    setIsLogin(false);
    message.error(tip);
  };

  // 登录逻辑（注册成功后会复用此函数直接登录）
  const doLogin = async (user, pass) => {
    const formData = new FormData();
    formData.append("username", user);
    formData.append("password", pass);
    const res = await api.post(`/api/users/login`, formData);
    localStorage.setItem("async_demo_token", res.data.access_token);
    setToken(res.data.access_token);
    setIsLogin(true);
    return res.data.access_token;
  };

  const handleLogin = async () => {
    try {
      await doLogin(username, password);
      message.success("登录成功");
    } catch (e) {
      message.error("用户名或密码错误");
    }
  };

  // 注册逻辑：注册完自动登录
  const handleRegister = async () => {
    try {
      await api.post(`/api/users/register`, { username, password });
      message.success("注册成功，正在自动登录");
      await doLogin(username, password); // 注册即登录，无需二次输入
    } catch (e) {
      message.error(e?.response?.data?.detail || "注册失败");
    }
  };

  // 加载会话列表（401 自动退出）
  const loadSessionList = async () => {
    try {
      const res = await api.get(`/api/chat/history/sessions`);
      setSessionList(res.data);
    } catch (e) {
      if (e?.response?.status === 401) forceLogout();
    }
  };

  // 选中历史会话加载消息
  const selectSession = async (sessionId) => {
    abortControllerRef.current?.abort(); // 切换会话先中止正在进行的流
    setCurrentSessionId(sessionId);
    setMessages([]);
    try {
      const res = await api.get(`/api/chat/history/sessions/${sessionId}`);
      // 后端返回 { code, data }，需取 res.data.data
      const formatted = (res.data.data || []).map((item, idx) => ({
        id: item.id ?? idx,
        role: item.role,
        content: item.content,
      }));
      setMessages(formatted);
    } catch (e) {
      if (e?.response?.status === 401) return forceLogout();
      message.error("加载会话失败");
    }
  };

  // 新建会话清空当前聊天
  const createNewChat = () => {
    abortControllerRef.current?.abort();
    setCurrentSessionId(null);
    setMessages([]);
  };

  // 删除会话（多任务管理）
  const deleteSession = async (sessionId) => {
    try {
      await api.delete(`/api/chat/history/${sessionId}`);
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
        setMessages([]);
      }
      message.success("已删除会话");
      loadSessionList();
    } catch (e) {
      print('XXXXXXX')
      if (e?.response?.status === 401) return forceLogout();
      message.error("删除失败");
    }
  };

  // 主动停止生成
  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  // 发送流式消息
  const handleSendMessage = async (content) => {
    setInputValue('');
    if (!content.trim() || isStreaming) return;
    const userMessage = { id: Date.now(), role: 'user', content };
    setMessages(prev => [...prev, userMessage]);
    const aiMessageId = Date.now() + 1;
    setMessages(prev => [...prev, { id: aiMessageId, role: 'ai', content: '' }]);
    setIsStreaming(true);

    // 120 秒兜底，绝对不会永久卡在 loading
    let loadingSafeGuard = setTimeout(() => {
      setIsStreaming(false);
      message.warning("请求超时，已自动结束流式状态");
    }, 120000);

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(`${API_BASE}/api/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ user_input: content, session_id: currentSessionId }),
        signal: abortControllerRef.current.signal,
      });

      // 流式接口 token 过期 → 强制重登
      if (response.status === 401) {
        forceLogout();
        return;
      }
      if (!response.ok) throw new Error(`请求失败，状态码 ${response.status}`);

      // 从响应头取出新生成的会话ID
      const newSessionId = response.headers.get('x-session-id');
      if (!currentSessionId && newSessionId) {
        setCurrentSessionId(Number(newSessionId));
        setTimeout(loadSessionList, 500); // 新会话立即出现在侧边栏
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let fullAiContent = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          const dataLine = block.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          let payload;
          try {
            payload = JSON.parse(dataLine.slice(6)); // 后端统一 JSON 序列化
          } catch {
            continue;
          }

          if (payload.type === 'content') {
            fullAiContent += payload.data;
            setMessages(prev => prev.map(msg =>
              msg.id === aiMessageId ? { ...msg, content: fullAiContent } : msg
            ));
          } else if (payload.type === 'done') {
            return; // 流正常结束，直接进入 finally
          } else if (payload.type === 'error') {
            setMessages(prev => prev.map(msg =>
              msg.id === aiMessageId
                ? { ...msg, content: `⚠️ 出错了：${payload.data}` }
                : msg
            ));
            message.error(payload.data);
            return;
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        setMessages(prev => prev.map(msg =>
          msg.id === aiMessageId
            ? { ...msg, content: `⚠️ 出错了：${e.message || '请求失败'}` }
            : msg
        ));
        message.error(`请求失败：${e.message}`);
      } else {
        // 用户主动停止：定格已生成内容
        setMessages(prev => prev.map(msg =>
          msg.id === aiMessageId ? { ...msg, content: fullAiContent || '（已停止）' } : msg
        ));
      }
    } finally {
      clearTimeout(loadingSafeGuard);
      setIsStreaming(false);
      setTimeout(loadSessionList, 300);
    }
  };


  // 未登录页面
  if (!isLogin) {
    return (
      <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
        <div style={{ maxWidth: 400, margin: '15vh auto' }}>
          <Card title="asyncmy 异步问答系统 登录" style={{ borderRadius: 12 }}>
            <div style={{ marginBottom: 16 }}>
              <Input placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} size="large" />
            </div>
            <div style={{ marginBottom: 24 }}>
              <Input.Password placeholder="密码" value={password} onChange={e => setPassword(e.target.value)} size="large" />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <Button type="primary" block onClick={handleLogin} size="large">登录</Button>
              <Button block onClick={handleRegister} size="large">注册</Button>
            </div>
          </Card>
        </div>
      </ConfigProvider>
    );
  }

  // 主聊天页面
  return (
    <ConfigProvider theme={{ algorithm: theme.defaultAlgorithm }}>
      <XProvider>
        <Layout style={{ height: '100vh' }}>
          <Layout.Sider width={280} style={{ background: '#f7f8fa', padding: '16px' }}>
            <Button type="primary" block onClick={createNewChat} style={{ marginBottom: 16 }}>新建对话</Button>
            <List
              dataSource={sessionList}
              renderItem={item => (
                <List.Item
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderRadius: 8,
                    background: currentSessionId === item.session_id ? '#e6f4ff' : 'transparent',
                  }}
                  onClick={() => selectSession(item.session_id)}
                  actions={[
                    <Popconfirm
                      key="del"
                      title="确定删除该会话？"
                      onConfirm={() => deleteSession(item.session_id)}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        onClick={e => e.stopPropagation()}
                      >删除</Button>
                    </Popconfirm>,
                  ]}
                >
                  {item.first_message?.length > 15 ? item.first_message.slice(0, 15) + '...' : item.first_message}
                </List.Item>
              )}
            />
          </Layout.Sider>
          <Layout.Content style={{ padding: '20px 40px', display: 'flex', flexDirection: 'column' }}>
            <Welcome title="asyncmy 异步MySQL 练习Demo" description="自动持久化所有对话历史" style={{ marginBottom: 20 }} />
            <div style={{ flex: 1, overflowY: 'auto', marginBottom: 20, padding: 10 }}>
              {messages.map(msg => (
                <Bubble
                  key={msg.id}
                  role={msg.role}
                  content={
                    msg.role === 'ai'
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                      : msg.content
                  }
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
            <Sender
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleSendMessage}
              onCancel={handleStop}
              loading={isStreaming}
              placeholder="输入问题回车发送"
            />
          </Layout.Content>
        </Layout>
      </XProvider>
    </ConfigProvider>
  );
};


const App = () => (
  <AntdApp>
    <ChatApp />
  </AntdApp>
);

export default App;
