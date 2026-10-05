import { describe, expect, it } from 'vitest';
import { checkDirectoryPickerSupport, checkSaveFilePickerSupport } from './browserSupport';

describe('checkDirectoryPickerSupport', () => {
  it('セキュアコンテキストでshowDirectoryPickerがあれば対応', () => {
    expect(checkDirectoryPickerSupport({ isSecureContext: true, showDirectoryPicker: () => undefined })).toEqual({
      supported: true,
    });
  });

  it('セキュアコンテキストでなければ、localhostでのアクセスを案内する', () => {
    const result = checkDirectoryPickerSupport({ isSecureContext: false, showDirectoryPicker: () => undefined });
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('localhost');
    expect(!result.supported && result.reason).toContain('フォルダへの直接出力');
  });

  it('showDirectoryPickerが無いブラウザ(Firefox/Safari)では、ChromeまたはEdgeを案内する', () => {
    const result = checkDirectoryPickerSupport({ isSecureContext: true });
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('Chrome');
  });

  it('showSaveFilePickerだけがあっても、フォルダ選択の対応とはみなさない', () => {
    expect(checkDirectoryPickerSupport({ isSecureContext: true, showSaveFilePicker: () => undefined }).supported).toBe(false);
  });
});

describe('checkSaveFilePickerSupport', () => {
  it('セキュアコンテキストでshowSaveFilePickerがあれば対応', () => {
    expect(checkSaveFilePickerSupport({ isSecureContext: true, showSaveFilePicker: () => undefined })).toEqual({
      supported: true,
    });
  });

  it('セキュアコンテキストでなければ、localhostでのアクセスを案内する', () => {
    const result = checkSaveFilePickerSupport({ isSecureContext: false, showSaveFilePicker: () => undefined });
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('localhost');
    expect(!result.supported && result.reason).toContain('名前を付けて保存');
  });

  it('showSaveFilePickerが無いブラウザでは、ChromeまたはEdgeを案内する', () => {
    const result = checkSaveFilePickerSupport({ isSecureContext: true, showDirectoryPicker: () => undefined });
    expect(result.supported).toBe(false);
    expect(!result.supported && result.reason).toContain('Chrome');
  });
});
