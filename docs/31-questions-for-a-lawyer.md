# Questions for a lawyer (and an insurance broker)

> **The one list.** Created 2026-11-23: the questions were scattered across docs/18, docs/21, docs/30 and the module-9
> spec, and no single list existed. This file gathers them and is where every new one goes. **These are QUESTIONS, not
> advice and not decisions.** Before the first real client signs, take this file to a lawyer; tick or strike an item with
> the date and the answer.
>
> Rule: when a session writes "a lawyer should confirm…" anywhere, add the question here in the same change and leave a
> pointer at the original place.
>
> **This repo is public, so the file holds question STEMS, not admissions of current practice.** The specifics a lawyer or
> insurer needs (which controls are open, exactly what is retained, who can read what) are in the cited docs and the
> founder's private briefing file (kept outside this repo, in his personal folder, written 2026-11-25); bring it to the meeting. Reviewed by adversarial agents 2026-11-24 (sources checked; wording
> trimmed; section D added).

## A. Gathered from the existing docs (source in brackets)

| # | Question | Source |
|---|---|---|
| A1 | Is the public `/privacy` page + Terms sufficient as a first-client version? The wording is a founder-edited draft (the page carries a "still being finalized" banner). | docs/18 item 3; `apps/web/app/privacy/page.tsx` |
| A2 | Data kept after an account is deleted for abuse prevention: what must a policy disclose about it? (The founder chose not to publish one sentence about it; the permanent staff-access record is stated.) | docs/21 §7.12 "Disclosure" row; docs/privacy-detailed-draft.md |
| A3 | Photo/image uploads: TAKE IT DOWN Act removal route (48 h, public, run by the superadmin), CSAM reporting + 1-year preservation, a registered DMCA agent, and a content licence + warranties in the Terms. Image uploads exist in some modules today: which of these duties apply now? | module-9 spec §B1–B4, B6 |
| A4 | Under-13s: the Terms say 13+ with an age tick-box. Is that enough, or is verifiable parental consent needed (family orgs will have children)? | module-9 spec §B3; docs/30 §7.1 |
| A5 | GDPR/UK GDPR: with any EU/UK user, what do we owe — a processor agreement with each org, an erasure/objection route for a person who appears in someone else's photo, a transfer mechanism? Does Recital 18 keep us in scope for a household/family org? | module-9 spec §B5 |
| A6 | Special-category data: religion is inferable (synagogue module, Jewish matchmaking, dating context); free-text photo tags can reveal religion or health. What extra duties attach (GDPR Art. 9, state laws)? | docs/30 §7.1; module-9 spec §B5 |
| A7 | FERPA: if a US university is the first client, what must the contract say (we would be a "school official")? Is the classroom module's handling of grades and peer-review comments compliant by design? | docs/30 §7.1–7.2 |
| A8 | Employee/user monitoring: we record sign-ins and per-org activity (engagement monitoring) and the privacy page says so in one plain sentence. Is that enough for a client whose users are employees or students? | docs/17 §9; docs/30 §7.1 |
| A9 | Records an organization keeps about its own customers (e.g. salon customer cards): the platform treats the org as the controller and promises nothing on the org's behalf. Confirm that framing, and what a processor agreement with each org must contain. | docs/21 §7.10 (salon decision, ~lines 591–611) |
| A10 | Breach duties: US state notification laws (all 50) and what "reasonable security" (NY SHIELD) expects of us; what an incident plan must contain. | docs/30 §7.2 item 1 |
| A11 | Liability limits for safety-related features (speed dating, matchmaking): how do the Terms limit liability, and is a "no warranty" clause enforceable for this? | docs/30 §7.2 item 4 |
| A12 | Terms of Service text is a first pass that has not been founder- or lawyer-reviewed: what must change before it binds a client? | docs/12 item 6 (2026-09-23 correction); docs/18 item 3 |
| A13 | Retention figures: what may the policy state while automated retention is being rolled out? | docs/18 item 4 ("Worker on a real host"); docs/17 |
| A14 | Pending-invite email addresses (a person with no account): the privacy page states a 30-day keep and that copies may remain in backups. Is holding an address for someone who never joined defensible, and is the wording enough? | docs/25 §11.5; privacy page |

## B. Raised in the 2026-11 planning discussion (AI module, staff access, dev copies) — QUESTIONS ONLY

Nothing here is decided. They came from planning a future AI "Career Resume Builder" module and from the founder's position
that the superadmin needs real access to client work data to build and debug. Recorded here so they are not lost.

