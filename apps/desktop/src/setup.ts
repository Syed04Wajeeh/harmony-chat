import { connect, type Call } from './connect.js';
import {
  discoverServers,
  forgetServer,
  knownServers,
  parsePort,
  switchAccount,
  tailnetMessage,
  tailscaleStatus,
  type Account,
  type FoundServer,
  type KnownServer,
} from './tailnet.js';

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

interface Row {
  title: string;
  detail: string;
  owner?: string;
  warn?: boolean;
  actions: { label: string; quiet?: boolean; run: () => void }[];
}

/** Everything shown comes from other devices, so it is only ever set as text. */
function renderRows(list: HTMLElement, rows: Row[]): void {
  list.replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement('li');
      item.className = 'server';
      if (row.warn) item.dataset['warn'] = '';
      const text = document.createElement('div');
      text.className = 'server-text';
      const title = document.createElement('strong');
      title.textContent = row.title;
      const detail = document.createElement('span');
      detail.className = 'server-url';
      detail.textContent = row.detail;
      text.append(title, detail);
      if (row.owner) {
        const owner = document.createElement('span');
        owner.className = 'owner';
        owner.textContent = row.owner;
        if (row.warn) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'Not your device';
          owner.append(' ', badge);
        }
        text.append(owner);
      }
      const actions = document.createElement('div');
      actions.className = 'row';
      for (const action of row.actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        if (action.quiet) button.className = 'quiet';
        button.addEventListener('click', action.run);
        actions.append(button);
      }
      item.append(text, actions);
      return item;
    }),
  );
}

/**
 * Wires the setup page: Tailscale discovery, recent servers, manual entry and account switching.
 * Nothing connects without a click on a Connect button or the form.
 */
export async function mountSetup(root: ParentNode, call?: Call): Promise<void> {
  const form = required<HTMLFormElement>(root, '#setup');
  const input = required<HTMLInputElement>(root, '#server-url');
  const error = required<HTMLElement>(root, '#error');
  const submit = required<HTMLButtonElement>(root, '#submit');
  const rescan = required<HTMLButtonElement>(root, '#rescan');
  const status = required<HTMLElement>(root, '#tailnet-status');
  const found = required<HTMLElement>(root, '#found');
  const extraPort = required<HTMLInputElement>(root, '#extra-port');
  const portError = required<HTMLElement>(root, '#port-error');
  const recentPanel = required<HTMLElement>(root, '#recent-panel');
  const recent = required<HTMLElement>(root, '#recent');
  const accountsPanel = required<HTMLElement>(root, '#accounts-panel');
  const accounts = required<HTMLElement>(root, '#accounts');
  const confirm = required<HTMLElement>(root, '#switch-confirm');
  const confirmText = required<HTMLElement>(root, '#switch-text');
  const confirmYes = required<HTMLButtonElement>(root, '#switch-yes');
  const confirmNo = required<HTMLButtonElement>(root, '#switch-no');
  const switchError = required<HTMLElement>(root, '#switch-error');

  let connecting = false;
  let pendingSwitch: Account | null = null;

  const setBusy = (busy: boolean) => {
    connecting = busy;
    for (const button of root.querySelectorAll<HTMLButtonElement>('button:not(#rescan)')) {
      if (button.closest('#switch-confirm')) continue;
      button.disabled = busy;
    }
  };

  async function open(url: string, ownerLabel?: string): Promise<void> {
    if (connecting) return;
    error.hidden = true;
    setBusy(true);
    submit.textContent = 'Connecting…';
    const result = await connect(url, call, ownerLabel);
    if (result.ok) return;
    error.textContent = result.message;
    error.hidden = false;
    setBusy(false);
    submit.textContent = 'Connect';
  }

  const foundRow = (server: FoundServer): Row => ({
    title: server.hostname,
    detail: server.url,
    owner: server.ownerLabel,
    warn: server.warn,
    actions: [
      {
        label: server.warn ? 'Connect anyway' : 'Connect',
        run: () => void open(server.url, server.ownerLabel),
      },
    ],
  });

  const recentRow = (server: KnownServer): Row => ({
    title: server.name,
    detail: server.url,
    ...(server.ownerLabel && { owner: server.ownerLabel }),
    actions: [
      { label: 'Connect', run: () => void open(server.url) },
      {
        label: 'Forget',
        quiet: true,
        run: () => {
          void forgetServer(server.url, call).then(refreshRecent, refreshRecent);
        },
      },
    ],
  });

  async function refreshRecent(): Promise<void> {
    const servers = await knownServers(call);
    recentPanel.hidden = servers.length === 0;
    renderRows(recent, servers.map(recentRow));
  }

  function renderAccounts(list: Account[]): void {
    accountsPanel.hidden = list.length === 0;
    renderRows(
      accounts,
      list.map((account) => ({
        title: account.account,
        detail: account.tailnet,
        ...(account.current && { owner: 'Current account' }),
        actions: account.current
          ? []
          : [
              {
                label: 'Switch',
                run: () => {
                  pendingSwitch = account;
                  confirmText.textContent = `Switch Tailscale to ${account.account} (${account.tailnet})? This changes the network identity of every app on this device while it is active.`;
                  switchError.hidden = true;
                  confirm.hidden = false;
                  confirmNo.focus();
                },
              },
            ],
      })),
    );
  }

  let scanning = false;
  async function scan(): Promise<void> {
    if (scanning) return;
    const port = parsePort(extraPort.value);
    portError.hidden = port !== 'invalid';
    if (port === 'invalid') return;
    scanning = true;
    rescan.disabled = true;
    found.replaceChildren();
    status.textContent = 'Looking for Harmony servers on your tailnet…';
    const view = await tailscaleStatus(call);
    renderAccounts(view.accounts);
    status.textContent = tailnetMessage(view);
    if (view.state === 'running') {
      const servers = await discoverServers(port, call);
      renderRows(found, servers.map(foundRow));
      if (servers.length === 0) {
        status.textContent += ' No Harmony servers found. Rescan, or enter an address below.';
      }
    }
    scanning = false;
    rescan.disabled = false;
  }

  confirmNo.addEventListener('click', () => {
    pendingSwitch = null;
    confirm.hidden = true;
  });
  confirmYes.addEventListener('click', () => {
    const account = pendingSwitch;
    if (!account) return;
    confirmYes.disabled = true;
    void switchAccount(account.id, call).then((result) => {
      confirmYes.disabled = false;
      pendingSwitch = null;
      confirm.hidden = true;
      if (result.ok) {
        void scan();
        return;
      }
      switchError.textContent = result.message;
      switchError.hidden = false;
    });
  });

  rescan.addEventListener('click', () => void scan());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void open(input.value);
  });

  await refreshRecent();
  await scan();
}
