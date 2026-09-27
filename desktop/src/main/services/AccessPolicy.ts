import { statefulIsAuthorized, preparsePolicySet } from '@cedar-policy/cedar-wasm/nodejs';

export interface AccessPrincipal {
    id: number;
    role: string;
}

export interface AccessRequest {
    user: AccessPrincipal;
    action: string;
    resource?: { type: string; id: string };
    context?: Record<string, unknown>;
}

export interface AccessDecision {
    allow: boolean;
    reasons: string[];
}

interface PolicySource {
    getRoles: () => Array<{ name: string; permissions: string[] | string }>;
    getAllOverrides: () => Array<{ user_id: number; action: string; effect: string }>;
}

const PREPARSED_ID = 'nalamdesk';
const DEFAULT_RESOURCE = { type: 'Clinic', id: 'clinic' };

function actionId(method: string): string {
    return `Action::"${method}"`;
}

/**
 * Fine-grained authorization over the role baseline (M3-RBAC follow-up).
 *
 * - Baseline: every role→method grant compiles to a Cedar permit policy.
 * - Deltas: per-user overrides compile to user-scoped permit/forbid
 *   policies (e.g. a nurse explicitly allowed queue management).
 * - Semantics: default deny; forbid wins. Decisions carry the determining
 *   policy ids for the audit trail.
 * - Availability: if the policy set ever fails to build, the engine fails
 *   closed (deny everything) rather than failing open.
 */
export class AccessPolicy {
    private ready = false;

    constructor(private readonly source: PolicySource) {
        this.rebuild();
    }

    /** Recompiles after role or override mutations. Throws nothing; marks broken. */
    rebuild(): void {
        try {
            preparsePolicySet(PREPARSED_ID, { staticPolicies: this.buildPolicyRecord() });
            this.ready = true;
        } catch {
            this.ready = false;
        }
    }

    isAuthorized(request: AccessRequest): AccessDecision {
        if (!this.ready) return { allow: false, reasons: ['policy-unavailable'] };
        const resource = request.resource || DEFAULT_RESOURCE;
        try {
            const answer: any = statefulIsAuthorized({
                principal: { type: 'NalamUser', id: String(request.user.id) },
                action: { type: 'Action', id: request.action },
                resource: { type: resource.type, id: String(resource.id) },
                context: { ...(request.context || {}) },
                entities: [{
                    uid: { type: 'NalamUser', id: String(request.user.id) },
                    attrs: { role: request.user.role },
                    parents: []
                }],
                preparsedPolicySetId: PREPARSED_ID
            } as any);
            const decision = answer?.response?.decision === 'allow';
            const reasons = answer?.response?.diagnostics?.reason || [];
            return { allow: decision, reasons };
        } catch {
            return { allow: false, reasons: ['evaluation-error'] };
        }
    }

    /** Compiles roles + overrides to stable-id Cedar policies (also unit-tested). */
    buildPolicyRecord(): Record<string, string> {
        const policies: Record<string, string> = {};
        for (const role of this.source.getRoles()) {
            const methods = Array.isArray(role.permissions) ? role.permissions : [];
            for (const method of methods) {
                const name = String(method || '').trim();
                if (!name) continue;
                policies[`role-${role.name}-${name}`] =
                    `permit(principal is NalamUser, action == ${actionId(name)}, resource) ` +
                    `when { principal.role == "${role.name}" };`;
            }
        }
        for (const override of this.source.getAllOverrides()) {
            const action = String(override.action || '').trim();
            if (!action) continue;
            const effect = String(override.effect || '').toLowerCase() === 'forbid' ? 'forbid' : 'permit';
            policies[`user-${override.user_id}-${effect}-${action}`] =
                `${effect}(principal is NalamUser, action == ${actionId(action)}, resource) ` +
                `when { principal == NalamUser::"${override.user_id}" };`;
        }
        return policies;
    }
}
