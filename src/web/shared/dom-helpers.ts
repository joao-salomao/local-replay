/**
 * Tiny DOM helpers shared by the page scripts (camera/control/clips/login), so the one-liners every
 * page needs live in one place instead of being copy-pasted into each entry point.
 */

/**
 * `document.getElementById` with a caller-chosen element type (defaulting to `HTMLElement`). Each
 * page owns its own markup, so the `as T` cast trades a runtime null-check we'd never meaningfully
 * act on for terse, well-typed access: a missing id is a programmer error that surfaces immediately
 * as a null-deref at the first use, and typing the result as possibly-null would just force a
 * non-null assertion at every single call site.
 */
export const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
