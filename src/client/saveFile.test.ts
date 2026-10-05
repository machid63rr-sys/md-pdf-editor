import { describe, expect, it } from 'vitest';
import { saveWithDialog, type SaveDialogOptions, type SaveFilePicker, type SaveTarget } from './saveFile';
import type { WritableLike } from './writeOutputs';

// メモリ上の保存先。実物と同じく、close()されるまで内容は確定せず、abort()で破棄される
class MemoryTarget implements SaveTarget {
  content = '';
  aborted = false;
  failWrite = false;

  constructor(readonly name: string) {}

  createWritable(): Promise<WritableLike> {
    let pending = '';
    return Promise.resolve({
      write: async (data) => {
        if (this.failWrite) {
          throw new Error('書き込み失敗');
        }
        pending += typeof data === 'string' ? data : await data.text();
      },
      close: () => {
        this.content = pending;
        return Promise.resolve();
      },
      abort: () => {
        this.aborted = true;
        return Promise.resolve();
      },
    });
  }
}

const pickerReturning = (target: SaveTarget, onOptions?: (options: SaveDialogOptions) => void): SaveFilePicker => {
  return (options) => {
    onOptions?.(options);
    return Promise.resolve(target);
  };
};

describe('saveWithDialog', () => {
  it('Markdown: 提案名「<名前>.md」でダイアログを開き、指定された保存先へ書き込む', async () => {
    const target = new MemoryTarget('選ばれた名前.md');
    let options: SaveDialogOptions | undefined;

    const result = await saveWithDialog({
      picker: pickerReturning(target, (o) => (options = o)),
      kind: 'markdown',
      suggestedBaseName: '手順書',
      produce: () => Promise.resolve('# 見出し'),
    });

    expect(result).toEqual({ kind: 'saved', name: '選ばれた名前.md' });
    expect(target.content).toBe('# 見出し');
    expect(options?.suggestedName).toBe('手順書.md');
    expect(options?.id).toBe('md-pdf-editor');
    expect(options?.types[0]?.accept).toEqual({ 'text/markdown': ['.md'] });
  });

  it('PDF: 提案名「<名前>.pdf」でダイアログを開く。内容は保存先が決まった後に作る', async () => {
    const target = new MemoryTarget('manual.pdf');
    const order: string[] = [];
    let options: SaveDialogOptions | undefined;

    const result = await saveWithDialog({
      picker: (o) => {
        order.push('picker');
        options = o;
        return Promise.resolve(target);
      },
      kind: 'pdf',
      suggestedBaseName: 'manual',
      produce: () => {
        order.push('produce');
        return Promise.resolve(new Blob(['%PDF-1.7 dummy']));
      },
    });

    expect(order).toEqual(['picker', 'produce']);
    expect(result).toEqual({ kind: 'saved', name: 'manual.pdf' });
    expect(target.content).toBe('%PDF-1.7 dummy');
    expect(options?.suggestedName).toBe('manual.pdf');
    expect(options?.types[0]?.accept).toEqual({ 'application/pdf': ['.pdf'] });
  });

  it('ダイアログを閉じた(AbortError)場合は、中止として扱い、内容を作らない', async () => {
    let produced = false;
    const result = await saveWithDialog({
      picker: () => Promise.reject(Object.assign(new Error('closed'), { name: 'AbortError' })),
      kind: 'pdf',
      suggestedBaseName: 'manual',
      produce: () => {
        produced = true;
        return Promise.resolve('x');
      },
    });

    expect(result).toEqual({ kind: 'cancelled' });
    expect(produced).toBe(false);
  });

  it('ダイアログ自体が失敗した場合(中止以外)は、失敗として理由を返す', async () => {
    const result = await saveWithDialog({
      picker: () => Promise.reject(Object.assign(new Error('許可されていません'), { name: 'SecurityError' })),
      kind: 'markdown',
      suggestedBaseName: 'manual',
      produce: () => Promise.resolve('x'),
    });

    expect(result).toEqual({ kind: 'failed', name: 'manual.md', message: '許可されていません' });
  });

  it('内容の生成に失敗した場合は、失敗として報告し、空のファイルが残る可能性を伝える', async () => {
    const target = new MemoryTarget('manual.pdf');

    const result = await saveWithDialog({
      picker: pickerReturning(target),
      kind: 'pdf',
      suggestedBaseName: 'manual',
      produce: () => Promise.reject(new Error('PDFの生成に失敗しました')),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.name).toBe('manual.pdf');
      expect(result.message).toContain('PDFの生成に失敗しました');
      expect(result.message).toContain('空のファイル「manual.pdf」');
    }
    expect(target.content).toBe('');
  });

  it('書き込みに失敗した場合は、書き込みを破棄し、失敗として報告する', async () => {
    const target = new MemoryTarget('manual.md');
    target.failWrite = true;

    const result = await saveWithDialog({
      picker: pickerReturning(target),
      kind: 'markdown',
      suggestedBaseName: 'manual',
      produce: () => Promise.resolve('本文'),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.message).toContain('書き込み失敗');
      expect(result.message).toContain('空のファイル');
    }
    expect(target.aborted).toBe(true);
    expect(target.content).toBe('');
  });
});
