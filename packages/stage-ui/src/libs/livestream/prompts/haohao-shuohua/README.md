# Writing skill snapshot

This directory copies the user's Codex `haohao-shuohua` skill from October 17, 2026.
`skill.md` preserves the original skill body. `references/` preserves its bundled reference files.

The livestream planner imports `skill.md` as raw text in every system prompt.
The reference files support maintenance. The runtime does not read them separately or execute their commands.
The adjacent `workflow.md` defines the scope for live conversation, original fiction, and the required JSON response.
The runtime has no dependency on a local Codex installation.
