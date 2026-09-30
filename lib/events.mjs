// Hook events cc-ctl registers for. Verified 2026-09-30 against https://code.claude.com/docs/en/hooks
// which lists 33 events. We register the ones that carry liveness/status signal.
//
// NOTE: there is no explicit "pause" hook. A session waiting on a permission prompt is only
// visible via PermissionRequest / Notification, then silence; status must therefore be derived
// from the last COMPLETED activity (PostToolUse / transcript), not from the last hook.
//
// Not registered (noise or no liveness value): Setup, UserPromptExpansion, PermissionDenied,
// PostToolBatch, MessageDisplay, TaskCreated, TaskCompleted, TeammateIdle, InstructionsLoaded,
// ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove,
// PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult.

export const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Notification',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure',
  'PreCompact', 'PostCompact', 'SessionEnd',
];
