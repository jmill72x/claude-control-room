import { resizeTarget, PHOTO_QUALITY, PDF_TYPE } from '../lib/orbit/chat.js';

// A picked photo, made ready to send (jarvis-os-chat-spec.md, §2.5): decoded,
// drawn on a canvas at a 1568 px long edge and encoded as JPEG at 0.85. No
// `blob:` or `data:` URL is made anywhere (the policy allows neither):
// createImageBitmap takes the File itself and the canvas gives a Blob back,
// which goes up as raw bytes. A file the browser can't decode (HEIC in
// Chromium) goes up as it is; the server takes heic.
export async function preparePhoto(file) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = resizeTarget(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode the photo'))), 'image/jpeg', PHOTO_QUALITY));
    return { name: `${String(file.name || 'photo').replace(/\.[^.]*$/, '') || 'photo'}.jpg`, blob, width, height, originalBytes: file.size };
  } catch {
    return { name: file.name || 'photo', blob: file, width: null, height: null, originalBytes: file.size };
  } finally {
    bitmap?.close?.();
  }
}

// A file made ready to send, by its kind (`fileKind`): a photo as above; a PDF as
// it is, typed as a PDF even when a drag brought it with no type, so the upload's
// Content-Type matches what the server sniffs.
export async function prepareFile(file, kind) {
  if (kind !== 'pdf') return preparePhoto(file);
  const blob = file.type === PDF_TYPE ? file : new Blob([file], { type: PDF_TYPE });
  return { name: file.name || 'file.pdf', blob, width: null, height: null, originalBytes: file.size, kind: 'pdf' };
}
