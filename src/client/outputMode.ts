/*
 * 「どのファイルを保存するか」の選択から、出力パネルの各部品(ファイル名欄・フォルダ選択・ボタン)の
 * 有効/無効を決める。画面の部品から切り離した純粋関数にして、組み合わせをテストできるようにしている。
 *
 * - 2つとも保存: 先にファイル名を決め、保存先フォルダを選んで、まとめて書き込む
 * - 1つだけ保存: 「名前を付けて保存」ダイアログで、保存先と名前を一度に指定する(ファイル名欄とフォルダ選択は使わない)
 *   ダイアログが使えないブラウザでは、ダウンロードで保存する(ファイル名欄は使う)
 */

export interface FileSelection {
  readonly markdown: boolean;
  readonly pdf: boolean;
}

export type OutputMode = 'none' | 'both' | 'markdown' | 'pdf';

export type PrimaryAction =
  // 保存するファイルが選ばれていない
  | 'none'
  // 選んだフォルダへ、MDとPDFをまとめて書き込む
  | 'folder'
  // 「名前を付けて保存」ダイアログで、1つのファイルを保存する
  | 'save-dialog'
  // 1つだけ保存したいが、ダイアログが使えない(ダウンロードで保存する)
  | 'unavailable';

export interface OutputUi {
  readonly nameEditable: boolean;
  readonly folderChooserEnabled: boolean;
  readonly primary: PrimaryAction;
  readonly downloadEnabled: boolean;
  // 利用者に補足として見せる文。不要ならnull
  readonly hint: string | null;
}

export function outputModeOf(selection: FileSelection): OutputMode {
  if (selection.markdown && selection.pdf) {
    return 'both';
  }
  if (selection.markdown) {
    return 'markdown';
  }
  return selection.pdf ? 'pdf' : 'none';
}

export function describeOutputUi(mode: OutputMode, saveDialogSupported: boolean): OutputUi {
  switch (mode) {
    case 'none':
      return {
        nameEditable: false,
        folderChooserEnabled: false,
        primary: 'none',
        downloadEnabled: false,
        hint: '保存するファイルを1つ以上選んでください。',
      };
    case 'both':
      return { nameEditable: true, folderChooserEnabled: true, primary: 'folder', downloadEnabled: true, hint: null };
    case 'markdown':
    case 'pdf':
      return saveDialogSupported
        ? {
            nameEditable: false,
            folderChooserEnabled: false,
            primary: 'save-dialog',
            downloadEnabled: false,
            hint: '1つだけ保存するときは、保存先とファイル名を「名前を付けて保存」のダイアログで指定します。',
          }
        : { nameEditable: true, folderChooserEnabled: false, primary: 'unavailable', downloadEnabled: true, hint: null };
  }
}

export const EXTENSION: Readonly<Record<'markdown' | 'pdf', string>> = { markdown: 'md', pdf: 'pdf' };

// 選ばれているファイルの拡張子の一覧(例: ".md / .pdf")
export function selectedExtensions(selection: FileSelection): string {
  return [selection.markdown ? `.${EXTENSION.markdown}` : null, selection.pdf ? `.${EXTENSION.pdf}` : null]
    .filter((extension): extension is string => extension !== null)
    .join(' / ');
}
