import { useUi } from '../store/ui.js';
import { CloseIcon } from './Icons.js';

export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span>{toast.message}</span>
          <button className="icon-button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
            <CloseIcon width={16} height={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
