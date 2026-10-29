import {
  MAX_WEBHOOK_SECRET,
  WebhookTemplate,
  type PreviewWebhookBody,
  type Webhook,
  type WebhookFormat,
} from '@harmony/shared';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api/client.js';
import { FORMAT_INFO, STARTER_TEMPLATE, WEBHOOK_FORMAT_ORDER } from '../../lib/webhook-formats.js';
import { attempt } from '../../store/actions.js';
import { Embeds } from '../Embeds.js';
import { Markdown } from '../Markdown.js';
import { Modal } from '../Overlay.js';

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
const noName = () => undefined;

interface Inputs {
  /** What is wrong with the editor's text, if anything; nothing is sent then. */
  error: string | null;
  request: PreviewWebhookBody | null;
  template: WebhookTemplate | null;
  key: string;
}

function readInputs(
  format: WebhookFormat,
  templateText: string,
  sampleText: string,
  event: string,
): Inputs {
  let template: WebhookTemplate | null = null;
  if (format === 'template') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(templateText);
    } catch {
      return { error: 'The template is not valid JSON.', request: null, template, key: '' };
    }
    const checked = WebhookTemplate.safeParse(parsed);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      const where = issue?.path.join('.');
      return {
        error: `${where ? `${where}: ` : ''}${issue?.message ?? 'The template is not valid.'}`,
        request: null,
        template,
        key: '',
      };
    }
    template = checked.data;
  }

  let body: unknown;
  try {
    body = JSON.parse(sampleText);
  } catch {
    // Watchtower can send plain text, so a sample that is not JSON is sent as text.
    if (format !== 'watchtower') {
      return { error: 'The sample payload is not valid JSON.', request: null, template, key: '' };
    }
    body = sampleText;
  }
  const eventHeader = FORMAT_INFO[format].eventHeader;
  const request: PreviewWebhookBody = {
    body,
    format,
    ...(template && { template }),
    ...(eventHeader && event.trim() && { headers: { [eventHeader]: event.trim() } }),
  };
  return { error: null, request, template, key: JSON.stringify(request) };
}

type Result = { key: string; message: Awaited<ReturnType<typeof api.previewWebhook>>['message'] };
type Failure = { key: string; error: string };

function Preview({ id, inputs }: { id: string; inputs: Inputs }) {
  const [outcome, setOutcome] = useState<Result | Failure | null>(null);
  const { request, key, error } = inputs;

  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.previewWebhook(id, request, controller.signal).then(
        (res) => setOutcome({ key, message: res.message }),
        (err: unknown) => {
          if (controller.signal.aborted) return;
          setOutcome({ key, error: err instanceof Error ? err.message : 'Preview failed' });
        },
      );
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, key, id]);

  const current = outcome?.key === key ? outcome : null;
  return (
    <div className="webhook-preview" aria-live="polite" aria-label="Preview">
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : !current ? (
        <p className="field-hint" role="status">
          Rendering…
        </p>
      ) : 'error' in current ? (
        <p className="field-error" role="alert">
          {current.error}
        </p>
      ) : current.message === null ? (
        <p className="field-hint">Nothing would be posted for this sample.</p>
      ) : (
        <div className="webhook-preview-message" data-testid="webhook-preview-message">
          {current.message.content && (
            <div className="message-content">
              <Markdown content={current.message.content} nameOf={noName} meId="" />
            </div>
          )}
          <Embeds embeds={current.message.embeds} nameOf={noName} meId="" />
        </div>
      )}
    </div>
  );
}

