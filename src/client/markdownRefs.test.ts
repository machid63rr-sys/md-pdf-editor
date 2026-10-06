import { describe, expect, it } from 'vitest';
import { candidateImageReferences, imageReferencesIn } from './markdownRefs';

describe('imageReferencesIn', () => {
  it.each([
    ['![図](images/a.png)', ['images/a.png']],
    ['![図](images/a.png "タイトル")', ['images/a.png']],
    ['![図](<my image/日本 図.png>)', ['my image/日本 図.png']],
    ['![a](x.png) と ![b](y.png)', ['x.png', 'y.png']],
    ['![](x.png)', ['x.png']],
    ['[リンク](x.png)', []],
    ['![図][id]', []],
    ['![図](  spaced.png  )', ['spaced.png']],
  ])('%s -> %j', (text, expected) => {
    expect(imageReferencesIn(text)).toEqual(expected);
  });
});

describe('candidateImageReferences', () => {
  it('画像の記法と、参照形式の定義を拾う(重複は1つにする)', () => {
    const markdown = ['![図1](a.png)', '', '![図2][b]', '', '![図3](a.png)', '', '[b]: images/b.png "題"', '[c]: <my dir/c.png>'].join('\n');
    expect(candidateImageReferences(markdown).sort()).toEqual(['a.png', 'images/b.png', 'my dir/c.png']);
  });

  it('コードフェンスの中・インラインコードの中の記法は拾わない', () => {
    const markdown = ['```', '![x](in-fence.png)', '[d]: in-fence2.png', '```', '', '`![x](inline.png)` と ![y](real.png)'].join('\n');
    expect(candidateImageReferences(markdown)).toEqual(['real.png']);
  });

  it('画像が無ければ空', () => {
    expect(candidateImageReferences('# 見出し\n\n本文')).toEqual([]);
  });
});
