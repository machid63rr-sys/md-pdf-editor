import React, { useRef, useState } from 'react';
import { decodeUtf8Strict } from './decodeUtf8';
import type { ImportedDocument } from './documents';
import { classifyImport, type ReadFile } from './importFiles';

interface ImportViewProps {
  onImport: (document: ImportedDocument) => void;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

type PasteKind = 'markdown' | 'html';
const PASTE_LABEL: Readonly<Record<PasteKind, string>> = { markdown: 'Markdown', html: 'HTML' };

// 取り込める文書は、MarkdownまたはHTML(HTMLにはCSSファイルを添えられる)
const ACCEPT = '.md,.markdown,.mdown,.txt,.html,.htm,.css,text/markdown,text/plain,text/html,text/css';

/** 取り込み画面。ファイルの選択・ドラッグ&ドロップ(複数可)・貼り付けに対応する */
const ImportView: React.FC<ImportViewProps> = ({ onImport }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState('');
  const [pasteKind, setPasteKind] = useState<PasteKind>('markdown');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFiles = async (files: readonly File[]): Promise<void> => {
    const read: ReadFile[] = [];
    for (const file of files) {
      try {
        read.push({ name: file.name, text: decodeUtf8Strict(await file.arrayBuffer()) });
      } catch (cause) {
        setError(`「${file.name}」を読み込めませんでした。${messageOf(cause)}`);
        return;
      }
    }
    const result = classifyImport(read);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(null);
    onImport(result.document);
  };

  const importPasted = (): void => {
    if (pasted.trim() === '') {
      setError(`貼り付けた${PASTE_LABEL[pasteKind]}が空です。`);
      return;
    }
    setError(null);
    onImport(
      pasteKind === 'html'
        ? { kind: 'html', html: pasted, stylesheets: [], sourceName: null }
        : { kind: 'markdown', markdown: pasted, sourceName: null },
    );
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Markdown / HTML → PDF エディタ</h1>
      </header>
      <main className="import-view">
        <section
          className={`drop-zone${dragging ? ' drop-zone-active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const files = [...event.dataTransfer.files];
            if (files.length > 0) {
              void importFiles(files);
            }
          }}
        >
          <p>Markdown(.md / .markdown / .txt)またはHTML(.html / .htm)のファイルを、ここへドラッグ&ドロップ</p>
          <p className="drop-note">HTMLは、使っているCSSファイル(.css)も一緒に選ぶ(複数選択)と、見た目を反映して編集できます。</p>
          <p>
            <button type="button" className="button button-primary" onClick={() => fileInput.current?.click()}>
              ファイルを選択
            </button>
          </p>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              if (files.length > 0) {
                void importFiles(files);
              }
            }}
          />
        </section>

        <section className="paste-section">
          <label htmlFor="paste-area">または、貼り付ける</label>
          <fieldset className="paste-kind">
            <legend className="visually-hidden">貼り付ける内容の種類</legend>
            {(['markdown', 'html'] as const).map((kind) => (
              <label key={kind}>
                <input type="radio" name="paste-kind" checked={pasteKind === kind} onChange={() => setPasteKind(kind)} /> {PASTE_LABEL[kind]}
              </label>
            ))}
          </fieldset>
          <textarea
            id="paste-area"
            className="source-area paste-area"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            spellCheck={false}
          />
          <button type="button" className="button" onClick={importPasted}>
            貼り付けた内容を読み込む
          </button>
        </section>

        {error !== null && (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        )}
      </main>
    </div>
  );
};

export default ImportView;
