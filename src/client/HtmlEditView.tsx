import React, { useDeferredValue, useMemo, useRef, useState } from 'react';
import type { HtmlDocument } from './documents';
import { defaultBaseName } from './filename';
import { composeHtml, type Stylesheet } from './htmlCompose';
import { patchHtmlSource } from './htmlPatch';
import HtmlPreview, { type HtmlPreviewHandle } from './HtmlPreview';
import { lintHtml } from './lintHtml';
import type { OutputFile } from './outputMode';
import OutputPanel from './OutputPanel';
import { requestPdf } from './pdfClient';
import WarningList from './WarningList';

interface HtmlEditViewProps {
  document: HtmlDocument;
  onClose: () => void;
}

// 'preview' | 'html' | 'css:<ファイル名>'
type Tab = string;
const PREVIEW_TAB = 'preview';
const HTML_TAB = 'html';
const cssTab = (name: string): Tab => `css:${name}`;

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** 保存できるファイル(HTML・CSS・PDF) */
const outputFilesOf = (html: string, stylesheets: readonly Stylesheet[]): OutputFile[] => [
  { id: 'html', label: 'HTML (.html)', shortLabel: 'HTML', extension: 'html', content: { type: 'text', text: html, mimeType: 'text/html' } },
  ...stylesheets.map(
    (stylesheet): OutputFile => ({
      id: `css:${stylesheet.name}`,
      label: `CSS (${stylesheet.name})`,
      shortLabel: 'CSS',
      extension: 'css',
      fixedName: stylesheet.name,
      content: { type: 'text', text: stylesheet.text, mimeType: 'text/css' },
    }),
  ),
  { id: 'pdf', label: 'PDF (.pdf)', shortLabel: 'PDF', extension: 'pdf', content: { type: 'pdf' } },
];

/**
 * HTML(とCSS)を編集して出力する画面。
 * - プレビュー: 表示を見ながら直接編集する。編集した箇所だけが、元のHTMLへ反映される
 * - HTML / CSS: ソースを直接編集する。隣のプレビューに、編集内容がすぐ反映される
 */
const HtmlEditView: React.FC<HtmlEditViewProps> = ({ document, onClose }) => {
  const [html, setHtml] = useState(document.html);
  const [stylesheets, setStylesheets] = useState<readonly Stylesheet[]>(document.stylesheets);
  const [tab, setTab] = useState<Tab>(PREVIEW_TAB);
  // プレビューを開いた時点のHTML。プレビュー上の編集は、これとの差分として元のHTMLへ反映する
  // (編集のたびにプレビューを作り直すと、カーソルが外れるため、開いている間は変えない)
  const [seed, setSeed] = useState({ html: document.html, id: 0 });
  const [patchError, setPatchError] = useState<string | null>(null);
  const preview = useRef<HtmlPreviewHandle>(null);

  const warnings = useMemo(() => lintHtml(html, stylesheets), [html, stylesheets]);
  const outputFiles = useMemo(() => outputFilesOf(html, stylesheets), [html, stylesheets]);

  // 編集可能なプレビュー(開いた時点のHTMLを表示する)
  const editableDoc = useMemo(() => composeHtml(seed.html, stylesheets, { preview: true }), [seed.html, stylesheets]);
  // HTML・CSSタブの隣に出す、読み取り専用のプレビュー(入力のたびに作り直すと重いため、少し遅らせて反映する)
  const deferredHtml = useDeferredValue(html);
  const deferredStylesheets = useDeferredValue(stylesheets);
  const sideDoc = useMemo(() => composeHtml(deferredHtml, deferredStylesheets, { preview: true }), [deferredHtml, deferredStylesheets]);

  const handlePreviewEdit = (liveHtml: string): void => {
    try {
      setHtml(patchHtmlSource(seed.html, liveHtml).html);
      setPatchError(null);
    } catch (cause) {
      setPatchError(`プレビューでの編集をHTMLへ反映できませんでした(${messageOf(cause)})。「HTML」タブで編集してください。`);
    }
  };

  const switchTab = (next: Tab): void => {
    if (next === tab) {
      return;
    }
    if (tab === PREVIEW_TAB) {
      preview.current?.flush();
    }
    if (next === PREVIEW_TAB) {
      // 最新のHTMLからプレビューを作り直す
      setSeed((current) => ({ html, id: current.id + 1 }));
      setPatchError(null);
    }
    setTab(next);
  };

  const changed = html !== document.html || stylesheets.some((sheet, index) => sheet.text !== document.stylesheets[index]?.text);
  const close = (): void => {
    if (!changed || window.confirm('編集内容は破棄されます。別のファイルを読み込みますか?')) {
      onClose();
    }
  };

  const editStylesheet = (name: string, text: string): void =>
    setStylesheets((current) => current.map((sheet) => (sheet.name === name ? { ...sheet, text } : sheet)));

  const currentStylesheet = stylesheets.find((sheet) => cssTab(sheet.name) === tab);
  const tabs: { id: Tab; label: string }[] = [
    { id: PREVIEW_TAB, label: 'プレビュー(直接編集)' },
    { id: HTML_TAB, label: 'HTML' },
    ...stylesheets.map((sheet) => ({ id: cssTab(sheet.name), label: `CSS: ${sheet.name}` })),
  ];

  return (
    <div className="app app-wide">
      <header className="app-header">
        <h1>Markdown / HTML → PDF エディタ</h1>
        <button type="button" className="button" onClick={close}>
          別のファイルを読み込む
        </button>
      </header>

      <main className="edit-view">
        <p className="source-name">{document.sourceName === null ? '貼り付けたHTML' : document.sourceName}</p>

        <WarningList warnings={warnings} />

        {patchError !== null && (
          <p role="alert" className="notice notice-error">
            {patchError}
          </p>
        )}

        <div className="tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={`tab${tab === item.id ? ' tab-active' : ''}`}
              onClick={() => switchTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="editor-pane" role="tabpanel">
          {tab === PREVIEW_TAB ? (
            <HtmlPreview key={seed.id} ref={preview} srcDoc={editableDoc} editable onEdit={handlePreviewEdit} />
          ) : (
            <div className="source-split">
              <textarea
                className="source-area"
                aria-label={currentStylesheet === undefined ? 'HTML' : `CSS: ${currentStylesheet.name}`}
                value={currentStylesheet === undefined ? html : currentStylesheet.text}
                onChange={(event) =>
                  currentStylesheet === undefined ? setHtml(event.target.value) : editStylesheet(currentStylesheet.name, event.target.value)
                }
                spellCheck={false}
              />
              <HtmlPreview srcDoc={sideDoc} editable={false} />
            </div>
          )}
        </div>
        <p className="hint">
          プレビューで編集すると、編集した箇所のHTMLだけが書き換わります(編集していない部分は、取り込んだままです)。
          プレビューはスクリプトを実行せず、外部のファイルも読み込みません(PDFと同じ)。PDFはサーバ側のフォントで描画されるため、
          プレビューと字形や改ページ位置が少し異なることがあります。
        </p>

        <OutputPanel
          files={outputFiles}
          defaultBaseName={defaultBaseName(document.sourceName)}
          generatePdf={() => requestPdf({ kind: 'html', text: composeHtml(html, stylesheets, { preview: false }) })}
          empty={html.trim() === ''}
        />
      </main>
    </div>
  );
};

export default HtmlEditView;
