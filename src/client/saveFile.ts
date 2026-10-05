import { EXTENSION } from './outputMode';
import type { WritableLike } from './writeOutputs';

/*
 * 「名前を付けて保存」ダイアログで、1つのファイルを保存する。
 * ダイアログは、利用者のクリック直後(ユーザー操作の有効期間内)に開く必要があるため、
 * 先にダイアログで保存先と名前を決めてもらい、その後に内容(PDFなら生成)を作って書き込む。
 */

export type SaveKind = 'markdown' | 'pdf';

type MimeType = `${string}/${string}`;
type FileExtension = `.${string}`;

// ブラウザの showSaveFilePicker に、そのまま渡せる形にしている(型の不一致を避けるため readonly は付けない)
export interface SaveDialogOptions {
  id: string;
  suggestedName: string;
  types: {
    description: string;
    accept: Record<MimeType, FileExtension[]>;
  }[];
}

export interface SaveTarget {
  readonly name: string;
  createWritable(): Promise<WritableLike>;
}

export type SaveFilePicker = (options: SaveDialogOptions) => Promise<SaveTarget>;

export type SaveResult =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'saved'; readonly name: string }
  | { readonly kind: 'failed'; readonly name: string; readonly message: string };

export interface SaveRequest {
  readonly picker: SaveFilePicker;
  readonly kind: SaveKind;
  // 保存ダイアログに最初に表示するファイル名(拡張子なし)
  readonly suggestedBaseName: string;
  // 保存する内容を作る(PDFの場合は生成)。保存先が決まった後に呼ばれる
  readonly produce: () => Promise<string | Blob>;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const isAbort = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { name?: unknown }).name === 'AbortError';

function dialogOptions(kind: SaveKind, suggestedName: string): SaveDialogOptions {
  const types =
    kind === 'pdf'
      ? [{ description: 'PDFファイル', accept: { 'application/pdf': ['.pdf'] as FileExtension[] } }]
      : [{ description: 'Markdownファイル', accept: { 'text/markdown': ['.md'] as FileExtension[] } }];
  return { id: 'md-pdf-editor', suggestedName, types };
}

export async function saveWithDialog(request: SaveRequest): Promise<SaveResult> {
  const suggestedName = `${request.suggestedBaseName}.${EXTENSION[request.kind]}`;

  let target: SaveTarget;
  try {
    target = await request.picker(dialogOptions(request.kind, suggestedName));
  } catch (cause) {
    if (isAbort(cause)) {
      return { kind: 'cancelled' }; // 利用者がダイアログを閉じた
    }
    return { kind: 'failed', name: suggestedName, message: messageOf(cause) };
  }

  // ダイアログで保存先が決まった時点で、ブラウザが空のファイルを作っている。
  // 以降の失敗では内容を書けないため、その旨を利用者に伝える
  const emptyFileNote = `(保存先に空のファイル「${target.name}」が作られている場合は、削除してください)`;

  let data: string | Blob;
  try {
    data = await request.produce();
  } catch (cause) {
    return { kind: 'failed', name: target.name, message: `${messageOf(cause)} ${emptyFileNote}` };
  }

  try {
    const writable = await target.createWritable();
    try {
      await writable.write(data);
      await writable.close();
    } catch (cause) {
      try {
        await writable.abort();
      } catch {
        // 破棄の失敗は、元の書き込み失敗の原因を覆い隠さないよう、ここでは扱わない
      }
      throw cause;
    }
  } catch (cause) {
    return { kind: 'failed', name: target.name, message: `${messageOf(cause)} ${emptyFileNote}` };
  }
  return { kind: 'saved', name: target.name };
}
