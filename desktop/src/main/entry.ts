// App entry (#194): a computer joined to a NalamDesk Server starts in client
// mode, with no local vault or services; every other install starts the
// single-PC app as before.

import { configureUserDataPath } from './client/electron-env';
import { hasServerConnection } from './client/connection-store';

if (hasServerConnection(configureUserDataPath())) {
    require('./client/clientMain');
} else {
    require('./main');
}
