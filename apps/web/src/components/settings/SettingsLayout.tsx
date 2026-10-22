import { useEffect, useRef, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Outlet, useMatch, useNavigate } from 'react-router';
import { useIsDesktop } from '../../hooks/useMediaQuery.js';
import { ArrowLeftIcon, ChevronRightIcon, CloseIcon } from '../Icons.js';
import { Toasts } from '../Toasts.js';

export interface SettingsNavItem {
  to: string;
  label: string;
  /** Items with the same group are listed under one heading. */
  group?: string;
}

interface LayoutProps {
  title: string;
  subtitle?: string;
  /** The settings root; on phones it shows the list of sections. */
  base: string;
  items: readonly SettingsNavItem[];
}

/**
 * Full-screen settings: sections on the left and the page on the right on desktop, a list that
 * drills down into pages on phones. Escape closes it from anywhere.
 */
export function SettingsLayout({ title, subtitle, base, items }: LayoutProps) {
  const desktop = useIsDesktop();
  const atRoot = useMatch({ path: base, end: true }) !== null;
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Dialogs and menus handle (and consume) their own Escape first.
      if (event.key === 'Escape' && !event.defaultPrevented) void navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const first = items[0];
  if (desktop && atRoot && first) return <Navigate replace to={first.to} />;

  const groups = [...new Set(items.map((item) => item.group ?? ''))];
  return (
    <div className="app settings">
      <div className="settings-layout">
        {(desktop || atRoot) && (
          <nav className="settings-nav" aria-label={`${title} sections`}>
            <h1 className="settings-title">{title}</h1>
            {subtitle && <p className="settings-subtitle">{subtitle}</p>}
            {groups.map((group) => (
              <div key={group} className="settings-group">
                {group && <h2 className="settings-group-title">{group}</h2>}
                <ul>
                  {items
                    .filter((item) => (item.group ?? '') === group)
                    .map((item) => (
                      <li key={item.to}>
                        <NavLink to={item.to} className="settings-link">
                          <span>{item.label}</span>
                          {!desktop && <ChevronRightIcon width={18} height={18} />}
                        </NavLink>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </nav>
        )}
        {(desktop || !atRoot) && (
          <main className="settings-main">
            <Outlet />
          </main>
        )}
        <button
          type="button"
          className="settings-close"
          aria-label="Close settings"
          onClick={() => void navigate('/')}
        >
          <CloseIcon width={22} height={22} />
          {desktop && <span aria-hidden="true">ESC</span>}
        </button>
      </div>
      <Toasts />
    </div>
  );
}

interface PageProps {
  title: string;
  /** Where the phone's back arrow goes. */
  back: string;
  children: ReactNode;
}

export function SettingsPage({ title, back, children }: PageProps) {
  const desktop = useIsDesktop();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);

  return (
    <div className="settings-page">
      <header className="settings-page-header">
        {!desktop && (
          <Link to={back} className="icon-button" aria-label="Back">
            <ArrowLeftIcon />
          </Link>
        )}
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
      </header>
      <div className="settings-body">{children}</div>
    </div>
  );
}

export function SettingsCard({
  title,
  description,
  children,
  danger = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section className="settings-card" data-danger={danger || undefined}>
      <h2>{title}</h2>
      {description && <p className="settings-card-description">{description}</p>}
      {children}
    </section>
  );
}
