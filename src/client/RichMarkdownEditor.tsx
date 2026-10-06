import React from 'react';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  tablePlugin,
  imagePlugin,
  frontmatterPlugin,
  codeBlockPlugin,
  codeMirrorPlugin,
  markdownShortcutPlugin,
  toolbarPlugin,
  UndoRedo,
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ListsToggle,
  InsertTable,
  InsertCodeBlock,
  InsertThematicBreak,
  Separator,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import { escapeForMdx, unescapeFromMdx } from './mdxEscape';

interface RichMarkdownEditorProps {
  // 編集モードに入った時点のMarkdown(以降の変更は内部で保持し、onChangeで親へ通知する)
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  // Markdownを書式付きで解釈できなかった場合(サイレントに握りつぶさず親へ通知する)
  onParseError: (message: string) => void;
  // 画像の参照(相対パスなど)を、エディタ内に表示できるURL(data: URIなど)にする。Markdownの本文は書き換えない
  resolveImage: (source: string) => Promise<string>;
}

// 一覧に無い言語のコードブロックも、解釈エラーにならず通常どおり扱われる(実測済み)
const CODE_BLOCK_LANGUAGES = {
  txt: 'テキスト',
  md: 'Markdown',
  json: 'JSON',
  yaml: 'YAML',
  js: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  python: 'Python',
  bash: 'Bash',
  sh: 'Shell',
  sql: 'SQL',
  html: 'HTML',
  css: 'CSS',
  java: 'Java',
  cs: 'C#',
  cpp: 'C++',
  c: 'C',
  go: 'Go',
  rust: 'Rust',
  diff: 'Diff',
  mermaid: 'Mermaid',
};

/**
 * 書式付き(WYSIWYG)編集。描画された見出し・表・箇条書きをそのまま編集でき、
 * 編集内容は裏のMarkdownへ反映される。
 *
 * - 編集モードを切り替えるたびに再マウントされ、その時点のMarkdownから開始する
 *   (このコンポーネントの外でMarkdownが書き換わる経路は、構文モードのtextareaのみ)
 * - 初期表示時にエディタが行う整形(空白・記号の正規化)は編集として扱わない。
 *   利用者が触っていない本文が、取り込んだMarkdownから勝手に書き換わるのを避けるため。
 * - 解釈できない記法(脚注・参照形式のリンクなど)があると onParseError で通知する
 * - 取り込んだ画像(相対パスの画像)は、resolveImage で表示用のURLにして表示する
 */
const RichMarkdownEditor: React.FC<RichMarkdownEditorProps> = ({ initialMarkdown, onChange, onParseError, resolveImage }) => (
  <MDXEditor
    className="md-editor"
    contentEditableClassName="md-editor-content"
    markdown={escapeForMdx(initialMarkdown)}
    onChange={(markdown, initialMarkdownNormalize) => {
      if (!initialMarkdownNormalize) {
        onChange(unescapeFromMdx(markdown));
      }
    }}
    onError={({ error }) => onParseError(error)}
    plugins={[
      headingsPlugin(),
      listsPlugin(),
      quotePlugin(),
      thematicBreakPlugin(),
      linkPlugin(),
      tablePlugin(),
      imagePlugin({ imagePreviewHandler: resolveImage }),
      frontmatterPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: 'txt' }),
      codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
      markdownShortcutPlugin(),
      toolbarPlugin({
        toolbarContents: () => (
          <>
            <UndoRedo />
            <Separator />
            <BlockTypeSelect />
            <BoldItalicUnderlineToggles options={['Bold', 'Italic']} />
            <ListsToggle />
            <Separator />
            <InsertTable />
            <InsertCodeBlock />
            <InsertThematicBreak />
          </>
        ),
      }),
    ]}
  />
);

export default RichMarkdownEditor;
