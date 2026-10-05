/*
 * 「どのファイルを保存するか」の選択に関する、画面の部品から切り離した純粋関数。
 * 1つだけ保存する場合も、2つとも保存する場合と同じく、先にファイル名を決めてからフォルダを選んで保存する。
 */

export interface FileSelection {
  readonly markdown: boolean;
  readonly pdf: boolean;
}

export const NO_SELECTION_HINT = '保存するファイルを1つ以上選んでください。';

export const hasSelection = (selection: FileSelection): boolean => selection.markdown || selection.pdf;

// 選ばれているファイルの種類(例: "MD", "PDF", "MDとPDF")
function selectedLabel(selection: FileSelection): string {
  if (selection.markdown && selection.pdf) {
    return 'MDとPDF';
  }
  return selection.markdown ? 'MD' : 'PDF';
}

// 「選んだフォルダへ出力」ボタンの文言(例: "選んだフォルダへMDを出力")
export const folderOutputLabel = (selection: FileSelection): string => `選んだフォルダへ${selectedLabel(selection)}を出力`;

// 選ばれているファイルの拡張子の一覧(例: ".md / .pdf")
export function selectedExtensions(selection: FileSelection): string {
  return [selection.markdown ? '.md' : null, selection.pdf ? '.pdf' : null]
    .filter((extension): extension is string => extension !== null)
    .join(' / ');
}
