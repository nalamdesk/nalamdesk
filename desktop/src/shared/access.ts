/**
 * Single catalog of data-plane actions for role management UI and policy
 * tooling. Transport allowlists (server) and handler registration (main)
 * stay authoritative for what exists; this catalog is the human-facing
 * grouping used when admins compose custom roles. Destructive and secret
 * actions are flagged so the UI can warn, never to hide them.
 */

export interface CatalogGroup {
    label: string;
    methods: string[];
}

export const BUILTIN_ROLES = ['admin', 'doctor', 'nurse', 'receptionist'] as const;

export const METHOD_CATALOG: CatalogGroup[] = [
    {
        label: 'Queue & triage',
        methods: [
            'getQueue', 'addToQueue', 'removeFromQueue', 'updateQueueStatus',
            'updateQueueStatusByPatientId', 'reassessQueueTriage', 'getQueueTriageHistory'
        ]
    },
    {
        label: 'Patients & visits',
        methods: [
            'getPatients', 'getPatientById', 'savePatient', 'deletePatient',
            'getVisits', 'getAllVisits', 'saveVisit', 'deleteVisit',
            'getDashboardStats', 'getDoctors', 'getAppointments', 'saveAppointment',
            'updateAppointmentRequestStatus', 'getAppointmentRequests'
        ]
    },
    {
        label: 'Consultations',
        methods: [
            'beginConsultation', 'beginNextConsultation', 'completeConsultation',
            'postponeConsultation', 'resumeConsultation', 'getActiveConsultation',
            'saveConsultationProgress'
        ]
    },
    {
        label: 'Vitals',
        methods: ['getVitals', 'saveVitals', 'getEncounterVitals', 'getVitalsHistory']
    },
    {
        label: 'Clinical safety records',
        methods: [
            'getAllergies', 'saveAllergy', 'deleteAllergy',
            'getConditions', 'saveCondition', 'deleteCondition',
            'getMedications', 'saveMedication', 'deleteMedication',
            'getPatientSafetyContext', 'searchConditions', 'searchMedicines',
            'createCondition', 'createMedicine', 'getConditionMedPresets',
            'listConditions', 'listMedicines', 'updateCondition', 'updateMedicine',
            'retireCondition', 'retireMedicine', 'replaceConditionMedPresets'
        ]
    },
    {
        label: 'ABDM intake & records',
        methods: [
            'abdmAbhaLookup', 'abdmAbhaRequestOtp', 'abdmAbhaConfirmOtp',
            'abdmAbhaRequestLoginOtp', 'abdmAbhaConfirmLoginOtp', 'abdmAbhaCard',
            'abdmLinkAbha', 'findPatientByAbha', 'abdmGetShareTokens',
            'abdmAcceptShareToken', 'abdmAcceptShareTokenAndCheckIn',
            'abdmGetInbox', 'abdmAckInbox', 'abdmGetConfig',
            'abdmHiuGetPublicKey', 'abdmHiuRequestConsent', 'abdmHiuGetConsents',
            'abdmHiuFetchRecords', 'abdmHiuGetExternalRecords', 'abdmHiuClearExternalRecords',
            'abdmHiuImportMedication', 'abdmTransferBundle'
        ]
    },
    {
        label: 'System & session',
        methods: ['getPublicSettings', 'validateUser', 'getPermissions']
    },
    {
        label: 'Administration (admin-only recommended)',
        methods: [
            'getUsers', 'saveUser', 'deleteUser', 'getAllRoles',
            'getSettings', 'saveSettings', 'getAuditLogs',
            'getUserOverrides', 'saveUserOverride', 'deleteUserOverride',
            'abdmSaveConfig', 'abdmSetSecret', 'abdmTestConnectivity', 'abdmSimulateShare'
        ]
    }
];

/** Flat set of every catalogued action, for validation. */
export const ALL_CATALOGUED_ACTIONS: ReadonlySet<string> = new Set(
    METHOD_CATALOG.flatMap((group) => group.methods)
);

export interface RoleTemplate {
    name: string;
    description: string;
    permissions: string[];
}

/** Predefined permission sets an admin can start a custom role from. */
export const ROLE_TEMPLATES: RoleTemplate[] = [
    {
        name: 'Front Desk',
        description: 'Reception work: intake, queue, appointments, vitals reads.',
        permissions: [
            'getPatients', 'savePatient', 'getQueue', 'addToQueue', 'removeFromQueue',
            'updateQueueStatus', 'updateQueueStatusByPatientId', 'getPublicSettings',
            'getDashboardStats', 'getAppointments', 'saveAppointment', 'getVisits',
            'getVitals', 'getVitalsHistory', 'getEncounterVitals',
            'abdmAbhaLookup', 'abdmGetShareTokens', 'abdmAcceptShareToken',
            'abdmGetInbox'
        ]
    },
    {
        name: 'Clinical Observer',
        description: 'Read-only clinical access for auditors and trainees. No mutations.',
        permissions: [
            'getPatients', 'getPatientById', 'getVisits', 'getAllVisits',
            'getQueue', 'getVitals', 'getVitalsHistory', 'getEncounterVitals',
            'getAllergies', 'getConditions', 'getMedications', 'getPatientSafetyContext',
            'getDashboardStats', 'getDoctors', 'getPublicSettings',
            'searchConditions', 'searchMedicines', 'listConditions', 'listMedicines',
            'abdmHiuGetExternalRecords'
        ]
    },
    {
        name: 'Triage Nurse',
        description: 'Nurse desk: vitals, triage, queue monitoring with reassessment.',
        permissions: [
            'getPatients', 'getQueue', 'updateQueueStatus', 'reassessQueueTriage',
            'getQueueTriageHistory', 'getVitals', 'saveVitals', 'getVitalsHistory',
            'getEncounterVitals', 'getAllergies', 'getConditions', 'getMedications',
            'getPatientSafetyContext', 'getDashboardStats', 'getVisits', 'getPublicSettings',
            'abdmGetInbox'
        ]
    },
    {
        name: 'Blank Role',
        description: 'Start empty and pick individual actions.',
        permissions: []
    }
];
