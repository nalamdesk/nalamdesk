/**
 * NMC generic-first prescription labeling (issue #56).
 *
 * Printed lines lead with the generic composition and carry the brand in
 * parentheses: `Paracetamol (Crocin)`. Free-text lines without a generic
 * print unchanged, so uncatalogued entries never block the workflow.
 */
export function formatRxMedicineName(line: {
    medicine?: string | null;
    generic_name?: string | null;
    brand_name?: string | null;
}): string {
    const raw = String(line?.medicine || '').trim();
    const generic = String(line?.generic_name || '').trim();
    if (!generic) return raw;
    const brand = String(line?.brand_name || '').trim();
    if (!brand || brand.toLowerCase() === generic.toLowerCase()) return generic;
    const lowerRaw = raw.toLowerCase();
    // Catalog row names are usually "Brand + strength" (Crocin 500): when
    // the typed name already carries the brand, GENERIC (Brand) suffices.
    if (!raw || lowerRaw.includes(brand.toLowerCase()) || lowerRaw.includes(generic.toLowerCase())) {
        return `${generic} (${brand})`;
    }
    return `${generic} (${brand}, as ${raw})`;
}