export function WebhookEditor({
  webhook,
  open,
  onOpenChange,
  onSaved,
}: {
  webhook: Webhook;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (webhook: Webhook) => void;
}) {
  const [format, setFormat] = useState<WebhookFormat>(webhook.format);
  const [templateText, setTemplateText] = useState(pretty(webhook.template ?? STARTER_TEMPLATE));
  const [sampleText, setSampleText] = useState(pretty(FORMAT_INFO[webhook.format].sample));
  const [event, setEvent] = useState(webhook.format === 'github' ? 'pull_request' : 'push');
  const [secret, setSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const [busy, setBusy] = useState(false);

  const info = FORMAT_INFO[format];
  const inputs = useMemo(
    () => readInputs(format, templateText, sampleText, event),
    [format, templateText, sampleText, event],
  );
  const secretProblem =
    secret !== '' && secret.trim().length < 8 ? 'Use at least 8 characters.' : null;

  function chooseFormat(next: WebhookFormat) {
    setFormat(next);
    setSampleText(pretty(FORMAT_INFO[next].sample));
    setEvent(next === 'github' ? 'pull_request' : 'push');
    setSecret('');
    setRemoveSecret(false);
  }

  async function save(submit: FormEvent) {
    submit.preventDefault();
    if (inputs.error || secretProblem) return;
    setBusy(true);
    const saved = await attempt(
      api.updateWebhook(webhook.id, {
        format,
        ...(format === 'template' && inputs.template && { template: inputs.template }),
        ...(info.signed && secret !== '' && { secret: secret.trim() }),
        ...(info.signed && removeSecret && secret === '' && { secret: null }),
      }),
      'Could not save the webhook',
    );
    setBusy(false);
    if (saved) {
      onSaved(saved);
      onOpenChange(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={`Settings for ${webhook.name}`}
      description="Choose how this webhook turns what a service sends into a message."
    >
      <form className="form webhook-editor" onSubmit={(event) => void save(event)}>
        <div className="webhook-editor-columns">
          <div className="webhook-editor-column">
            <label className="field">
              <span>Format</span>
              <select
                value={format}
                onChange={(e) => chooseFormat(e.target.value as WebhookFormat)}
              >
                {WEBHOOK_FORMAT_ORDER.map((value) => (
                  <option key={value} value={value}>
                    {FORMAT_INFO[value].label}
                  </option>
                ))}
              </select>
            </label>
            <p className="field-hint">{info.hint}</p>

            {format === 'template' && (
              <label className="field">
                <span>Template (JSON)</span>
                <textarea
                  className="code-input"
                  rows={12}
                  spellCheck={false}
                  value={templateText}
                  onChange={(e) => setTemplateText(e.target.value)}
                />
              </label>
            )}
            {format === 'template' && (
              <p className="field-hint">
                Use {'{{path.to.field}}'} with the filters upper, lower, truncate:N, default:
                &quot;x&quot; and json. Missing fields render empty.
              </p>
            )}

            {info.signed && (
              <div className="field">
                <label htmlFor="webhook-secret">
                  <span>Signing secret</span>
                </label>
                <input
                  id="webhook-secret"
                  type="password"
                  autoComplete="new-password"
                  maxLength={MAX_WEBHOOK_SECRET}
                  value={secret}
                  placeholder={webhook.hasSecret && !removeSecret ? 'Set. Type to replace.' : ''}
                  onChange={(e) => {
                    setSecret(e.target.value);
                    setRemoveSecret(false);
                  }}
                />
                <small className="field-hint">
                  {secretProblem ??
                    'Enter the same secret in the sender. Requests without a matching signature are refused.'}
                </small>
                {webhook.hasSecret && (
                  <button
                    type="button"
                    className="button button-ghost"
                    aria-pressed={removeSecret}
                    onClick={() => {
                      setRemoveSecret(!removeSecret);
                      setSecret('');
                    }}
                  >
                    {removeSecret ? 'Keep the secret' : 'Remove the secret'}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="webhook-editor-column">
            <label className="field">
              <span>Sample payload (JSON)</span>
              <textarea
                className="code-input"
                rows={format === 'template' ? 8 : 12}
                spellCheck={false}
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
              />
            </label>
            {info.eventHeader && (
              <label className="field">
                <span>Event ({info.eventHeader})</span>
                <input
                  value={event}
                  maxLength={60}
                  onChange={(e) => setEvent(e.target.value)}
                  placeholder="push"
                />
              </label>
            )}
            <Preview id={webhook.id} inputs={inputs} />
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="button" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={busy || inputs.error !== null || secretProblem !== null}
          >
            Save webhook
          </button>
        </div>
      </form>
    </Modal>
  );
}
