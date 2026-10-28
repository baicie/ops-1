/** PROPOSED ONLY. Do not import into production without reviewing existing Auth/Manifest contracts. */
export type Surface = 'admin' | 'workspace';

/** A Business Workspace is a business-domain context, never the Admin Console. */
export interface BusinessWorkspaceRef {
  id: string;
  displayName: string;
}

/** Server-issued, user-specific effective authorization: not a browser assertion. */
export interface EffectiveAccess {
  userId: string;
  allowedSurfaces: Surface[];
  capabilities: string[];
  businessWorkspaces: BusinessWorkspaceRef[];
}

export interface HostNavigationItem {
  id: string;
  surface: Surface;
  to: string;
  titleKey: string;
  icon?: string;
  requiredCapability?: string;
}

export interface PluginContributionV2 {
  kind: 'navigation.item.v2' | 'route.page.v2';
  id: string;
  surface: Surface;
  path: string; // under /admin/ext/<pluginId>/* or /app/ext/<pluginId>/*
  requiredCapabilities: string[];
}

/** This is a desired shape, NOT the current /api/v1/auth/me payload. */
export interface AuthMeV2Proposal {
  user: { id: string; role: 'viewer' | 'operator' | 'admin'; displayName: string };
  csrfToken: string;
  access?: EffectiveAccess;
}
