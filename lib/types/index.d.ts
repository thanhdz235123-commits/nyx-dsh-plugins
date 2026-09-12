/**
 * Host half of `dsh-message-edit`.
 *
 * Real edit-message for DeepSeek Harness, built on the Session's own surface
 * mechanism: the edited message replaces the original in place, every surface
 * node after it is shadowed, and one turn is regenerated from that exact point.
 */

/** Plugin id, as the loader and the profile's patch file name it. */
export declare const name: string

/** Build marker, reported by `GET /api/dsh-message-edit.health`. */
export declare const BUILD: string

/** Services this half needs before {@link apply} runs. */
export declare const inject: string[]

/** Install the edit routes and the regenerating-step hook. */
export declare function apply(ctx: unknown): void
