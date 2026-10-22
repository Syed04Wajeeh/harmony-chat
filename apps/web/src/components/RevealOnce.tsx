import { useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './Icons.js';

interface Props {
  label: string;
  value: string;
  /** Extra guidance under the warning, e.g. where to paste the value. */
  hint?: string;
}

/** A secret the server will never show again, with a copy button and a warning to match. */
export function RevealOnce({ label, value, hint }: Props) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      setCopied(false);
      setFailed(true);
      field.current?.select();
    }
  }

  return (
    <div className="reveal">
      <textarea
        ref={field}
        className="reveal-value"
        readOnly
        aria-label={label}
        value={value}
        rows={value.length > 100 ? 3 : 2}
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
      />
      <button type="button" className="button button-primary" onClick={() => void copy()}>
        {copied ? <CheckIcon width={18} height={18} /> : <CopyIcon width={18} height={18} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <p className="reveal-warning" role="note">
        <strong>You won&apos;t see this again.</strong> Copy it now and keep it somewhere safe.
        {hint && ` ${hint}`}
      </p>
      {failed && (
        <p className="field-error" role="alert">
          Could not copy automatically. The value is selected; copy it by hand.
        </p>
      )}
    </div>
  );
}
