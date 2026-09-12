/**
 * Client half of `nyx-message-edit`, loaded by the harness module loader
 * (`window.__ModuleLoader__.load`, id `nyx-message-edit`).
 *
 * Adds a pencil to every editable user message and an inline editor that posts
 * to `/api/nyx-message-edit.edit`.
 */

/** Plugin id, matching the host half. */
export declare const name?: string

/** Cordis services the client half injects (distinct from the package-level
 *  `dsh.client.inject`, which orders module bundles). */
export declare const inject: string[]

/** Decorate the transcript and start polling the host's conversation state. */
export declare function apply(ctx: unknown): void
