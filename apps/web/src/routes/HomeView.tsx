import { DmItems } from '../components/ChannelSidebar.js';
import { MenuIcon } from '../components/Icons.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { useUi } from '../store/ui.js';

export function HomeView() {
  const desktop = useIsDesktop();
  const setDrawer = useUi((state) => state.setDrawer);
  return (
    <section className="channel-view" aria-label="Home">
      <header className="channel-header">
        {!desktop && (
          <button
            className="icon-button nav-button"
            aria-label="Open navigation"
            onClick={() => setDrawer('left')}
          >
            <MenuIcon />
          </button>
        )}
        <div className="channel-title">
          <h1>Direct messages</h1>
        </div>
      </header>
      {desktop ? (
        <div className="empty-state">
          <h2>Pick a conversation</h2>
          <p>
            Choose someone from the list, or open a member's profile in a server to message them.
          </p>
        </div>
      ) : (
        <nav className="home-list" aria-label="Direct messages">
          <DmItems activeChannelId={null} />
        </nav>
      )}
    </section>
  );
}
