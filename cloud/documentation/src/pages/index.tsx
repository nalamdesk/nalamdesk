import type { ReactNode } from 'react';
import { Redirect } from '@docusaurus/router';

// The docs site opens directly on the User Guide. Developer Guide pages
// are excluded from the build while the repo is private.
export default function Home(): ReactNode {
  return <Redirect to="/docs/user-guide/intro" />;
}
