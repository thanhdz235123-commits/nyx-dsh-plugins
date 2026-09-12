/**
 * Host half of `dsh-file-panel`.
 *
 * Serves the panel's data plane over `/api/dsh-file-panel.*`: file content, the
 * workspace tree, the session's recorded changes, git and session diffs, the
 * session-log diff index (with a durable checkpoint), stat/write/revert, and the
 * exact-path resolver every file link goes through.
 */

/** Plugin id, as the loader and the profile's patch file name it. */
export declare const name: string

/** Build marker, reported by `GET /api/dsh-file-panel.health`. */
export declare const BUILD: string

/** Services this half needs before {@link apply} runs. */
export declare const inject: string[]

/** Register the panel's routes. */
export declare function apply(ctx: unknown): void
