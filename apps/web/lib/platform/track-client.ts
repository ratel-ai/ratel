/**
 * The client-side analytics shim: upstream's `track` and `captureClientException` names over
 * nothing. The open-source edition sends no product analytics from the browser; a component
 * that reports an interaction or a caught error calls these and they return. The Cloud edition
 * provides its own implementation behind the same names.
 */

export type ClientEventName = string;
export type ClientEventProperties = Record<string, unknown>;

export function track(_event: ClientEventName, _properties?: ClientEventProperties): void {}

export function captureClientException(_error: unknown, _context?: Record<string, unknown>): void {}
