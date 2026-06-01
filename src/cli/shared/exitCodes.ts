// Named exit codes used by the CLI. Behavior must match the previous inline
// `process.exit(...)` literals exactly — these constants are documentation,
// not policy changes.
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
// Used for "not running" and "not logged in" — terminal states where the
// command completed successfully but the asked-about resource is absent.
export const EXIT_NOT_RUNNING = 2;
export const EXIT_NOT_LOGGED_IN = 2;
