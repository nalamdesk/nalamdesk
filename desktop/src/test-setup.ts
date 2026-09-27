console.log('Test Setup Running');
import 'zone.js';
// import 'zone.js/testing';
import '@angular/compiler';
import { afterEach } from 'vitest';
import { getTestBed } from '@angular/core/testing';
import {
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting,
} from '@angular/platform-browser-dynamic/testing';

const testBed = getTestBed();
testBed.resetTestEnvironment();
testBed.initTestEnvironment(
    BrowserDynamicTestingModule,
    platformBrowserDynamicTesting()
);

// Deterministic teardown: never rely on implicit TestBed reset ordering.
// Under CI load the implicit reset races test setup and fails suites with
// "Cannot configure the test module when it has already been instantiated".
afterEach(() => {
    try {
        getTestBed().resetTestingModule();
    } catch {
        // Never instantiated in this file: nothing to reset.
    }
});


// Mock Electron
(window as any).electron = {
    db: {
        getPatients: () => Promise.resolve([]),
        getQueue: () => Promise.resolve([]),
        getDashboardStats: () => Promise.resolve({ totalPatients: 0, todayVisits: 0 }),
        getSettings: () => Promise.resolve({}),
    }
};
