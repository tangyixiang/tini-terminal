import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useServerStore } from '../../stores/useServerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES } from '../../types/theme';
import type { ServerRecord, AuthType } from '../../types';

export const ServerModal: React.FC = () => {
  const { isServerModalOpen, toggleServerModal, editingServerId, themeId } =
    useSettingsStore();
  const { servers, saveServer } = useServerStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('root');
  const [authType, setAuthType] = useState<AuthType>('key');
  const [credential, setCredential] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [groupName, setGroupName] = useState('生产环境');
  const [tags, setTags] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (editingServerId) {
      const s = servers.find((item) => item.id === editingServerId);
      if (s) {
        setName(s.name);
        setHost(s.host);
        setPort(s.port);
        setUsername(s.username);
        setAuthType(s.auth_type);
        setCredential(s.credential || '');
        setPassphrase(s.passphrase || '');
        setGroupName(s.group_name || '默认分组');
        setTags(s.tags || '');
        return;
      }
    }
    // 重置为默认值
    setName('');
    setHost('');
    setPort(22);
    setUsername('root');
    setAuthType('key');
    setCredential('~/.ssh/id_ed25519');
    setPassphrase('');
    setGroupName('生产环境');
    setTags('');
    setErrorMsg('');
  }, [editingServerId, isServerModalOpen]);

  if (!isServerModalOpen) return null;

  const handleSave = async () => {
    if (!name.trim() || !host.trim() || !username.trim()) {
      setErrorMsg('请填写完整的连接名称、主机地址与用户名');
      return;
    }

    const record: ServerRecord = {
      id: editingServerId || 'srv-' + Date.now(),
      name: name.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      username: username.trim(),
      auth_type: authType,
      credential: credential.trim() || undefined,
      passphrase: passphrase.trim() || undefined,
      group_name: groupName.trim() || '默认分组',
      tags: tags.trim() || undefined,
      created_at: Date.now(),
    };

    try {
      await saveServer(record);
      toggleServerModal(false);
    } catch (e: any) {
      setErrorMsg(e?.message || '保存主机配置失败');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/65 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none">
      <div
        className="rounded-xl w-full max-w-md p-5 shadow-2xl space-y-4 border"
        style={{
          backgroundColor: currentTheme.ui.cardBg,
          borderColor: currentTheme.ui.border,
          color: currentTheme.ui.text,
        }}
      >
        <div
          className="flex items-center justify-between border-b pb-3"
          style={{ borderColor: currentTheme.ui.border }}
        >
          <h3 className="text-sm font-semibold" style={{ color: currentTheme.ui.text }}>
            {editingServerId ? '编辑主机配置' : '新建主机配置'}
          </h3>
          <button
            onClick={() => toggleServerModal(false)}
            className="p-1 rounded cursor-pointer hover:opacity-100 opacity-60 transition-opacity"
            style={{ color: currentTheme.ui.text }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {errorMsg && (
          <div className="text-xs text-red-400 bg-red-950/40 border border-red-800/60 p-2 rounded">
            {errorMsg}
          </div>
        )}

        <div className="space-y-3 text-xs">
          <div>
            <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>连接名称</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：prod-gateway"
              className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
              style={{
                backgroundColor: currentTheme.ui.inputBg,
                borderColor: currentTheme.ui.border,
                color: currentTheme.ui.text,
              }}
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2">
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>主机地址 (IP 或域名)</label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.inputBg,
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.text,
                }}
              />
            </div>
            <div>
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>端口</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(Number(e.target.value))}
                className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.inputBg,
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.text,
                }}
              />
            </div>
          </div>

          <div>
            <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>登录用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
              style={{
                backgroundColor: currentTheme.ui.inputBg,
                borderColor: currentTheme.ui.border,
                color: currentTheme.ui.text,
              }}
            />
          </div>

          <div>
            <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>认证方式</label>
            <select
              value={authType}
              onChange={(e) => setAuthType(e.target.value as AuthType)}
              className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
              style={{
                backgroundColor: currentTheme.ui.inputBg,
                borderColor: currentTheme.ui.border,
                color: currentTheme.ui.text,
              }}
            >
              <option value="key">SSH 私钥文件或密钥文本</option>
              <option value="password">密码认证</option>
              <option value="agent">本地 SSH Agent</option>
            </select>
          </div>

          {authType !== 'agent' && (
            <div>
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>
                {authType === 'password' ? '登录密码' : '私钥绝对路径或内容'}
              </label>
              <input
                type={authType === 'password' ? 'password' : 'text'}
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={authType === 'password' ? '输入密码' : '~/.ssh/id_ed25519'}
                className="w-full border rounded px-2.5 py-1.5 focus:outline-none font-mono text-xs transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.inputBg,
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.text,
                }}
              />
            </div>
          )}

          {authType === 'key' && (
            <div>
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>私钥密码 (可选)</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="若私钥受 Passphrase 保护请填写"
                className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.inputBg,
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.text,
                }}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>所属分组</label>
              <input
                type="text"
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="例如：生产集群"
                className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.inputBg,
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.text,
                }}
              />
            </div>
            <div>
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>标签分类</label>
              <input
                type="text"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="web,nginx,db"
                className="w-full border rounded px-2.5 py-1.5 focus:outline-none transition-colors"
                style={{
                  backgroundColor: currentTheme.ui.inputBg,
                  borderColor: currentTheme.ui.border,
                  color: currentTheme.ui.text,
                }}
              />
            </div>
          </div>
        </div>

        <div
          className="flex items-center justify-end gap-2 pt-3 border-t"
          style={{ borderColor: currentTheme.ui.border }}
        >
          <button
            onClick={() => toggleServerModal(false)}
            className="px-4 py-1.5 rounded border text-xs cursor-pointer hover:opacity-80 transition-opacity"
            style={{
              backgroundColor: currentTheme.ui.hoverBg,
              borderColor: currentTheme.ui.border,
              color: currentTheme.ui.text,
            }}
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1.5 rounded text-xs font-semibold cursor-pointer text-black hover:opacity-90 transition-opacity"
            style={{ backgroundColor: '#23d18b', color: '#064e3b' }}
          >
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
};
