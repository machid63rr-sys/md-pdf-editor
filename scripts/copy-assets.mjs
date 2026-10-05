// サーバのビルド成果物(dist/server)へ、実行時に読み込む共有CSSをコピーする。
// プレビュー(クライアント)とPDF(サーバ)が同じCSSを使うことで見た目を揃えるため。
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist/server', { recursive: true });
copyFileSync('src/shared/document.css', 'dist/server/document.css');
console.log('copied src/shared/document.css -> dist/server/document.css');
