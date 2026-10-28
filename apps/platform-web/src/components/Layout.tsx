/**
 * Legacy entry point kept as a one-line re-export.
 *
 * G02 moved the platform-console chrome to `src/shells/admin/`. App.tsx still imports
 * `Layout`, and the dual-router that replaces that import is G04 work; re-exporting keeps
 * the route tree untouched while there is exactly one implementation of the shell.
 */
export { AdminShell as Layout } from '../shells/admin/AdminShell';
