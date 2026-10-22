import { connect, storedServerUrl, type Call } from './connect.js';

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

/** Wires the setup form: prefill from the stored address, connect on submit, show errors. */
export async function mountSetup(root: ParentNode, call?: Call): Promise<void> {
  const form = required<HTMLFormElement>(root, '#setup');
  const input = required<HTMLInputElement>(root, '#server-url');
  const error = required<HTMLElement>(root, '#error');
  const submit = required<HTMLButtonElement>(root, '#submit');

  input.value = await storedServerUrl(call);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Connecting…';
    void connect(input.value, call).then((result) => {
      if (result.ok) return;
      error.textContent = result.message;
      error.hidden = false;
      submit.disabled = false;
      submit.textContent = 'Connect';
      input.focus();
    });
  });
}
