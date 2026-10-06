import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('未指定なら既定値になる', () => {
    expect(loadConfig({})).toEqual({
      port: 8080,
      host: '0.0.0.0',
      maxMarkdownBytes: 30 * 1024 * 1024,
      pdfTimeoutMs: 60_000,
      chromiumPath: '/usr/bin/chromium',
    });
  });

  it('環境変数で上書きできる', () => {
    const config = loadConfig({
      PORT: '9000',
      HOST: '127.0.0.1',
      MAX_MARKDOWN_BYTES: '1024',
      PDF_TIMEOUT_MS: '5000',
      CHROMIUM_PATH: '/opt/chromium',
    });
    expect(config).toEqual({
      port: 9000,
      host: '127.0.0.1',
      maxMarkdownBytes: 1024,
      pdfTimeoutMs: 5000,
      chromiumPath: '/opt/chromium',
    });
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '-1'],
    ['MAX_MARKDOWN_BYTES', '1.5'],
    ['MAX_MARKDOWN_BYTES', '0'],
    ['PDF_TIMEOUT_MS', '10s'],
  ])('%s=%s のような不正な値は、黙って既定値に戻さずエラーにする', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrowError(name);
  });
});
