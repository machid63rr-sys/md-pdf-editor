import React, { useState } from 'react';
import EditView from './EditView';
import ImportView, { type ImportedDocument } from './ImportView';

// 取り込み画面 → 編集画面。取り込むたびに編集画面を作り直すため、keyに連番を使う
const App: React.FC = () => {
  const [session, setSession] = useState<{ id: number; document: ImportedDocument } | null>(null);

  if (session === null) {
    return <ImportView onImport={(document) => setSession({ id: Date.now(), document })} />;
  }
  return <EditView key={session.id} document={session.document} onClose={() => setSession(null)} />;
};

export default App;
