# Project TODO

- [x] Preserve the existing website layout, authentication, and current earning experience.
- [x] Add an admin-only video management interface for YouTube and TikTok links.
- [x] Add private admin-only six-digit verification-code storage and editing.
- [x] Add admin-configurable reward amount for each video.
- [x] Open each configured external video in the correct YouTube or TikTok destination when a user clicks it.
- [x] Add user code-entry verification after watching a video.
- [x] Validate the submitted code securely on the server without exposing the answer to users.
- [x] Allow reward claims only after successful code verification.
- [x] Enforce one successful claim per video per user per configured platform calendar day.
- [x] Add clear loading, validation, success, duplicate-claim, and error states.
- [x] Add database schema, query helpers, protected/admin procedures, and tests for the new flow.
- [x] Run type checking, unit tests, and visual verification before delivery.
- [x] Save a checkpoint with all completed items marked complete.

## Change history

- [x] User requested replacing the current 10-second ad flow with admin-managed external video links, hidden six-digit codes, configurable rewards, and daily per-video claim limits.
- [x] Preserve the existing ten-second watch duration as the default for newly created external videos and align the admin form and database default.
- [x] Clarify the daily claim rule as one successful claim per video per configured platform calendar day.
- [x] Add explicit loading and error UI for member and admin video queries.
