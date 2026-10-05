export interface DirectoryPickerEnvironment {
  readonly isSecureContext: boolean;
  readonly showDirectoryPicker?: unknown;
}

export type DirectoryPickerSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

/**
 * フォルダ選択(File System Access API)が使えるかを判定する。
 * 使えない場合は、ダウンロード等へ黙って切り替えず、理由を利用者に示す。
 */
export function checkDirectoryPickerSupport(env: DirectoryPickerEnvironment): DirectoryPickerSupport {
  if (!env.isSecureContext) {
    return {
      supported: false,
      reason:
        'この接続(http://IPアドレスなど)ではフォルダへの直接出力を利用できません。http://localhost:ポート番号 でアクセスしてください。',
    };
  }
  if (typeof env.showDirectoryPicker !== 'function') {
    return {
      supported: false,
      reason: 'このブラウザはフォルダへの直接出力に対応していません。Chrome または Edge をお使いください。',
    };
  }
  return { supported: true };
}
