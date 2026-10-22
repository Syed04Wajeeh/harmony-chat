import type { Attachment } from '@harmony/shared';
import { formatBytes } from '../lib/time.js';
import { useMessageHandlers } from './chat-context.js';
import { DownloadIcon, FileIcon } from './Icons.js';
import { Modal } from './Overlay.js';

const PREVIEWABLE = /^image\/(png|jpe?g|gif|webp)$/;

export const isPreviewable = (attachment: Attachment): boolean =>
  PREVIEWABLE.test(attachment.contentType) && Boolean(attachment.width && attachment.height);

export function Attachments({ attachments }: { attachments: readonly Attachment[] }) {
  const { onOpenImage } = useMessageHandlers();
  if (attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((attachment) =>
        isPreviewable(attachment) ? (
          <button
            key={attachment.id}
            type="button"
            className="attachment-image"
            style={
              {
                '--w': attachment.width,
                '--h': attachment.height,
              } as React.CSSProperties
            }
            aria-label={`Open image ${attachment.filename}`}
            onClick={() => onOpenImage(attachment)}
          >
            <img
              src={attachment.url}
              alt={attachment.filename}
              width={attachment.width ?? undefined}
              height={attachment.height ?? undefined}
              loading="lazy"
              decoding="async"
            />
          </button>
        ) : (
          <a
            key={attachment.id}
            className="attachment-file"
            href={attachment.url}
            download={attachment.filename}
          >
            <FileIcon width={28} height={28} />
            <span className="attachment-file-text">
              <span className="attachment-file-name">{attachment.filename}</span>
              <span className="attachment-file-size">{formatBytes(attachment.sizeBytes)}</span>
            </span>
            <DownloadIcon width={20} height={20} />
          </a>
        ),
      )}
    </div>
  );
}

export function Lightbox({
  attachment,
  onClose,
}: {
  attachment: Attachment | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={attachment !== null}
      onOpenChange={(open) => !open && onClose()}
      title={attachment?.filename ?? 'Image'}
      variant="viewer"
    >
      {attachment && (
        <div className="lightbox">
          <img src={attachment.url} alt={attachment.filename} />
          <a className="button" href={attachment.url} download={attachment.filename}>
            <DownloadIcon width={18} height={18} /> Download
          </a>
        </div>
      )}
    </Modal>
  );
}
