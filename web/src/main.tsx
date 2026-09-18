import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import Host from './Host.tsx';
import Join from './Join.tsx';
import Present from './Present.tsx';

function Router() {
  const path = location.pathname;
  if (path === '/' || path === '') {
    // Plain redirect: the host console is the only entry point on this machine.
    location.replace('/host');
    return null;
  }
  const join = /^\/join\/([^/]+)\/?$/.exec(path);
  if (join) return <Join token={decodeURIComponent(join[1])} />;
  const present = /^\/present\/([^/]+)\/?$/.exec(path);
  if (present) return <Present token={decodeURIComponent(present[1])} />;
  if (path === '/host' || path === '/host/') return <Host />;
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-neutral-400">
      <div>
        <div className="text-lg text-neutral-200">Page not found</div>
        <a className="text-sky-400 underline" href="/host">
          Go to the host console
        </a>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
