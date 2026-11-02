import { loadDevelopmentEnv, loadWorkingDirEnv } from '../shared/load-env';

loadDevelopmentEnv();
loadWorkingDirEnv();

void import('./headless/main.js');
