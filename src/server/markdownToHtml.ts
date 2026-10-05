import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { visit, SKIP } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import type { Root as MdastRoot, Heading, PhrasingContent, RootContent } from 'mdast';
import type { Root as HastRoot } from 'hast';

/*
 * Markdown → HTML(PDF用)。
 * - 生HTMLは実行も黙殺もせず、文字としてそのまま表示する(例: <br> は「<br>」と表示される)
 * - front matter(YAML)は、内容を失わないようコードブロックとして表示する
 * - 段落内の改行はすべて改行として扱う(編集画面の表示と揃えるため)
 * - リンクは http/https/mailto/tel と相対URLのみ有効。それ以外は「文字 (URL)」に置き換える
 * - 画像は data URI(png/jpeg/gif/webp)のみ表示。それ以外は「[画像: 代替文](URL)」の文字にする
 */

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const DATA_IMAGE_URL = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition']);

function isAllowedLink(url: string): boolean {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*:)/.exec(url.trim());
  return scheme === null || ALLOWED_LINK_PROTOCOLS.has((scheme[1] ?? '').toLowerCase());
}

// 改行を含む文字列を「text, break, text ...」の並びにする(HTMLでは素の改行が空白に潰れるため)
function textWithBreaks(value: string): PhrasingContent[] {
  const nodes: PhrasingContent[] = [];
  value.split('\n').forEach((line, index) => {
    if (index > 0) {
      nodes.push({ type: 'break' });
    }
    if (line !== '') {
      nodes.push({ type: 'text', value: line.replace(/\r$/, '') });
    }
  });
  return nodes;
}

// 生HTML(html)とfront matter(yaml)を、実行もせず消しもしない形に置き換える
function remarkNeutralizeRawContent() {
  return (tree: MdastRoot): void => {
    visit(tree, (node, index, parent) => {
      if (parent === undefined || index === undefined) {
        return undefined;
      }
      let replacement: RootContent[];
      if (node.type === 'html') {
        const inline = textWithBreaks(node.value);
        replacement = FLOW_PARENTS.has(parent.type) ? [{ type: 'paragraph', children: inline }] : inline;
      } else if (node.type === 'yaml') {
        replacement = [{ type: 'code', lang: 'yaml', value: node.value }];
      } else {
        return undefined;
      }
      parent.children.splice(index, 1, ...(replacement as typeof parent.children));
      return [SKIP, index + replacement.length];
    });
  };
}

// 参照形式(定義+参照)や自動リンクを含め、HTMLに変換された後のURLをまとめて検査する
function rehypeNeutralizeUrls() {
  return (tree: HastRoot): void => {
    visit(tree, 'element', (node, index, parent) => {
      if (node.tagName === 'a') {
        const href = node.properties['href'];
        if (typeof href === 'string' && !isAllowedLink(href)) {
          delete node.properties['href'];
          node.children.push({ type: 'text', value: ` (${href})` });
        }
        return undefined;
      }
      if (node.tagName === 'img' && parent !== undefined && index !== undefined) {
        const src = node.properties['src'];
        if (typeof src === 'string' && DATA_IMAGE_URL.test(src)) {
          return undefined;
        }
        const alt = typeof node.properties['alt'] === 'string' ? node.properties['alt'] : '';
        parent.children.splice(index, 1, { type: 'text', value: `[画像: ${alt}](${String(src ?? '')})` });
        return [SKIP, index + 1];
      }
      return undefined;
    });
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkBreaks)
  .use(remarkNeutralizeRawContent)
  .use(remarkRehype)
  .use(rehypeNeutralizeUrls)
  .use(rehypeStringify)
  .freeze();

const UNTITLED = '無題';

function extractTitle(tree: MdastRoot): string {
  let title = UNTITLED;
  visit(tree, 'heading', (node: Heading) => {
    if (node.depth === 1) {
      title = toString(node).trim() || UNTITLED;
      return false;
    }
    return undefined;
  });
  return title;
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface RenderedMarkdown {
  readonly title: string;
  readonly bodyHtml: string;
}

export function renderMarkdown(markdown: string): RenderedMarkdown {
  const mdast = processor.parse(markdown);
  const title = extractTitle(mdast);
  const hast = processor.runSync(mdast) as HastRoot;
  return { title, bodyHtml: String(processor.stringify(hast)) };
}

// PDF化するHTML全体。メタタグのCSPは、Chromium側の通信遮断に加えた二重の防御
export function buildDocumentHtml(markdown: string, css: string): string {
  const { title, bodyHtml } = renderMarkdown(markdown);
  return [
    '<!doctype html>',
    '<html lang="ja"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style>${css}</style>`,
    `</head><body class="document">${bodyHtml}</body></html>`,
  ].join('');
}
