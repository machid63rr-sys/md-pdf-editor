export class PdfRequestError extends Error {}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') {
      return body.error.message;
    }
  } catch {
    // JSONでない応答(プロキシのエラーページなど)は、下のステータス表示にまとめる
  }
  return `サーバがエラーを返しました (HTTP ${response.status})。`;
}

/** 現在のMarkdownからPDFを生成する。失敗した場合は、利用者に見せられるメッセージつきで例外にする */
export async function requestPdf(markdown: string, fetchFn: FetchLike = defaultFetch): Promise<Blob> {
  let response: Response;
  try {
    response = await fetchFn('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown }),
    });
  } catch {
    throw new PdfRequestError('サーバに接続できませんでした。アプリが起動しているか確認してください。');
  }
  if (!response.ok) {
    throw new PdfRequestError(await readErrorMessage(response));
  }
  if (!(response.headers.get('content-type') ?? '').includes('application/pdf')) {
    throw new PdfRequestError('サーバの応答がPDFではありませんでした。');
  }
  return response.blob();
}
