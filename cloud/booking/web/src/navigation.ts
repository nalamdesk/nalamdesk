import { useEffect, useState } from 'react';

// Two pages need no router: the directory at `/` and the status page at
// `/booking/<ref>`. CloudFront rewrites both to index.html.

export function usePath(): string {
    const [path, setPath] = useState(() => window.location.pathname);
    useEffect(() => {
        const onPop = () => setPath(window.location.pathname);
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);
    return path;
}

export function navigate(to: string): void {
    if (to === window.location.pathname) return;
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo({ top: 0 });
}

/** Link that navigates in place but stays a real link for new tabs and screen readers. */
export function onLinkClick(to: string) {
    return (event: React.MouseEvent<HTMLAnchorElement>) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
    };
}
