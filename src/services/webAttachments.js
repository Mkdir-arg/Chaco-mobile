// Persist bytes in the same SQLite transaction as the capture and its outbox.
// Object URLs expire on reload. Data URLs survive browser/process restarts.
export const persistWebAttachment = async ({ uri, mimeType, size }) => {
  if (String(uri).startsWith('data:')) return { uri, mimeType, size };
  const response = await fetch(uri);
  if (!response.ok) throw new Error('No se pudo leer el adjunto. Volvé a seleccionarlo.');
  const blob = await response.blob();
  const dataUri = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo guardar el adjunto.'));
    reader.readAsDataURL(blob);
  });
  return { uri: dataUri, mimeType: blob.type || mimeType, size: blob.size };
};
