import React, { useMemo, useState } from 'react';
import { checkDirectoryPickerSupport } from './browserSupport';
import { downloadBlob } from './download';
import { validateBaseName } from './filename';
import { requestPdf } from './pdfClient';
import { ensureReadWrite, writeOutputs, type OutputReport } from './writeOutputs';

interface OutputPanelProps {
  markdown: string;
  // 出力ファイル名(拡張子なし)の初期値
  defaultBaseName: string;
}

interface Status {
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

// 2つ目のダウンロードを、1つ目の開始の直後に発行すると、ブラウザに無視されることがあるため少し間を置く
const SECOND_DOWNLOAD_DELAY_MS = 400;
const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

function describeReport(report: OutputReport, folderName: string): Status {
  if (report.cancelled) {
    return { kind: 'info', text: '上書きが承認されなかったため、出力を中止しました。ファイルは変更していません。' };
  }
  if (report.failed.length === 0) {
    return { kind: 'success', text: `「${folderName}」へ出力しました: ${report.written.join('、')}` };
  }
  const failures = report.failed.map((failure) => `${failure.name} (${failure.message})`).join(' / ');
  const written = report.written.length > 0 ? `出力できたファイル: ${report.written.join('、')}。` : '出力できたファイルはありません。';
  return { kind: 'error', text: `一部またはすべての出力に失敗しました。${written} 失敗: ${failures}` };
}

/** 出力先フォルダの選択、PDFの確認、MDとPDFの同時出力 */
const OutputPanel: React.FC<OutputPanelProps> = ({ markdown, defaultBaseName }) => {
  const support = useMemo(() => checkDirectoryPickerSupport(window), []);
  const [baseName, setBaseName] = useState(defaultBaseName);
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

  const nameCheck = validateBaseName(baseName);
  const isEmpty = markdown.trim() === '';

  const chooseDirectory = async (): Promise<void> => {
    try {
      // 前回選んだフォルダをブラウザが覚えているため、idを固定する
      const handle = await window.showDirectoryPicker({ id: 'md-pdf-editor', mode: 'readwrite' });
      setDirectory(handle);
      setStatus(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        return; // 利用者が選択を取り消した
      }
      setStatus({
        kind: 'error',
        text: `フォルダを選択できませんでした: ${messageOf(cause)} (システムフォルダなどは選べません。別のフォルダ、または新しく作ったフォルダを選んでください)`,
      });
    }
  };

  const output = async (): Promise<void> => {
    if (directory === null || !nameCheck.ok) {
      return;
    }
    setBusy(true);
    setStatus({ kind: 'info', text: 'PDFを生成しています…' });
    try {
      // 書き込み権限の再確認はクリック直後(ユーザー操作の有効期間内)に行う。PDF生成には数秒かかるため、その前に済ませる
      await ensureReadWrite(directory);
      const pdf = await requestPdf(markdown);
      const report = await writeOutputs({
        directory,
        baseName,
        markdown,
        pdf,
        confirmOverwrite: (names) => window.confirm(`次のファイルは既に存在します。上書きしますか?\n\n${names.join('\n')}`),
      });
      setStatus(describeReport(report, directory.name));
    } catch (cause) {
      setStatus({ kind: 'error', text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  // フォルダを選べない場合(システムフォルダの制限・非対応ブラウザなど)のための保存方法。保存先はブラウザの設定に従う
  const download = async (): Promise<void> => {
    if (!nameCheck.ok) {
      return;
    }
    setBusy(true);
    setStatus({ kind: 'info', text: 'PDFを生成しています…' });
    try {
      const pdf = await requestPdf(markdown);
      downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${baseName}.md`);
      await delay(SECOND_DOWNLOAD_DELAY_MS);
      downloadBlob(pdf, `${baseName}.pdf`);
      setStatus({
        kind: 'success',
        text: `ダウンロードを開始しました: ${baseName}.md、${baseName}.pdf (保存先はブラウザのダウンロード設定に従います。複数ファイルのダウンロードを確認された場合は、許可してください)`,
      });
    } catch (cause) {
      setStatus({ kind: 'error', text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  // ポップアップとして拒否されないよう、新しいタブはクリック直後に開き、PDFができてから表示を切り替える
  const previewPdf = async (): Promise<void> => {
    const tab = window.open('about:blank', '_blank');
    if (tab === null) {
      setStatus({ kind: 'error', text: 'ポップアップがブロックされました。このページのポップアップを許可してください。' });
      return;
    }
    tab.document.title = 'PDFを生成しています…';
    tab.document.body.textContent = 'PDFを生成しています…';
    setBusy(true);
    setStatus({ kind: 'info', text: 'PDFを生成しています…' });
    try {
      const url = URL.createObjectURL(await requestPdf(markdown));
      tab.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
      setStatus(null);
    } catch (cause) {
      tab.close();
      setStatus({ kind: 'error', text: messageOf(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="output-panel" aria-label="出力">
      <h2>出力</h2>

      <div className="field">
        <label htmlFor="base-name">ファイル名(拡張子なし)</label>
        <input
          id="base-name"
          className="text-input"
          value={baseName}
          onChange={(event) => setBaseName(event.target.value)}
          aria-invalid={!nameCheck.ok}
          spellCheck={false}
        />
        <span className="field-suffix">.md / .pdf</span>
        {!nameCheck.ok && <p className="field-error">{nameCheck.message}</p>}
      </div>

      <div className="field">
        <button type="button" className="button" disabled={!support.supported || busy} onClick={() => void chooseDirectory()}>
          出力先フォルダを選択
        </button>
        <span className="field-value">{directory === null ? '(未選択)' : directory.name}</span>
        {support.supported ? (
          <p className="field-hint">
            「ドキュメント」「ダウンロード」「デスクトップ」などのフォルダそのものは、ブラウザの制限で選べません。
            その中に新しいフォルダを作って選ぶか、下の「ダウンロードで保存」を使ってください。
          </p>
        ) : (
          <p className="field-error">{support.reason} 代わりに、下の「ダウンロードで保存」を使えます。</p>
        )}
      </div>

      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!support.supported || directory === null || !nameCheck.ok || isEmpty || busy}
          onClick={() => void output()}
        >
          選んだフォルダへMDとPDFを出力
        </button>
        <button type="button" className="button" disabled={!nameCheck.ok || isEmpty || busy} onClick={() => void download()}>
          ダウンロードで保存(MDとPDF)
        </button>
        <button type="button" className="button" disabled={isEmpty || busy} onClick={() => void previewPdf()}>
          PDFを生成して確認(新しいタブ)
        </button>
      </div>

      {status !== null && (
        <p role={status.kind === 'error' ? 'alert' : 'status'} className={`notice notice-${status.kind}`}>
          {status.text}
        </p>
      )}
    </section>
  );
};

export default OutputPanel;
