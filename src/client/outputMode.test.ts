import { describe, expect, it } from 'vitest';
import { folderOutputLabel, hasSelection, selectedExtensions } from './outputMode';

describe('hasSelection', () => {
  it.each([
    [{ markdown: true, pdf: true }, true],
    [{ markdown: true, pdf: false }, true],
    [{ markdown: false, pdf: true }, true],
    [{ markdown: false, pdf: false }, false],
  ] as const)('%j -> %s', (selection, expected) => {
    expect(hasSelection(selection)).toBe(expected);
  });
});

describe('folderOutputLabel', () => {
  it.each([
    [{ markdown: true, pdf: true }, '選んだフォルダへMDとPDFを出力'],
    [{ markdown: true, pdf: false }, '選んだフォルダへMDを出力'],
    [{ markdown: false, pdf: true }, '選んだフォルダへPDFを出力'],
  ] as const)('%j -> %s', (selection, expected) => {
    expect(folderOutputLabel(selection)).toBe(expected);
  });
});

describe('selectedExtensions', () => {
  it.each([
    [{ markdown: true, pdf: true }, '.md / .pdf'],
    [{ markdown: true, pdf: false }, '.md'],
    [{ markdown: false, pdf: true }, '.pdf'],
    [{ markdown: false, pdf: false }, ''],
  ] as const)('%j -> "%s"', (selection, expected) => {
    expect(selectedExtensions(selection)).toBe(expected);
  });
});
