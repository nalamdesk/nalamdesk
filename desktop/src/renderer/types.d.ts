export { };

declare global {
    interface Window {
        electron: {
            login: (credentials: { username: string, password: string }) => Promise<{ success: boolean; user?: any; error?: string; pendingRecoveryCode?: string }>;
            logout: () => Promise<{ success: boolean }>;
            getAppVersion: () => Promise<{
                version: string;
                commit: string | null;
                buildId: string | null;
                isDev: boolean;
                packaged: boolean;
                display: string;
            }>;
            checkSetup: () => Promise<{ isSetup: boolean; hasRecovery: boolean; vaultState?: string; configVersion?: number }>;
            getRecoveryStatus: () => Promise<{ isSetup: boolean; hasRecovery: boolean; hasBackups: boolean; backups?: any[] }>;
            restoreSystemBackup: (request: { path: string; recoveryCode: string; currentAdminPassword?: string }) => Promise<{
                success: boolean; restartRequired?: boolean; preRestoreSnapshot?: string; error?: string
            }>;
            setup: (data: any) => Promise<{ success: boolean; recoveryCode?: string; error?: string }>;
            recover: (data: { recoveryCode: string }) => Promise<{ success: boolean; pendingRecoveryCode?: string; error?: string }>;
            acknowledgeRecoveryCode: (recoveryCode: string) => Promise<{ success: boolean }>;
            regenerateRecoveryCode: (password: string) => Promise<{ success: boolean; recoveryCode?: string; error?: string }>;
            rotateDeviceEnvelope: (currentPassword: string) => Promise<{ success: boolean; error?: string }>;
            changeLoginPassword: (data: { currentPassword: string; newPassword: string }) => Promise<{ success: boolean; error?: string }>;
            resetUserPassword: (data: { targetUserId: number; currentAdminPassword: string; temporaryPassword: string }) => Promise<{ success: boolean; error?: string }>;
            db: {
                getPatients: (query: string) => Promise<any[]>;
                savePatient: (patient: any) => Promise<any>;
                deletePatient: (id: number) => Promise<any>;
                getVisits: (patientId: number) => Promise<any[]>;
                getAllVisits: (limit: number) => Promise<any[]>;
                saveVisit: (visit: any) => Promise<any>;
                beginConsultation: (input: any) => Promise<any>;
                getActiveConsultation: (patientId: number) => Promise<any>;
                saveConsultationProgress: (input: any) => Promise<any>;
                completeConsultation: (input: any) => Promise<any>;
                postponeConsultation: (input: any) => Promise<any>;
                resumeConsultation: (input: any) => Promise<any>;
                beginNextConsultation: (input: any) => Promise<any>;
                deleteVisit: (id: number) => Promise<any>;
                getSettings: () => Promise<any>;
                saveSettings: (settings: any) => Promise<any>;
                getDashboardStats: () => Promise<{ totalPatients: number, todayVisits: number }>;
                getDoctors: () => Promise<any[]>;
                saveDoctor: (doctor: any) => Promise<any>;
                deleteDoctor: (id: number) => Promise<any>;
                // Users
                getUsers: () => Promise<any[]>;
                saveUser: (user: any) => Promise<any>;
                deleteUser: (id: number) => Promise<any>;
                // Queue
                getQueue: () => Promise<any[]>;
                addToQueue: (data: { patientId: number, priority?: number, urgency?: string, triage_notes?: string }) => Promise<any>;
                reassessQueueTriage: (data: { queueId: number; urgency: string; reason: string }) => Promise<any>;
                getQueueTriageHistory: (queueId: number) => Promise<any[]>;
                updateQueueStatus: (data: { id: number, status: string }) => Promise<any>;
                updateQueueStatusByPatientId: (data: { patientId: number, status: string }) => Promise<any>;
                removeFromQueue: (id: number) => Promise<any>;
                // Clinical Safety & Longitudinal Records
                getAllergies: (patientId: number) => Promise<any[]>;
                saveAllergy: (allergy: any) => Promise<any>;
                deleteAllergy: (id: number) => Promise<any>;
                getConditions: (patientId: number) => Promise<any[]>;
                saveCondition: (condition: any) => Promise<any>;
                deleteCondition: (id: number) => Promise<any>;
                getMedications: (patientId: number) => Promise<any[]>;
                saveMedication: (medication: any) => Promise<any>;
                deleteMedication: (id: number) => Promise<any>;
                getPatientSafetyContext: (patientId: number) => Promise<{
                    patient_id: number;
                    allergies: any[];
                    active_allergies: any[];
                    has_active_allergies: boolean;
                    has_life_threatening_allergies: boolean;
                    conditions: any[];
                    active_conditions: any[];
                    medications: any[];
                    active_medications: any[];
                }>;
                // Audit
                getAuditLogs: (limit: number) => Promise<any[]>;
                searchConditions: (query: string, limit?: number) => Promise<any[]>;
                searchMedicines: (query: string, limit?: number) => Promise<any[]>;
                createCondition: (input: { name: string }) => Promise<any>;
                createMedicine: (input: any) => Promise<any>;
                getConditionMedPresets: (conditionId: number) => Promise<any[]>;
                listConditions: (includeRetired?: boolean) => Promise<any[]>;
                listMedicines: (includeRetired?: boolean) => Promise<any[]>;
                updateCondition: (input: any) => Promise<any>;
                updateMedicine: (input: any) => Promise<any>;
                retireCondition: (id: number) => Promise<any>;
                retireMedicine: (id: number) => Promise<any>;
                replaceConditionMedPresets: (input: { conditionId: number; lines: any[] }) => Promise<any[]>;
            };
            drive: {
                isAuthenticated: () => Promise<boolean>;
                disconnect: () => Promise<{ success: boolean; error?: string }>;
                authenticate: (credentials: { clientId: string, clientSecret: string }) => Promise<any>;
                backup: () => Promise<{ success: boolean; error?: string }>;
                restore: (fileId: string) => Promise<{ success: boolean; restartRequired?: boolean; error?: string }>;
                listBackups: () => Promise<any[]>;
            };
            updates: {
                check: (opts?: { source?: 'startup' | 'manual' }) => Promise<any>;
                download: () => Promise<any>;
                install: () => Promise<any>;
                cancel: () => Promise<any>;
                getStatus: () => Promise<any>;
                onEvent: (callback: (status: any) => void) => () => void;
            };
            cloud: {
                getStatus: () => Promise<{ enabled: boolean; clinicId: string | null }>;
                onboard: (data: { name: string; city: string }) => Promise<{ success: boolean; clinicId: string }>;
                toggle: (enabled: boolean) => Promise<void>;
                syncNow: () => Promise<any>;
                publishSlots: (slots: any, dates: string[]) => Promise<any>;
                getPublishedSlots: (date: string) => Promise<any[]>;
            };
            clipboard: {
                writeText: (text: string) => Promise<boolean>;
            },
            backup: {
                selectPath: () => Promise<string | null>;
                selectRestoreBundle: () => Promise<{ path: string; name: string } | null>;
                useDefaultPath: () => Promise<string | null>;
                runNow: () => Promise<{ success: boolean; error?: string }>;
                listSystemBackups: () => Promise<any[]>;
            };
            utils: {
                openExternal: (url: string) => Promise<void>;
                getLocalIp: () => Promise<string>;
                getRuntimeInfo: () => Promise<{ localIp: string; apiPort: number; isDev: boolean; appName: string }>;
            };
        };
    }
}
