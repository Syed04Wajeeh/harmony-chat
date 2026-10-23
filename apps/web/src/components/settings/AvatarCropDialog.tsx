import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { MAX_ZOOM, clampOffset, cropRect, scaleOf, type CropState } from '../../lib/crop.js';
import { Modal } from '../Overlay.js';

const VIEWPORT = 240;
const OUTPUT = 256;

interface Props {
  file: File | null;
  onCancel: () => void;
  onCropped: (blob: Blob) => void;
}

/** Drag to position and zoom to size; the result is a square PNG (WebP for animated sources is kept uncropped). */
export function AvatarCropDialog({ file, onCancel, onCropped }: Props) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setImage(img);
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const state: CropState | null = image && {
    viewport: VIEWPORT,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
    zoom,
    offsetX: offset.x,
    offsetY: offset.y,
  };
  const clamped = state ? clampOffset(state) : { offsetX: 0, offsetY: 0 };

  function move(event: PointerEvent) {
    if (!drag.current || !state) return;
    const next = clampOffset({
      ...state,
      offsetX: drag.current.ox + event.clientX - drag.current.x,
      offsetY: drag.current.oy + event.clientY - drag.current.y,
    });
    setOffset({ x: next.offsetX, y: next.offsetY });
  }

  function confirm() {
    if (!image || !state) return;
    const rect = cropRect(state);
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    canvas
      .getContext('2d')
      ?.drawImage(image, rect.x, rect.y, rect.size, rect.size, 0, 0, OUTPUT, OUTPUT);
    canvas.toBlob((blob) => blob && onCropped(blob), 'image/png');
  }

  return (
    <Modal
      open={file !== null}
      onOpenChange={(open) => !open && onCancel()}
      title="Crop your avatar"
    >
      <div className="crop">
        <div
          className="crop-viewport"
          style={{ width: VIEWPORT, height: VIEWPORT }}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              ox: clamped.offsetX,
              oy: clamped.offsetY,
            };
          }}
          onPointerMove={move}
          onPointerUp={() => (drag.current = null)}
          role="img"
          aria-label="Drag the picture to position it"
        >
          {image && state && (
            <img
              src={image.src}
              alt=""
              draggable={false}
              style={{
                width: image.naturalWidth * scaleOf(state),
                height: image.naturalHeight * scaleOf(state),
                transform: `translate(calc(-50% + ${String(clamped.offsetX)}px), calc(-50% + ${String(clamped.offsetY)}px))`,
              }}
            />
          )}
          <span className="crop-mask" aria-hidden="true" />
        </div>
        <label className="field">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="modal-actions">
        <button className="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button button-primary" onClick={confirm} disabled={!image}>
          Use this crop
        </button>
      </div>
    </Modal>
  );
}
