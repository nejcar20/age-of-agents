# Project trade routes

Connect a local reference project to an agent working in a destination project. The user chooses the two projects, a current agent, and an integration brief; reviews the complete editable prompt; then explicitly sends it through the existing `send_prompt` command with `expectedRoot`.

The first version supports inspect-and-propose (default) and implement-the-brief. Both treat the reference repository as read-only. Access remains subject to the receiving agent's permissions. A route records a successfully submitted brief, not completed integration or live synchronization. No filesystem copies, automatic sends, retries, or background agent coordination.

Routes are saved in local application storage and shown in a dedicated workspace view. Source/destination paths, original receiving agent, brief, complete submitted prompt, and submission time remain inspectable. Removing a record only removes that connection from this UI. Known root, working-directory, pane, or agent-kind mismatches disable opening the receiver. The backend cannot distinguish a same-kind replacement session in the same pane; saved routes never automatically send again.

Entry points: workspace navigation, the terminal toolbar (preselect receiving agent), and an island panel (preselect reference project). The world draws a subtle directional connection only for routes whose two projects are currently discoverable. Browser previews keep all real sends disabled.

Validate prompt targeting, stale targets, duplicate submission prevention, failure preservation, local persistence failures, dialog keyboard ownership, and route endpoints. Check creation/preview and world connections in the browser without sending to a live agent.
