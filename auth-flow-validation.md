# Member Access and Package Selection Validation

The corrected member authentication and membership-selection behavior was checked in the local project preview on August 13, 2026.

| Scenario | Tested route and action | Confirmed result |
| --- | --- | --- |
| Signed-out package selection | `/packages` → **Select Gold** | The visitor is sent to `/member-access?package=2`; the member sign-in screen confirms the selected membership will be ready after authentication. |
| Authenticated package selection | `/packages` → **Select Gold** while a valid session is present | The member is sent directly to `/dashboard/membership?package=2`. |
| Selected package handoff | `/dashboard/membership?package=2` | Gold is automatically selected and the payment-verification form remains available. |
| Default member sign-in destination | Member sign-in without a package | OAuth state now carries `/dashboard`, so the callback directs the member to the workspace instead of the public landing page. |

The callback accepts only same-origin relative application paths, preventing an OAuth return destination from becoming an external redirect.
