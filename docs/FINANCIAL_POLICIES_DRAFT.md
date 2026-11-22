# AURUM Financial Operations Policies

**Status:** Internal Draft  
**Stage:** Stage 2 — Financial Ledger & Wallet  
**Approval:** Pending legal, regulatory, payment-provider and custody-partner review.

## 1. Fees

| Transaction | Platform Fee |
|---|---:|
| Wallet funding | 5% added to funding amount |
| Withdrawal | 5% deducted from gross withdrawal |
| Tips | 0% |
| Completed Work | 2% |
| Challenge settlement | 2% |
| Duel settlement | 2% |
| Crew Battle settlement | 2% |
| Escrow funding | 0% |
| Escrow release/movement | 0% |
| Refunds | 0% |
| Failed transactions | 0% |

Fees must only be recorded when the applicable transaction reaches its defined successful settlement state.

## 2. Wallet and Currency

- Wallet balances are maintained independently for each currency.
- Currency balances must never be artificially converted into USD.
- USD may be used for estimated portfolio-value display only.
- Currency availability does not automatically mean payment-provider support.
- Funding and withdrawals are restricted to currencies supported by the configured payment provider and settlement arrangements.
- Currency conversion requires a real supported conversion route, an applicable rate, a quote expiry and balanced ledger entries.

## 3. Funding

- Funding requests must use idempotency protection.
- The applicable platform funding fee is disclosed before payment.
- Provider confirmation must be verified before funds are credited.
- Pending or uncertain provider transactions must not be credited twice.
- Unresolved provider results must enter reconciliation.

## 4. Withdrawals

- Withdrawals require sufficient available balance.
- Withdrawal funds must be reserved before processing.
- The 5% platform withdrawal fee is deducted from the gross withdrawal.
- Provider charges may apply separately where disclosed.
- Failed withdrawals must restore the full reserved gross amount.
- Successful withdrawals must be settled through the financial ledger.
- Bank account details must be protected and masked in user-facing interfaces.

## 5. Tips

- Tips carry no AURUM platform fee.
- Tips are transferred through the internal financial ledger.
- Tips cannot bypass balance validation, authorization or transaction controls.

## 6. Work, Challenges, Duels and Crew Battles

- Financial settlement occurs only after the applicable completion or outcome conditions are satisfied.
- The platform fee is 2% of the approved fee basis.
- The recipient receives the remaining settlement amount.
- Escrow movements are not themselves fee-bearing events.
- Failed, cancelled, refunded or unresolved operations must not generate settlement fees.
- Duplicate settlement must be prevented through idempotency and financial-operation records.

## 7. Refunds

- Refund eligibility depends on the applicable transaction rules and outcome.
- Refunds must be processed through ledger-backed operations.
- Refunds must not create unauthorized negative balances.
- Refunds must not generate platform settlement fees.
- Completed and settled transactions cannot be silently altered; corrections require traceable reversal or adjustment entries.

## 8. Disputes

- Users must have an accessible method to report financial disputes.
- Relevant transaction records and evidence must be preserved.
- Disputes may require temporary restrictions on affected funds or outgoing transactions.
- Decisions must be recorded with authorized actors and an audit trail.
- Reversals and refunds must use approved financial operations.
- Appeals and dispute timeframes must be defined before public launch.

## 9. Account Restrictions

Authorized administrators may impose financial restrictions when required for security, suspected fraud, unresolved disputes, compliance obligations or operational incidents.

Restrictions must:
- Be permission-controlled.
- Be recorded in an audit trail.
- Clearly identify the reason and applicable scope.
- Prevent unauthorized outgoing financial operations.
- Preserve transaction history and appropriate user access.
- Be reviewed and released only by authorized personnel.

Restrictions must not permit unauthorized confiscation of user funds.

## 10. Reconciliation

- Provider transactions must be reconciled against internal payment records and ledger entries.
- Ledger entries must remain immutable.
- Missing settlements, duplicate settlements, incorrect amounts and currency mismatches must be investigated.
- Critical reconciliation failures must block unsafe further settlement where appropriate.
- Reconciliation results and corrective actions must be auditable.

## 11. Security and Privacy

- Bank account details must be encrypted at rest.
- Encryption keys must be stored outside source code and rotated under an approved procedure.
- Access to sensitive financial information must be restricted.
- User-facing account details must be masked.
- Financial data must not be exposed through unnecessary logs.
- Security incidents involving financial data must follow the incident-response process.

## 12. Custody and Regulatory Responsibilities

AURUM must not represent itself as a licensed financial institution, independent custodian or regulated escrow provider unless the applicable permissions have been obtained.

Where required:
- Licensed payment providers and custody partners must be used.
- Funds custody and settlement responsibilities must be contractually defined.
- Applicable jurisdictional requirements must be reviewed.
- Financial operations must not launch until necessary approvals and arrangements are confirmed.

## 13. Operational Incidents

Financial incidents must be documented, investigated and escalated according to severity.

Examples include:
- Incorrect balance calculations.
- Duplicate payment or settlement.
- Unauthorized withdrawal.
- Provider reconciliation failure.
- Ledger imbalance.
- Suspected account compromise.
- Exposure of sensitive bank details.

Incident records must include the issue, affected transactions, actions taken, responsible personnel and resolution.

---

**This document is an internal draft and is not a substitute for legally approved user terms, financial regulations, payment-provider agreements or custody arrangements.**
