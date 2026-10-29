import { useSearchParams } from 'react-router';
import { DmItems } from '../components/ChannelSidebar.js';
import { MenuIcon } from '../components/Icons.js';
import { MemberDirectory } from '../components/MemberDirectory.js';
import { useIsDesktop } from '../hooks/useMediaQuery.js';
import { useApp } from '../store/store.js';
import { useUi } from '../store/ui.js';

type Tab = 'members' | 'messages';

const TABS: { id: Tab; label: string }[] = [
  { id: 'members', label: 'All members' },
  { id: 'messages', label: 'Messages' },
];

export function HomeView() {
  const desktop = useIsDesktop();
  const setDrawer = useUi((state) => state.setDrawer);
  const hasDms = useApp((state) => Object.values(state.channels).some((c) => c.kind === 'dm'));
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  // With no conversations yet, the directory is the useful place to land.
  const tab: Tab =
    requested === 'members' || requested === 'messages'
      ? requested
      : hasDms
        ? 'messages'
        : 'members';

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
          <h1>Home</h1>
        </div>
      </header>
      <div className="home-tabs" role="tablist" aria-label="Home sections">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            className="chip"
            aria-selected={tab === id}
            data-active={tab === id || undefined}
            onClick={() => setParams({ tab: id }, { replace: true })}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'members' ? (
        <MemberDirectory />
      ) : desktop ? (
        <div className="empty-state">
          <h2>Pick a conversation</h2>
          <p>
            Choose someone from the list, or find a person under All members to start a new one.
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
