// The shared client surface. An application imports the HTTP client, the contract
// types and the i18n runtime from here; it never reaches into a deep path, so a
// file can move without rippling through every consumer.
//
// Deliberately absent: any Incident, Evidence or Investigation type. Those are
// the Ops Application's domain (ADR-022), and a console that could import them
// would be the first step towards the boundary meaning nothing.
export { ApiError, api, newIdempotencyKey, setCsrfToken } from './api';
export * from './contracts';
export * from './audit-scope';
