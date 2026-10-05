import React, { useRef, useState } from 'react';
import { decodeUtf8Strict } from './decodeUtf8';

export interface ImportedDocument {
  readonly markdown: string;
  // 取り込んだファイル名。貼り付けの場合はnull
  readonly sourceName: string | null;
}

interface ImportViewProps {
  onImport: (document: ImportedDocument) => void;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Markdownの取り込み画面。ファイルの選択・ドラッグ&ドロップ・貼り付けに対応する */
const ImportView: React.FC<ImportViewProps> = ({ onImport }) => {
  const fileInput = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importFile = async (file: File): Promise<void> => {
    try {
      const markdown = decodeUtf8Strict(await file.arrayBuffer());
      if (markdown.trim() === '') {
        setError(`「${file.name}」は空のファイルです。`);
        return;
      }
      setError(null);
      onImport({ markdown, sourceName: file.name });
    } catch (cause) {
      setError(`「${file.name}」を読み込めませんでした。${messageOf(cause)}`);
    }
  };

  const importPasted = (): void => {
    if (pasted.trim() === '') {
      setError('貼り付けたMarkdownが空です。');
      return;
    }
    setError(null);
    onImport({ markdown: pasted, sourceName: null });
  };

  return (
    <div className="app">
      <header className="app-header">
        <h1>Markdown → PDF エディタ</h1>
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
            const file = event.dataTransfer.files[0];
            if (file !== undefined) {
              void importFile(file);
            }
          }}
        >
          <p>Markdownファイル(.md / .markdown / .txt)をここへドラッグ&ドロップ</p>
          <p>
            <button type="button" className="button button-primary" onClick={() => fileInput.current?.click()}>
              ファイルを選択
            </button>
          </p>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.markdown,.mdown,.txt,text/markdown,text/plain"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) {
                void importFile(file);
              }
            }}
          />
        </section>

        <section className="paste-section">
          <label htmlFor="paste-area">または、Markdownを貼り付ける</label>
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
