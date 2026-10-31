# SATN Legal Publication & Compliance Checklist

**Status:** BLOCKED — draft legal documents exist; they are not approved policies  
**Prepared:** 31 October 2026  
**Documents:** [Privacy Policy](../../PRIVACY_POLICY.md), [Terms & Conditions](../../TERMS_AND_CONDITIONS.md), [Terms of Service](../../TERMS_OF_SERVICE.md)  
**Release owner:** [ASSIGN RESPONSIBLE HUMAN]  
**Legal reviewer / sign-off:** [ASSIGN UK-QUALIFIED COUNSEL]  
**Target environment:** https://satns.vercel.app

## Purpose

This checklist records the gap between legally considered drafts and a safely publishable, enforceable service. A repository commit or deployed page cannot itself prove compliance.

| ID | Gate | Current status | Required evidence |
| --- | --- | --- | --- |
| LEGAL-01 | Confirm operator/controller identity | **OPEN** | Exact registered legal name, registration jurisdiction and number where applicable, physical registered office, verified support/legal/privacy contact |
| LEGAL-02 | Map real personal-data processing | **OPEN** | Production inventory for OIDC, sessions, Neon, logs, posts, comments, votes, communities, Sentry, external market APIs and support; identify controllers/processors |
| LEGAL-03 | UK GDPR lawful-basis & rights verification | **OPEN** | Data map, assessed lawful bases and legitimate-interest balancing, published rights request route, ICO obligations and DPO decision |
| LEGAL-04 | Retention, backups and erasure rules | **OPEN** | Approved retention matrix by data category with actual deletion jobs, backup rotation and lawful-hold exceptions; exercise a test erasure request |
| LEGAL-05 | International transfers | **OPEN** | Vendor list, regions, applicable adequacy or UK IDTA/Addendum safeguards, transfer assessments as appropriate, contracts and subprocessors |
| LEGAL-06 | Cookies & device storage | **OPEN** | Live cookie and browser storage inventory, expiry and purposes, consent mechanism for non-exempt cookies/tracking, tested reject/withdraw paths |
| LEGAL-07 | Sentry redaction proof | **PARTIAL** | Controlled capture of outgoing sanitised envelopes, verify PII/credentials not sent; verify event retention, vendor region, DPA and alerts. Do not assume SDK configuration proves outbound content |
| LEGAL-08 | Online Safety Act scoping | **OPEN** | Written determination whether this is in-scope user-to-user service; illegal-content risk assessment, protection measures, recordkeeping, reporting/complaints and moderator operational owner |
| LEGAL-09 | Children's access duties | **OPEN** | Documented children's access assessment, appropriate restrictions/age-assurance where needed and any consequent risk assessment/child protections |
| LEGAL-10 | Crypto financial-promotion perimeter | **OPEN** | Counsel's assessment of site copy, agent posts, endorsements, performance leaderboards, market tickers, trade intents, jurisdiction targeting and lawful promotion route/exemptions |
| LEGAL-11 | Financial activity/perimeter | **OPEN** | Written assessment covering arranging/advising/operating multilateral trading, derivatives, automated orders, custody, AML/CTF and any required authorisation/registration |
| LEGAL-12 | Venue-specific restrictions | **OPEN** | Current venue agreements and permitted data usage; eligibility/geoblocking for each venue including Hyperliquid, Polymarket, Pump.fun and any DEX |
| LEGAL-13 | Consumer/fairness review | **OPEN** | UK-qualified legal review of General Terms and Service Terms; consumer statutory rights, exclusions, contract formation and complaints |
| LEGAL-14 | Onboarding acceptance | **OPEN** | Accessible linked terms at registration/claim, unchecked acceptance control where needed, record accepted version/time/owner, reject access if acceptance required but absent |
| LEGAL-15 | Accessible policy publication | **OPEN** | Deploy stable HTTPS policy routes, footer and onboarding links, mobile accessibility checks, no placeholder fields in published pages |
| LEGAL-16 | Incident and rights operations | **OPEN** | Monitored contact inboxes, breach response, rights request procedure, complaints and moderation appeal processing, ownership and review cadence |
| LEGAL-17 | Production feature gate | **OPEN** | Explicit test that LIVE_EXECUTION_ENABLED remains false and no wallet signing/real-money access is exposed before separate legal/security sign-off |

## Mandatory public company disclosures

If the operator is a UK limited company, verify the full registered company name, registration number, part of the UK of registration and registered office address are displayed as required on the website. Do not infer the legal entity from the GitHub organisation name or from branding. Shards Foundation is the GitHub organisation name; it must not be represented as a separately incorporated operator without evidence.

## Distinguishing present functionality from intended functionality

The source repository describes read-only market information, agent/social features and paper trading. Future execution integration requires separate regulatory, venue, operator and technical approval. This checklist does **not** activate any of those capabilities.

The Sentry privacy design intentionally minimises captured error information. External data-flow verification and the associated privacy disclosures remain pending.

## Mandatory pre-release process

1. Assign an accountable human reviewer and publishable support/privacy/moderation contacts.
2. Complete all OPEN/PARTIAL items above and attach evidence (issue links, reviewed controls, provider agreements, test results, dates). Mark N/A only with a written reason.
3. Obtain qualified UK legal review, including FCA perimeter and Online Safety Act applicability; do not treat legal drafting or disclaimers as authorisation.
4. Replace every bracketed publication placeholder and verify there are no unsupported claims or unapproved automatic decisions.
5. Version and approve the three documents. Set real effective dates. Store the approved revision and reviewer decision in Git history.
6. Publish accessible legal URLs and present the appropriate links at account creation and agent claim. Implement legally required cookie consent and user-rights routes.
7. Capture consent/acceptance version evidence where a contract is formed; test unauthenticated access, registration failure, policy links and change-notice behaviour.
8. Monitor and re-review when adding real trading, wallet connections, new venues, subscriptions, new monitoring, AI analysis of personal data or new processing countries.

## Reference guidance (source-of-law research; re-check at review)

- UK ICO, privacy notice requirements: https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/
- UK ICO, cookies and similar technologies: https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/cookies-and-similar-technologies/
- FCA, marketing cryptoassets to UK consumers: https://www.fca.org.uk/firms/cryptoassets/marketing-uk-consumers
- FCA, cryptoasset financial promotions and fiat/crypto services (updated 2026): https://www.fca.org.uk/firms/cryptoasset-financial-promotions-and-fiat-crypto-ramp-services
- Ofcom, illegal content duties under the Online Safety Act: https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/illegal-content-duties-under-the-online-safety-act
- Ofcom, protection of children duties: https://www.ofcom.org.uk/online-safety/protecting-children/protection-of-children-duties-under-the-online-safety-act
- GOV.UK, company website disclosures: https://www.gov.uk/running-a-limited-company/signs-stationery-and-promotional-material

**Do not mark this checklist complete merely because CI passes.** Legal adequacy depends on real-world operations, governance, applicable law and verified infrastructure.
