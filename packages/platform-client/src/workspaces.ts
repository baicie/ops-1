// The caller's business workspaces.
//
// Both surfaces need this: the Ops application to file and read business rows,
// the Platform Console to select the workspace an operator is looking at. It is
// about MEMBERSHIP - a Core concept - so it lives here rather than in either
// application (ADR-022).
import React from 'react';
import { api } from './index';
import type { BusinessWorkspace } from './contracts';

/**
 * The caller's business workspaces, from `GET /api/v1/business-workspaces`.
 *
 * Three outcomes, and the create gate needs all three kept apart: rows arrived, the read was
 * refused or failed, or no read has answered yet. `loading` is not `empty` for the same reason
 * the incident list refuses to draw a failed read as "no incidents" - an unanswered read must
 * not become a permission decision.
 */
export function useBusinessWorkspaces(): {
  workspaces: BusinessWorkspace[] | null;
  failed: boolean;
  loading: boolean;
} {
  const [state, setState] = React.useState<{ workspaces: BusinessWorkspace[] | null; failed: boolean; loading: boolean }>({
    workspaces: null,
    failed: false,
    loading: true,
  });
  React.useEffect(() => {
    let cancelled = false;
    api.get<BusinessWorkspace[]>('/api/v1/business-workspaces')
      .then((rows) => { if (!cancelled) setState({ workspaces: rows, failed: false, loading: false }); })
      .catch(() => { if (!cancelled) setState({ workspaces: null, failed: true, loading: false }); });
    return () => { cancelled = true; };
  }, []);
  return state;
}
