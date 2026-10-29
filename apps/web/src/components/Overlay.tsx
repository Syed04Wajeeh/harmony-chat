import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { CloseIcon } from './Icons.js';

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** `sheet` is always a bottom sheet; the default is centred on desktop and a sheet on phones. */
  variant?: 'dialog' | 'sheet' | 'viewer';
  hideTitle?: boolean;
  /** A wider dialog on desktop, for editors with a side-by-side preview. */
  wide?: boolean;
  /** Ignore outside taps this long after opening, e.g. the release of the long-press that opened it. */
  graceMs?: number;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  variant = 'dialog',
  hideTitle = false,
  wide = false,
  graceMs = 0,
}: ModalProps) {
  const openedAt = useRef(0);
  useEffect(() => {
    if (open) openedAt.current = Date.now();
  }, [open]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className={`modal modal-${variant}${wide ? ' modal-wide' : ''}${graceMs ? ' modal-guarded' : ''}`}
          style={graceMs ? ({ '--grace': `${String(graceMs)}ms` } as CSSProperties) : undefined}
          onInteractOutside={(event) => {
            if (Date.now() - openedAt.current < graceMs) event.preventDefault();
          }}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="modal-grabber" aria-hidden="true" />
          <header className={hideTitle ? 'modal-header sr-only' : 'modal-header'}>
            <Dialog.Title className="modal-title">{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close">
              <CloseIcon />
            </Dialog.Close>
          </header>
          {description && (
            <Dialog.Description className="modal-description">{description}</Dialog.Description>
          )}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger = false,
  onConfirm,
}: ConfirmProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="overlay" />
        <AlertDialog.Content className="modal modal-dialog modal-confirm">
          <div className="modal-grabber" aria-hidden="true" />
          <AlertDialog.Title className="modal-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="modal-description">
            {description}
          </AlertDialog.Description>
          <div className="modal-actions">
            <AlertDialog.Cancel className="button">Cancel</AlertDialog.Cancel>
            <AlertDialog.Action
              className={danger ? 'button button-danger' : 'button button-primary'}
              onClick={onConfirm}
            >
              {confirmLabel}
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
