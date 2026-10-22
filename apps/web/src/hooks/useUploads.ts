import { MAX_ATTACHMENTS_PER_MESSAGE, type Attachment } from '@harmony/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadFile } from '../api/client.js';
import { reportError } from '../store/actions.js';
import { useUi } from '../store/ui.js';

export interface UploadItem {
  id: string;
  file: File;
  previewUrl: string | null;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
}

export function useUploads() {
  const [items, setItems] = useState<readonly UploadItem[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const patch = useCallback((id: string, change: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }, []);

  const add = useCallback(
    (files: readonly File[]) => {
      const room = MAX_ATTACHMENTS_PER_MESSAGE - itemsRef.current.length;
      if (files.length > room) {
        useUi
          .getState()
          .pushToast(`You can attach up to ${String(MAX_ATTACHMENTS_PER_MESSAGE)} files`);
      }
      for (const file of files.slice(0, Math.max(0, room))) {
        const id = crypto.randomUUID();
        const controller = new AbortController();
        controllers.current.set(id, controller);
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
        setItems((current) => [
          ...current,
          { id, file, previewUrl, progress: 0, status: 'uploading' },
        ]);
        uploadFile(file, {
          signal: controller.signal,
          onProgress: (progress) => patch(id, { progress }),
        })
          .then((attachment) => patch(id, { status: 'done', progress: 1, attachment }))
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            patch(id, {
              status: 'error',
              error: error instanceof Error ? error.message : 'Upload failed',
            });
            reportError(error, `Could not upload ${file.name}`);
          })
          .finally(() => controllers.current.delete(id));
      }
    },
    [patch],
  );

  const release = (item: UploadItem) => {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  };

  const remove = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    setItems((current) => {
      current.filter((item) => item.id === id).forEach(release);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const clear = useCallback(() => {
    itemsRef.current.forEach(release);
    setItems([]);
  }, []);

  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort();
      itemsRef.current.forEach(release);
    },
    [],
  );

  return {
    items,
    add,
    remove,
    clear,
    busy: items.some((item) => item.status === 'uploading'),
    attachments: items.flatMap((item) => (item.attachment ? [item.attachment] : [])),
  };
}

export type Uploads = ReturnType<typeof useUploads>;
