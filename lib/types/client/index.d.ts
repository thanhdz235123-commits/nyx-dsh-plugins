/**
 * Client half of `dsh-file-panel`, loaded by the harness module loader
 * (`window.__ModuleLoader__.load`, id `dsh-file-panel`).
 *
 * Wraps the workspace-path opener, decorates the transcript with path links,
 * and renders the right-hand panel: preview, changes, review, files, edit.
 */

/** Plugin id, matching the host half. */
export declare const name?: string

/** Cordis services this half injects. */
export declare const inject: string[]

/** Install the panel seat and the path-clicker. */
export declare function apply(ctx: unknown): void
