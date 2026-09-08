# Evidence and access

Updated 2026-09-08 during live execution.

## Confirmed

- The user identifies https://trysirus.com as the landing page. Its live browser page now describes terminal Sirus, with install instructions and links to the correct GitHub repository and npm package. The earlier business-automation mismatch is resolved.
- GitHub account p-2411 already has repository access. No new GitHub credential needed.
- Onboarding PR #3 is MERGED, at 2026-09-05T12:56:43Z: https://github.com/p-2411/sirus-harness/pull/3.
- The guide is live: https://github.com/p-2411/sirus-harness/blob/main/docs/first-session.md. The feedback form is included on main.
- The feedback YAML parses; IDs are unique; the reviewed diff passes whitespace checks; launcher help succeeds. No application runtime code was changed.
- Reddit is signed in as u/BigP29. The user authorizes X and Reddit distribution and explicitly excludes LinkedIn and official provider communities. Apply that exclusion to all Claude/GPT/OpenAI/Anthropic-focused communities.
- r/SideProject explicitly describes project sharing and constructive feedback as its purpose. Use one relevant post, with affiliation disclosed.

## Access needed

| Access | Purpose | Status |
| --- | --- | --- |
| X browser sign-in | Publish founder launch post | Resolved: user completed sign-in and corrected the account. Verified @parhamsepas; first X post published. Earlier Google-origin approval block was handled by user sign-in, not bypassed. |
| Reddit | Independent-community launch | Existing session available; no credential needed |
| Sirus Gmail | Read relevant discovery invitations | Resolved: user authorized switching to the Sirus mailbox; two relevant invitations verified through Chrome. Gmail connector tools remain unavailable in this task. |
| PeerPush | Submit the free discovery listing | Resolved: email-code sign-in completed and Sirus confirmed at queue position #2,519. No password/API key needed. |
| Viberank | Create account and submit listing | Google sign-in completed after explicit user approval. Form prepared; required logo upload blocked by Chrome's “Not allowed” response. Enable “Allow access to file URLs” in the ChatGPT extension to finish. No password or API key needed. |
| GitHub | Guide, feedback and project discovery | Already authenticated; onboarding published |
| Provider login in Sirus | Record an actual Claude/GPT workflow | Optional next proof asset; login privately through /login |
| Landing-page analytics viewer | Measure site visits and install interest by source | Asked which service tracks trysirus.com and requested normal browser sign-in; answer/access pending. Existing local PostHog integration is not proof of ingestion. |

Do not request passwords or raw tokens in chat. No ad account, payment card, npm publishing token, email service, LinkedIn access or new hosting credential is needed for this first wave. Site deployment work is unnecessary for the verified current page.

## Claim limits

Do not promise unlimited/free provider usage, guaranteed bug detection, unverified speed/cost savings, skills migration, isolated worktrees, or that model requests never leave the machine. Existing landing-page demos are labelled examples; do not present them as measured live results. No acquired users have been verified by this campaign yet.

One invitee expressed interest and received onboarding; an attempt remains unobserved. Repeated `/login` adds saved accounts; `/usage` shows configured sources. `/model` selects a model/provider, not a particular saved account. Routing and fallback between configured sources are automatic. If API keys are configured, API fallback can incur provider charges. Do not promise pooled quota, combined billing, imported past web/T3 chats or a native CLI account switcher. See [account walkthrough](account-walkthrough.md) for code evidence and setup details.
