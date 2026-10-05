import { describe, expect, it } from 'vitest';
import { describeOutputUi, outputModeOf, selectedExtensions } from './outputMode';

describe('outputModeOf', () => {
  it.each([
    [{ markdown: true, pdf: true }, 'both'],
    [{ markdown: true, pdf: false }, 'markdown'],
    [{ markdown: false, pdf: true }, 'pdf'],
    [{ markdown: false, pdf: false }, 'none'],
  ] as const)('%j -> %s', (selection, expected) => {
    expect(outputModeOf(selection)).toBe(expected);
  });
});

describe('describeOutputUi', () => {
  it('2つとも保存: ファイル名を編集でき、フォルダを選んでまとめて出力する(ダウンロードも使える)', () => {
    for (const saveDialogSupported of [true, false]) {
      expect(describeOutputUi('both', saveDialogSupported)).toEqual({
        nameEditable: true,
        folderChooserEnabled: true,
        primary: 'folder',
        downloadEnabled: true,
        hint: null,
      });
    }
  });

  it.each(['markdown', 'pdf'] as const)(
    '%sだけ保存(ダイアログ対応): ファイル名欄とフォルダ選択はグレーにし、名前を付けて保存で指定する',
    (mode) => {
      const ui = describeOutputUi(mode, true);
      expect(ui.nameEditable).toBe(false);
      expect(ui.folderChooserEnabled).toBe(false);
      expect(ui.primary).toBe('save-dialog');
      // 名前を決められないダウンロードは、混乱を避けるため無効にする
      expect(ui.downloadEnabled).toBe(false);
      expect(ui.hint).toContain('名前を付けて保存');
    },
  );

  it.each(['markdown', 'pdf'] as const)(
    '%sだけ保存(ダイアログ非対応): ファイル名を編集でき、ダウンロードで保存する',
    (mode) => {
      const ui = describeOutputUi(mode, false);
      expect(ui.nameEditable).toBe(true);
      expect(ui.folderChooserEnabled).toBe(false);
      expect(ui.primary).toBe('unavailable');
      expect(ui.downloadEnabled).toBe(true);
    },
  );

  it('何も選ばれていない: すべて無効にして、選ぶよう促す', () => {
    for (const saveDialogSupported of [true, false]) {
      expect(describeOutputUi('none', saveDialogSupported)).toEqual({
        nameEditable: false,
        folderChooserEnabled: false,
        primary: 'none',
        downloadEnabled: false,
        hint: '保存するファイルを1つ以上選んでください。',
      });
    }
  });
});

describe('selectedExtensions', () => {
  it('選ばれているファイルの拡張子を並べる', () => {
    expect(selectedExtensions({ markdown: true, pdf: true })).toBe('.md / .pdf');
    expect(selectedExtensions({ markdown: true, pdf: false })).toBe('.md');
    expect(selectedExtensions({ markdown: false, pdf: true })).toBe('.pdf');
    expect(selectedExtensions({ markdown: false, pdf: false })).toBe('');
  });
});