| # | Question | Context |
|---|---|---|
| B1 | **Staff access to client operational data as a stated condition of the engagement.** Is a client-contract clause (a wall between clients; use only to build/debug/support, never sold or used to train AI; a record where it touches a named person's account; named people only; exit terms) the right shape? Who is controller and who processor? | founder position 2026-11-23 |
| B2 | **Use of AI vendors in support and development workflows.** What disclosure and contract term does that need, and does the vendor's retention setting change the answer? | planning discussion |
| ~~B3~~ | ~~A "no development access" tier for regulated clients.~~ **Struck 2026-11-24: the founder rejected it ("to not have access prevents development … not a possibility, ever").** Consequence for the lawyer: every client contract must state development access (B1). | founder 2026-11-24 |
| B4 | **Non-production copies of client data for debugging.** Does a scrubbed copy need its own disclosure, retention promise or deletion-on-exit term? What does "scrubbed" have to mean to count? | prod-to-dev copy planning |
| B5 | **Personal-disclosure features** (e.g. dating notes, a future resume "vault"): proposed wording "Only you can see it. Access may be available for safety or support, only when needed, and a record of such activity is kept." Is it accurate given that staff access exists for support and safety? Must it change if product-improvement access or AI processing is ever in scope? | planning discussion |
| B6 | **Consent design:** per-purpose checkboxes (support/safety required; AI processing required for AI features; "improve the platform" optional; statistics optional; outreach optional), opt-in vs opt-out defaults. Is opt-in-by-default valid consent in the EU, and for which purposes is consent even the right legal basis? | planning discussion; docs/00 principle 8 |
| B7 | **Module-scoped disclosures:** a general public statement plus module-specific text shown only to people who hold that module, with the wording version each person saw recorded. Is a general statement specific enough, and does a person who has left a module still need its section while we hold their data? | planning discussion |
| B8 | **AI vendor terms for a real client:** use a plan with stated no-training and (ideally) zero-retention terms; read the vendor's commercial retention article before any client data goes through it. | planning discussion |
| B9 | **Resumes and truthfulness:** an AI that drafts resume lines from a person's own facts — any liability or advertising/consumer-law issue if a user submits a misleading line the tool helped write? | planning discussion |
| B10 | **Disclosure and notification for administrative view-as sessions** (the superadmin sees a person's actual screens, read-only; widening to every module decided 2026-11-23). What must a person be told, and is it different for sensitive modules (dating) or minors? | docs/13 "AS BUILT"; docs/15 §8.1 point 12 |

| B11 | **Dev-copy tensions found by review (2026-11-25):** (a) deletion on a client's exit cannot reach saved scrubbed files or a developer's working copy; (b) B1's "a record where staff touch a named person's account" vs the founder's "no log for dev copies"; (c) AI sessions read scrubbed copies (B2/B8). What must a client contract promise, and what must it not? | docs/32 §10 |

## C. For the insurance broker (not a lawyer question)

See docs/30 §7.3–7.5: cyber (first and third party) + technology E&O from the first paying client; media liability once
photos ship; ask whether "sensitive personal data" (religion, dating) changes the rate; ask for a FERPA-aware carrier if a
university is first. **Insurer control questionnaires** (multi-factor authentication on source control and cloud accounts,
encryption of backups and portable media, incident plan) will be answered from the current security review
(docs/30, docs/12, docs/28) before binding. Remediate any gap before applying; the specifics stay in those docs and the
founder's private notes, not here.

## D. Added after the 2026-11-24 adversarial review (a lawyer would expect these; not yet in other docs)

Only the ones that plausibly apply to the modules we have or plan. One question each.

| # | Question |
|---|---|
| D1 | **State consumer privacy laws** (CCPA/CPRA, Virginia, Colorado, Texas…): are we a "business" or a "processor", and what access/delete/opt-out route do we owe beyond account deletion (A2)? |
| D2 | **Biometrics** (Illinois BIPA, Texas, Washington): if photos, video or tagging ever processes face geometry, what consent, retention schedule and private right of action apply? If we never do, how do we say so? |
| D3 | **Video calls** (speed dating): do we record, transcribe or retain anything? If not, how is that stated? If ever, what do all-party-consent states require? |
| D4 | **Dating-specific laws:** state online-dating safety statutes (safety notices, background-check disclosures) and FTC rules on fake profiles and auto-renewal if we ever charge. |
| D5 | **Age-verification laws** (state social-media and app-store age laws) beyond COPPA (A4), where minors can match or message each other. |
| D6 | **Subprocessors and DPAs:** do we need a data processing agreement with each vendor we use (database/host, video, email, AI, backup storage)? Do we publish a subprocessor list and give clients notice of changes? Data residency and EU/UK/Canada transfers (SCCs) — can a client require a region? |
| D7 | **Cookies and analytics:** is a consent banner needed (ePrivacy, California "sale/share" rules, error-monitoring and analytics tools, Global Privacy Control)? |
| D8 | **IP ownership:** who owns module code built for one client, what licence do other tenants get, and what is the position on reusing extracted shared primitives? |
| D9 | **Client contract terms:** uptime/SLA and support promises, exit and data return, indemnities, and order of precedence between Terms, a master services agreement and a DPA. |
| D10 | **Staffing:** contractor/employee agreements covering IP assignment, confidentiality and access to production data (ties to B1). |
| D11 | **User-generated content:** Section 230 position, a repeat-infringer policy, and moderation duties for harassment between users. |
| D12 | **Corporate and employment:** entity form, and whether the founder's other employment could give anyone a claim on the platform (invention-assignment or moonlighting clauses). |
| D13 | **If charging:** payment-card scope (use a hosted processor?), sales tax on SaaS, refund law. |
| D14 | **Accessibility:** ADA/WCAG exposure, especially for a university client (Section 508 / VPAT requests). |
| D15 | **Email:** CAN-SPAM, and whether invite emails count as commercial messages. |

## Maintenance

- New question → add a row here, with its source, and leave a one-line pointer where it came up.
- Answered → strike through, date it, write the answer and who gave it.
- Keep rows as question stems: put admissions of current practice in the source doc, not in this public list.
- Do not paste legal advice or contract text from outside into this public repo; record the conclusion and where the
  original is kept.
