/**
 * Common OPD investigations in Indian primary care, with their analytes.
 * Reference ranges are typical adult values for flagging only: the lab's own
 * printed range wins, and staff can override it per result.
 */
export interface LabAnalyte {
    code: string;
    name: string;
    unit?: string;
    low?: number;
    high?: number;
    /** Free text (e.g. "Positive", "Nil") instead of a number. */
    text?: boolean;
}

export interface LabTest {
    code: string;
    name: string;
    analytes: LabAnalyte[];
}

const single = (code: string, name: string, unit?: string, low?: number, high?: number): LabTest =>
    ({ code, name, analytes: [{ code, name, unit, low, high }] });

export const LAB_TESTS: LabTest[] = [
    {
        code: 'CBC', name: 'Complete blood count', analytes: [
            { code: 'HB', name: 'Haemoglobin', unit: 'g/dL', low: 12, high: 17 },
            { code: 'TLC', name: 'Total leucocyte count', unit: '/µL', low: 4000, high: 11000 },
            { code: 'PLT', name: 'Platelets', unit: 'lakh/µL', low: 1.5, high: 4.5 },
            { code: 'ESR', name: 'ESR', unit: 'mm/hr', low: 0, high: 20 }
        ]
    },
    single('FBS', 'Fasting blood sugar', 'mg/dL', 70, 100),
    single('PPBS', 'Post-prandial blood sugar', 'mg/dL', 70, 140),
    single('RBS', 'Random blood sugar', 'mg/dL', 70, 140),
    single('HBA1C', 'HbA1c', '%', 4, 5.7),
    {
        code: 'LIPID', name: 'Lipid profile', analytes: [
            { code: 'TC', name: 'Total cholesterol', unit: 'mg/dL', low: 0, high: 200 },
            { code: 'TG', name: 'Triglycerides', unit: 'mg/dL', low: 0, high: 150 },
            { code: 'HDL', name: 'HDL', unit: 'mg/dL', low: 40, high: 100 },
            { code: 'LDL', name: 'LDL', unit: 'mg/dL', low: 0, high: 100 }
        ]
    },
    {
        code: 'RFT', name: 'Kidney function (RFT)', analytes: [
            { code: 'UREA', name: 'Blood urea', unit: 'mg/dL', low: 15, high: 40 },
            { code: 'CREAT', name: 'Serum creatinine', unit: 'mg/dL', low: 0.6, high: 1.3 },
            { code: 'URIC', name: 'Uric acid', unit: 'mg/dL', low: 3.5, high: 7.2 }
        ]
    },
    {
        code: 'LFT', name: 'Liver function (LFT)', analytes: [
            { code: 'TBIL', name: 'Total bilirubin', unit: 'mg/dL', low: 0.2, high: 1.2 },
            { code: 'SGPT', name: 'SGPT (ALT)', unit: 'U/L', low: 7, high: 56 },
            { code: 'SGOT', name: 'SGOT (AST)', unit: 'U/L', low: 5, high: 40 },
            { code: 'ALP', name: 'Alkaline phosphatase', unit: 'U/L', low: 44, high: 147 }
        ]
    },
    {
        code: 'TFT', name: 'Thyroid profile', analytes: [
            { code: 'TSH', name: 'TSH', unit: 'µIU/mL', low: 0.4, high: 4.0 },
            { code: 'FT4', name: 'Free T4', unit: 'ng/dL', low: 0.8, high: 1.8 }
        ]
    },
    single('TSH-ONLY', 'TSH', 'µIU/mL', 0.4, 4.0),
    {
        code: 'URINE', name: 'Urine routine', analytes: [
            { code: 'U-ALB', name: 'Albumin', text: true },
            { code: 'U-SUG', name: 'Sugar', text: true },
            { code: 'U-PUS', name: 'Pus cells', unit: '/hpf', low: 0, high: 5 }
        ]
    },
    single('VITD', 'Vitamin D (25-OH)', 'ng/mL', 30, 100),
    single('B12', 'Vitamin B12', 'pg/mL', 200, 900),
    single('CRP', 'C-reactive protein', 'mg/L', 0, 6),
    { code: 'DENGUE', name: 'Dengue NS1 / IgM', analytes: [{ code: 'DENGUE', name: 'Dengue NS1 / IgM', text: true }] },
    { code: 'WIDAL', name: 'Widal test', analytes: [{ code: 'WIDAL', name: 'Widal', text: true }] },
    { code: 'MP', name: 'Malaria parasite', analytes: [{ code: 'MP', name: 'Malaria parasite', text: true }] },
    { code: 'ECG', name: 'ECG', analytes: [{ code: 'ECG', name: 'ECG finding', text: true }] },
    { code: 'XRAY-CHEST', name: 'Chest X-ray', analytes: [{ code: 'XRAY-CHEST', name: 'Chest X-ray finding', text: true }] }
];

export function findLabTest(code: string): LabTest | undefined {
    return LAB_TESTS.find((t) => t.code === code);
}

/** H or L against the range when both value and range are numbers, else null. */
export function flagResult(value: number | null | undefined, low?: number | null, high?: number | null): 'H' | 'L' | null {
    if (value == null || !Number.isFinite(value)) return null;
    if (high != null && Number.isFinite(high) && value > high) return 'H';
    if (low != null && Number.isFinite(low) && value < low) return 'L';
    return null;
}
