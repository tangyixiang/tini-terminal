import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, Terminal, Code2 } from 'lucide-react';
import type { ThemeConfig } from '../../types/theme';

interface MarkdownViewProps {
  content: string;
  theme: ThemeConfig;
  baseFontSize?: number;
  isStreaming?: boolean;
}

interface CodeBlockProps {
  className?: string;
  children?: React.ReactNode;
  theme: ThemeConfig;
  codeFontSize: number;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ className, children, theme, codeFontSize }) => {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';
  const rawCode = String(children || '').replace(/\n$/, '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略复制失败
    }
  };

  const isShell = ['bash', 'sh', 'shell', 'zsh', 'sh'].includes(language.toLowerCase());

  return (
    <div
      className="my-2.5 rounded border overflow-hidden transition-colors"
      style={{
        backgroundColor: theme.ui.inputBg,
        borderColor: theme.ui.border,
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b select-none"
        style={{
          backgroundColor: theme.ui.hoverBg,
          borderColor: theme.ui.border,
          color: theme.ui.textMuted,
        }}
      >
        <div className="flex items-center gap-1.5 font-mono">
          {isShell ? (
            <Terminal className="w-3.5 h-3.5 opacity-80" />
          ) : (
            <Code2 className="w-3.5 h-3.5 opacity-80" />
          )}
          <span className="font-semibold uppercase text-[11px] tracking-wider">
            {language || 'code'}
          </span>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-0.5 rounded transition-colors cursor-pointer hover:opacity-100 opacity-70"
          style={{
            color: copied ? '#10b981' : theme.ui.text,
          }}
          title={copied ? '已复制' : '复制代码'}
        >
          {copied ? (
            <>
              <Check className="w-3 h-3 text-emerald-400" />
              <span className="text-[11px]">已复制</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span className="text-[11px]">复制</span>
            </>
          )}
        </button>
      </div>
      <div className="p-2.5 overflow-x-auto">
        <pre
          className="font-mono leading-relaxed"
          style={{
            fontSize: `${codeFontSize}px`,
            color: theme.ui.text,
            margin: 0,
          }}
        >
          <code>{rawCode}</code>
        </pre>
      </div>
    </div>
  );
};

export const MarkdownView: React.FC<MarkdownViewProps> = ({
  content,
  theme,
  baseFontSize = 14,
  isStreaming = false,
}) => {
  const codeFontSize = Math.max(11, Math.round(baseFontSize * 0.9));
  const smallFontSize = Math.max(10, Math.round(baseFontSize * 0.8));

  return (
    <div className="markdown-body leading-relaxed break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            if (React.isValidElement(children)) {
              const childProps = children.props as { className?: string; children?: React.ReactNode };
              return (
                <CodeBlock
                  className={childProps?.className}
                  theme={theme}
                  codeFontSize={codeFontSize}
                >
                  {childProps?.children}
                </CodeBlock>
              );
            }
            return <pre className="p-2 overflow-x-auto">{children}</pre>;
          },
          code({ className, children, ...props }) {
            return (
              <code
                className="px-1.5 py-0.5 rounded font-mono border text-[0.88em] align-baseline"
                style={{
                  backgroundColor: theme.ui.inputBg,
                  borderColor: theme.ui.border,
                  color: theme.ui.accent,
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          h1({ children }) {
            return (
              <h1
                className="font-bold border-b pb-1 mt-3.5 mb-2 first:mt-0"
                style={{
                  fontSize: `${Math.round(baseFontSize * 1.25)}px`,
                  borderColor: theme.ui.border,
                  color: theme.ui.text,
                }}
              >
                {children}
              </h1>
            );
          },
          h2({ children }) {
            return (
              <h2
                className="font-semibold border-b pb-0.5 mt-3 mb-1.5 first:mt-0"
                style={{
                  fontSize: `${Math.round(baseFontSize * 1.15)}px`,
                  borderColor: theme.ui.border,
                  color: theme.ui.text,
                }}
              >
                {children}
              </h2>
            );
          },
          h3({ children }) {
            return (
              <h3
                className="font-semibold mt-2.5 mb-1 first:mt-0"
                style={{
                  fontSize: `${Math.round(baseFontSize * 1.05)}px`,
                  color: theme.ui.text,
                }}
              >
                {children}
              </h3>
            );
          },
          h4({ children }) {
            return (
              <h4
                className="font-semibold mt-2 mb-1 first:mt-0"
                style={{
                  fontSize: `${baseFontSize}px`,
                  color: theme.ui.text,
                }}
              >
                {children}
              </h4>
            );
          },
          p({ children }) {
            return (
              <p
                className="my-1.5 leading-relaxed first:mt-0 last:mb-0"
                style={{ color: theme.ui.text }}
              >
                {children}
              </p>
            );
          },
          ul({ children }) {
            return (
              <ul className="list-disc list-outside ml-4 my-2 space-y-1">
                {children}
              </ul>
            );
          },
          ol({ children }) {
            return (
              <ol className="list-decimal list-outside ml-4 my-2 space-y-1">
                {children}
              </ol>
            );
          },
          li({ children }) {
            return (
              <li className="leading-relaxed" style={{ color: theme.ui.text }}>
                {children}
              </li>
            );
          },
          blockquote({ children }) {
            return (
              <blockquote
                className="border-l-2 pl-3 my-2 opacity-85 italic"
                style={{
                  borderColor: theme.ui.accent,
                  color: theme.ui.textMuted,
                }}
              >
                {children}
              </blockquote>
            );
          },
          hr() {
            return (
              <hr
                className="my-3 border-t"
                style={{ borderColor: theme.ui.border }}
              />
            );
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:opacity-80 transition-opacity font-medium"
                style={{ color: theme.ui.accent }}
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div
                className="overflow-x-auto my-2 rounded border"
                style={{ borderColor: theme.ui.border }}
              >
                <table
                  className="w-full text-left border-collapse"
                  style={{ fontSize: `${smallFontSize}px` }}
                >
                  {children}
                </table>
              </div>
            );
          },
          th({ children, style }) {
            return (
              <th
                className="px-2.5 py-1.5 font-semibold border-b"
                style={{
                  ...style,
                  backgroundColor: theme.ui.hoverBg,
                  borderColor: theme.ui.border,
                  color: theme.ui.text,
                }}
              >
                {children}
              </th>
            );
          },
          td({ children, style }) {
            return (
              <td
                className="px-2.5 py-1.5 border-b last:border-b-0"
                style={{
                  ...style,
                  borderColor: theme.ui.border,
                  color: theme.ui.text,
                }}
              >
                {children}
              </td>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>

      {/* 流式生成中的打字指示光标 */}
      {isStreaming && (
        <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-400 animate-pulse align-middle" />
      )}
    </div>
  );
};
