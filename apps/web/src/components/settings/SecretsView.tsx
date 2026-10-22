import { Modal } from '../Overlay.js';
import { RevealOnce } from '../RevealOnce.js';

export interface Secret {
  label: string;
  value: string;
  hint?: string;
}

/** The one time the server hands out credentials: every value comes with a copy button. */
export function SecretsView({
  secrets,
  onDone,
}: {
  secrets: readonly Secret[];
  onDone: () => void;
}) {
  return (
    <div className="form">
      {secrets.map((secret) => (
        <div key={secret.label} className="field">
          <span>{secret.label}</span>
          <RevealOnce {...secret} />
        </div>
      ))}
      <div className="modal-actions">
        <button type="button" className="button button-primary" onClick={onDone}>
          I have saved {secrets.length > 1 ? 'these' : 'it'}
        </button>
      </div>
    </div>
  );
}

interface DialogProps {
  title: string;
  description?: string;
  /** Null keeps the dialog closed; the values are dropped from memory when it closes. */
  secrets: readonly Secret[] | null;
  onClose: () => void;
}

export function SecretsDialog({ title, description, secrets, onClose }: DialogProps) {
  return (
    <Modal
      open={secrets !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      {...(description && { description })}
    >
      {secrets && <SecretsView secrets={secrets} onDone={onClose} />}
    </Modal>
  );
}
