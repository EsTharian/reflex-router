// The delegation hint (REFLEX_DELEGATE=1), in one place. Its version id is logged on every decision record of a session
// that runs with it, so reports can split measurements by hint text. Change the text => bump the version; never tune it
// against synthetic data (only real sessions show whether it pays).

export const HINT_VERSION = "delegate-1";

/** Returned as UserPromptSubmit `additionalContext`, on user-typed main-chat prompts only. */
export const HINT_TEXT = [
  "reflex delegation hint (the user enabled it with REFLEX_DELEGATE=1):",
  "- Hand exploration, reading across several files, broad searches and test runs to subagents (the Agent tool), and ask each for a short summary of what it found.",
  "- Keep this conversation for synthesis, decisions and edits; do single-file lookups and one-line checks directly.",
].join("\n");
