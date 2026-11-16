import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useServerStore } from '../../stores/useServerStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { BUILTIN_THEMES, getPrimaryButtonStyle } from '../../types/theme';
import type { ServerRecord, AuthType } from '../../types';

export const ServerModal: React.FC = () => {
  const { isServerModalOpen, toggleServerModal, editingServerId, themeId } =
    useSettingsStore();
  const { servers, saveServer } = useServerStore();
  const currentTheme = BUILTIN_THEMES[themeId] || BUILTIN_THEMES.aliyun;

  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState<AuthType>('key');
  // 密码与私钥分别维护，切换认证方式时互不覆盖，避免已填凭证被静默清空
  const [passwordCredential, setPasswordCredential] = useState('');
  const [keyCredential, setKeyCredential] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [groupName, setGroupName] = useState('');
  const [tags, setTags] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  /** 编辑已有主机时保存原凭证，用于密码留空时沿用（避免密码回显到 DOM） */
  const [existingCredential, setExistingCredential] = useState('');
  const [originalAuthType, setOriginalAuthType] = useState<AuthType>('key');
  const [hasStoredCredential, setHasStoredCredential] = useState(false);

  useEffect(() => {
    if (editingServerId) {
      const s = servers.find((item) => item.id === editingServerId);
      if (s) {
        setName(s.name);
        setHost(s.host);
        setPort(s.port);
        setUsername(s.username);
        setAuthType(s.auth_type);
        setOriginalAuthType(s.auth_type);
        setExistingCredential(s.credential || '');
        if (s.auth_type === 'password') {
          // 密码不回填到输入框，避免明文出现在 DOM；留空即沿用原密码
          setPasswordCredential('');
          setKeyCredential('');
        } else {
          setKeyCredential(s.credential || '');
          setPasswordCredential('');
        }
        setHasStoredCredential(Boolean(s.credential));
        setPassphrase(s.passphrase || '');
        setGroupName(s.group_name || '');
        setTags(s.tags || '');
        setErrorMsg('');
        return;
      }
    }
    // 新建主机：不预填任何账号、密码或分组，避免误用默认凭证
    setName('');
    setHost('');
    setPort(22);
    setUsername('');
    setAuthType('key');
    setPasswordCredential('');
    setKeyCredential('');
    setPassphrase('');
    setGroupName('');
    setTags('');
    setErrorMsg('');
    setExistingCredential('');
    setOriginalAuthType('key');
    setHasStoredCredential(false);
    setShowPassword(false);
    // 仅在切换编辑对象或重新打开弹窗时重置，避免服务器列表后台刷新覆盖正在编辑的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingServerId, isServerModalOpen]);

  if (!isServerModalOpen) return null;

  /** 解析最终要保存的凭证：密码留空且认证方式未变更时沿用原密码 */
  const resolveCredential = (): string => {
    if (authType === 'password') {
      const typed = passwordCredential.trim();
      if (typed) return typed;
      // 仅当原本就是密码认证时才沿用，避免把旧密码误用在新认证方式上
      const canReuse = hasStoredCredential && originalAuthType === 'password';
      return canReuse ? existingCredential : '';
    }
    return keyCredential.trim();
  };

  const handleSave = async () => {
    if (!name.trim() || !host.trim() || !username.trim()) {
      setErrorMsg('请填写完整的连接名称、主机地址与用户名');
      return;
    }

    const credential = resolveCredential();
    if (authType !== 'agent' && !credential) {
      setErrorMsg(
        authType === 'password'
          ? '密码认证方式必须填写登录密码'
          : '私钥认证方式必须填写私钥路径或私钥内容'
      );
      return;
    }

    const portValue = Number(port);
    if (!Number.isFinite(portValue) || portValue <= 0 || portValue > 65535) {
      setErrorMsg('端口号需为 1 ~ 65535 之间的整数');
      return;
    }

    const record: ServerRecord = {
      id: editingServerId || 'srv-' + Date.now(),
      name: name.trim(),
      host: host.trim(),
      port: portValue,
      username: username.trim(),
      auth_type: authType,
      // agent 认证不使用凭证，此时保留原凭证可避免切回时丢失已保存的密码/私钥
      credential: authType === 'agent' ? existingCredential || undefined : credential,
      passphrase: authType === 'key' ? passphrase.trim() || undefined : undefined,
      group_name: groupName.trim() || undefined,
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
              placeholder="例如：root 或 deploy"
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

          {authType === 'password' && (
            <div>
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>
                登录密码
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={passwordCredential}
                  onChange={(e) => setPasswordCredential(e.target.value)}
                  placeholder={
                    hasStoredCredential && originalAuthType === 'password'
                      ? '已保存密码，留空则沿用原密码'
                      : '请输入登录密码'
                  }
                  autoComplete="new-password"
                  className="w-full border rounded px-2.5 py-1.5 pr-14 focus:outline-none font-mono text-xs transition-colors"
                  style={{
                    backgroundColor: currentTheme.ui.inputBg,
                    borderColor: currentTheme.ui.border,
                    color: currentTheme.ui.text,
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded text-[10px] cursor-pointer hover:opacity-80"
                  style={{ color: currentTheme.ui.textMuted }}
                >
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
          )}

          {authType === 'key' && (
            <div>
              <label className="block mb-1" style={{ color: currentTheme.ui.textMuted }}>
                私钥绝对路径或内容
              </label>
              <textarea
                value={keyCredential}
                onChange={(e) => setKeyCredential(e.target.value)}
                placeholder="~/.ssh/id_ed25519 或粘贴私钥文本"
                rows={3}
                className="w-full border rounded px-2.5 py-1.5 focus:outline-none font-mono text-xs resize-none transition-colors"
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
                autoComplete="new-password"
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
                placeholder="例如：生产集群（可留空）"
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
            className="px-4 py-1.5 rounded text-xs font-semibold cursor-pointer hover:opacity-90 transition-opacity"
            style={getPrimaryButtonStyle(currentTheme)}
          >
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
};
