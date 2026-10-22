import { Fragment, type ReactNode } from 'react';
import { parseMarkdown, type Inline } from '../lib/markdown.js';

interface MarkdownProps {
  content: string;
  /** Display name for a mention, or undefined for someone this client does not know. */
  nameOf: (userId: string) => string | undefined;
  meId: string;
  /** Rendered inline at the end of the last paragraph. */
  suffix?: ReactNode;
}

export function Markdown({ content, nameOf, meId, suffix }: MarkdownProps) {
  const blocks = parseMarkdown(content);
  const renderInline = (nodes: Inline[]): ReactNode =>
    nodes.map((node, index) => <InlineNode key={index} node={node} nameOf={nameOf} meId={meId} />);

  return (
    <>
      {blocks.map((block, index) => {
        const last = index === blocks.length - 1;
        switch (block.type) {
          case 'paragraph':
            return (
              <p key={index} className="md-paragraph">
                {renderInline(block.children)}
                {last && suffix}
              </p>
            );
          case 'quote':
            return (
              <blockquote key={index} className="md-quote">
                {renderInline(block.children)}
                {last && suffix}
              </blockquote>
            );
          case 'code':
            return (
              <Fragment key={index}>
                <pre className="md-codeblock" data-language={block.language || undefined}>
                  <code>{block.value}</code>
                </pre>
                {last && suffix}
              </Fragment>
            );
        }
      })}
    </>
  );
}

function InlineNode({
  node,
  nameOf,
  meId,
}: { node: Inline } & Pick<MarkdownProps, 'nameOf' | 'meId'>): ReactNode {
  const children = (nodes: Inline[]) =>
    nodes.map((child, index) => (
      <InlineNode key={index} node={child} nameOf={nameOf} meId={meId} />
    ));
  switch (node.type) {
    case 'text':
      return node.value;
    case 'break':
      return <br />;
    case 'code':
      return <code className="md-code">{node.value}</code>;
    case 'bold':
      return <strong>{children(node.children)}</strong>;
    case 'italic':
      return <em>{children(node.children)}</em>;
    case 'strike':
      return <del>{children(node.children)}</del>;
    case 'link':
      return (
        <a href={node.href} target="_blank" rel="noopener noreferrer">
          {node.label}
        </a>
      );
    case 'mention':
      return (
        <span className={node.userId === meId ? 'mention mention-me' : 'mention'}>
          @{nameOf(node.userId) ?? 'unknown'}
        </span>
      );
  }
}
