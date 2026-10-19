import { Directory } from './components/Directory';
import { SiteFooter, SiteHeader } from './components/Chrome';
import { StatusPage } from './components/StatusPage';
import { usePath } from './navigation';

export function App() {
    const path = usePath();
    const statusMatch = /^\/booking(?:\/([^/]+))?\/?$/.exec(path);

    return (
        <div className="flex min-h-dvh flex-col">
            <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[6px] focus:bg-surface focus:px-3 focus:py-2">
                Skip to content
            </a>
            <SiteHeader />
            <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-5 pb-16 sm:px-8">
                {statusMatch ? <StatusPage initialRef={statusMatch[1] ? decodeURIComponent(statusMatch[1]) : ''} /> : <Directory />}
            </main>
            <SiteFooter />
        </div>
    );
}
