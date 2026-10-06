import React, { useState } from 'react';
import type { ImportedDocument } from './documents';
import EditView from './EditView';
import HtmlEditView from './HtmlEditView';
import ImportView from './ImportView';

// 取り込み画面 → 編集画面。取り込むたびに編集画面を作り直すため、keyに連番を使う
const App: React.FC = () => {
  const [session, setSession] = useState<{ id: number; document: ImportedDocument } | null>(null);

  if (session === null) {
    return <ImportView onImport={(document) => setSession({ id: Date.now(), document })} />;
  }
  const close = (): void => setSession(null);
  return session.document.kind === 'html' ? (
    <HtmlEditView key={session.id} document={session.document} onClose={close} />
  ) : (
    <EditView key={session.id} document={session.document} onClose={close} />
  );
};

export default App;
