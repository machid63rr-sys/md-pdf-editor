import React, { useCallback, useMemo, useState } from 'react';
import type { MarkdownDocument } from './documents';
import { defaultBaseName } from './filename';
import { lintMarkdown } from './lint';
import type { OutputFile } from './outputMode';
import OutputPanel from './OutputPanel';
import { requestPdf } from './pdfClient';
import RichMarkdownEditor from './RichMarkdownEditor';
import WarningList from './WarningList';

interface EditViewProps {
  document: MarkdownDocument;
  onClose: () => void;
}

type EditorMode = 'rich' | 'source';

/** 保存できるファイル(Markdown・PDF) */
const outputFilesOf = (markdown: string): OutputFile[] => [
  {
    id: 'markdown',
    label: 'Markdown (.md)',
    shortLabel: 'MD',
    extension: 'md',
    content: { type: 'text', text: markdown, mimeType: 'text/markdown' },
  },
  { id: 'pdf', label: 'PDF (.pdf)', shortLabel: 'PDF', extension: 'pdf', content: { type: 'pdf' } },
];

/** プレビュー(書式付き編集)とMarkdown(ソース)を切り替えて編集し、出力する画面 */
const EditView: React.FC<EditViewProps> = ({ document, onClose }) => {
  // 現在のMarkdown(出力の対象)。編集のたびに更新される
  const [markdown, setMarkdown] = useState(document.markdown);
  // 書式付きエディタに渡す初期値。エディタの再マウント時にだけ現在のMarkdownへ更新する(入力中に渡し直さない)
  const [editorSeed, setEditorSeed] = useState(document.markdown);
  const [editorKey, setEditorKey] = useState(0);
  const [mode, setMode] = useState<EditorMode>('rich');
  const [parseError, setParseError] = useState<string | null>(null);

  const warnings = useMemo(() => lintMarkdown(markdown), [markdown]);
  const outputFiles = useMemo(() => outputFilesOf(markdown), [markdown]);

  const handleParseError = useCallback((message: string) => {
    setParseError(message);
    setMode('source');
  }, []);

  const switchMode = (next: EditorMode): void => {
    if (next === mode) {
      return;
    }
    if (next === 'rich') {
      setParseError(null);
      setEditorSeed(markdown);
      setEditorKey((key) => key + 1);
    }
    setMode(next);
  };

  const close = (): void => {
    if (markdown === document.markdown || window.confirm('編集内容は破棄されます。別のMarkdownを読み込みますか?')) {
      onClose();
    }
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Markdown / HTML → PDF エディタ</h1>
        <button type="button" className="button" onClick={close}>
          別のファイルを読み込む
        </button>
      </header>

      <main className="edit-view">
        <p className="source-name">
          {document.sourceName === null ? '貼り付けたMarkdown' : document.sourceName}
        </p>

        <WarningList warnings={warnings} />

        {parseError !== null && (
          <div role="alert" className="notice notice-error">
            <p>
              このMarkdownには、書式付きエディタで扱えない記法(脚注・参照形式のリンクなど)が含まれています。
              「Markdown」タブで編集してください。PDFは通常どおり出力できます。
            </p>
            <details>
              <summary>詳細</summary>
              <pre className="error-detail">{parseError}</pre>
            </details>
          </div>
        )}

        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'rich'}
            className={`tab${mode === 'rich' ? ' tab-active' : ''}`}
            onClick={() => switchMode('rich')}
          >
            プレビュー(書式付きで編集)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            className={`tab${mode === 'source' ? ' tab-active' : ''}`}
            onClick={() => switchMode('source')}
          >
            Markdown
          </button>
        </div>

        <div className="editor-pane" role="tabpanel">
          {mode === 'rich' ? (
            <RichMarkdownEditor
              key={editorKey}
              initialMarkdown={editorSeed}
              onChange={setMarkdown}
              onParseError={handleParseError}
            />
          ) : (
            <textarea
              className="source-area"
              aria-label="Markdown"
              value={markdown}
              onChange={(event) => setMarkdown(event.target.value)}
              spellCheck={false}
            />
          )}
        </div>
        <p className="hint">
          「プレビュー」で一度でも編集すると、Markdown全体の書き方が正規化されます(箇条書きの記号、表の桁揃えなど。内容は保たれます)。
          PDFはサーバ側のフォントで描画されるため、プレビューと字形や改ページ位置が少し異なることがあります。
        </p>

        <OutputPanel
          files={outputFiles}
          defaultBaseName={defaultBaseName(document.sourceName)}
          generatePdf={() => requestPdf({ kind: 'markdown', text: markdown })}
          empty={markdown.trim() === ''}
        />
      </main>
    </div>
  );
};

export default EditView;
