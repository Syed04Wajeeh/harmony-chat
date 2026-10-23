import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBar } from './TitleBar.js';

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/130.0';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

function shell(maximized = false) {
  const state = { maximized };
  const invoke = vi.fn((command: string) =>
    Promise.resolve(command === 'window_is_maximized' ? state.maximized : undefined),
  );
  window.__TAURI_INTERNALS__ = { invoke };
  return { invoke, state };
}

const userAgent = (value: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(value);

beforeEach(() => userAgent(WINDOWS));
afterEach(() => {
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('TitleBar', () => {
  it('renders nothing in a browser', () => {
    const { container } = render(<TitleBar />);
    expect(container).toBeEmptyDOMElement();
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
  });

  it('renders nothing in the desktop app on another platform', () => {
    shell();
    userAgent(MAC);
    const { container } = render(<TitleBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the bar and reserves room for it in the desktop app on Windows', async () => {
    shell();
    const { unmount } = render(<TitleBar />);
    expect(screen.getByRole('banner')).toHaveTextContent('Harmony');
    expect(document.documentElement.dataset['titlebar']).toBe('');
    await act(() => Promise.resolve());
    unmount();
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
  });

  it('sends each button to the shell', async () => {
    const { invoke } = shell();
    render(<TitleBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(invoke).toHaveBeenCalledWith('window_minimize', {});
    expect(invoke).toHaveBeenCalledWith('window_toggle_maximize', {});
    expect(invoke).toHaveBeenCalledWith('window_close', {});
    await act(() => Promise.resolve());
  });

  it('shows Restore while the window is maximized and follows resizes', async () => {
    const { state } = shell(true);
    render(<TitleBar />);
    expect(await screen.findByRole('button', { name: 'Restore' })).toHaveAttribute(
      'data-state',
      'maximized',
    );
    state.maximized = false;
    fireEvent(window, new Event('resize'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Maximize' })).toHaveAttribute(
        'data-state',
        'normal',
      ),
    );
  });

  it('drags on mouse down and toggles maximize on a double click', async () => {
    const { invoke } = shell();
    const { container } = render(<TitleBar />);
    const drag = container.querySelector('.titlebar-drag');
    if (!drag) throw new Error('missing drag region');
    fireEvent.mouseDown(drag, { button: 0, detail: 1 });
    expect(invoke).toHaveBeenCalledWith('window_start_dragging', {});
    fireEvent.mouseDown(drag, { button: 0, detail: 2 });
    expect(invoke).toHaveBeenCalledWith('window_toggle_maximize', {});
    invoke.mockClear();
    fireEvent.mouseDown(drag, { button: 2, detail: 1 });
    expect(invoke).not.toHaveBeenCalled();
    await act(() => Promise.resolve());
  });

  it('disconnects from the server through its menu', async () => {
    const { invoke } = shell();
    render(<TitleBar />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Server menu' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disconnect from this server' }));
    expect(invoke).toHaveBeenCalledWith('disconnect_server', {});
  });
});
