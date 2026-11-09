// Where the Ops Web sends a caller who lands on "/".
//
// The shared access model (which surfaces a caller may enter) lives in
// @opsweave/platform-client; the paths of THIS application do not, because they
// are this application's to change. Keeping them here is what lets the console
// and the ops app evolve their route trees independently (ADR-022).
import { lastSurface, surfaceEntryPath, useRememberSurface } from '@opsweave/platform-client/surface';

export { lastSurface, useRememberSurface };

export function workspaceEntryPath(): string {
  return surfaceEntryPath('workspace');
}
