import { forEachLineOutsideFences, splitInlineCode } from './markdownText';

/*
 * Markdownの中の、画像のファイル参照(![代替文](パス "タイトル") と、参照形式の定義 [id]: パス)を取り出す。
 * コードフェンスの中と、インラインコードの中は、対象外(コードとして書かれた記法のため)。
 */

// ![alt](url) / ![alt](<空白を含むurl>)。url の部分(タイトルは含まない)を取り出す
const INLINE_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]*))/g;
// [id]: url / [id]: <url>
const DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))/;

/** 1行(インラインコードを除いた文章)の中の、画像の参照 */
export function imageReferencesIn(prose: string): string[] {
  return [...prose.matchAll(INLINE_IMAGE)].map((match) => match[1] ?? match[2] ?? '').filter((reference) => reference !== '');
}

/**
 * Markdown全体で、画像を指している可能性のある参照(画像の記法と、参照形式の定義)。
 * 定義はリンクのものも含む(画像かどうかは、参照先のファイルで判断する)。多めに拾っても、害はない
 */
export function candidateImageReferences(markdown: string): string[] {
  const references = new Set<string>();
  forEachLineOutsideFences(markdown, (line) => {
    const prose = splitInlineCode(line)
      .filter((segment) => !segment.code)
      .map((segment) => segment.text)
      .join(' ');
    for (const reference of imageReferencesIn(prose)) {
      references.add(reference);
    }
    const definition = DEFINITION.exec(line);
    const target = definition?.[1] ?? definition?.[2];
    if (target !== undefined && target !== '') {
      references.add(target);
    }
  });
  return [...references];
}
