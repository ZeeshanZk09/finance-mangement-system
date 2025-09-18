📦 Package Breakdown

1. Starter / Basic

For freelancers, small businesses, and startups who need core finance + invoicing.
Features:

[
"Invoicing",

"Customer_Management",

"Vendor_Management",

"Notifications_and_Reminders",

"Mobile_Access",

"Free_Trials",

"Money_Back_Guarantees",

"Payment_Tracking",

"Tax_Management",

"Expense_Tracking",

"Data_Import_and_Export",

"Community_Access"
]

👉 Business logic: Keep it light, easy entry point, low churn. Free trial + guarantees reduce friction.

2. Growth / Standard

For SMEs who want to manage inventory, projects, and deeper financial workflows.
Features:

[
"Inventory_Management",

'Purchase_Orders',

'User_Roles_and_Permissions',

"Multi_Currency_Support",

"Recurring_Invoices",

'Project_Management',

'Time_Tracking',

"Reporting_and_Analytics",

'Custom_Reports',

'Dashboards',

'Document_Storage',

'Multi_Language_Support',

'CRM_Integration',

'Integrations'
]
👉 Business logic: This tier adds stickiness with recurring invoices, reporting, and integrations. Multi-currency + CRM suits growing companies.

3. Professional / Advanced

For mid-size to large companies that need security, scalability, and workflow automation.
Features:

[
'Barcoding',

'Warehouse_Management',

'Shipping_Integration',

'E_Commerce_Integration',

'Budgeting',

'Forecasting',

'Role_Based_Access_Control',

'Single_Sign_On',

'Two_Factor_Authentication',

'Data_Encryption',

'Audit_Trails',

'Cloud_Backups',

'Custom_Branding',

'API_Access',

'Custom_Workflows',

'Approval_Processes',

'Compliance_Features'
]
👉 Business logic: Adds operational efficiency + security features → makes it enterprise-ready. This tier justifies premium pricing.

4. Enterprise / Premium

For corporates & enterprises with global operations, requiring guarantees, white-glove support, and SLAs.
Features:

[
'Advanced_Security_Features',

'Dedicated_Account_Manager',

'Service_Level_Agreements',

'Priority_Support',

'White_Labeling',

'Data_Migration_Support',

'Performance_Guarantees'

'Uptime_Guarantees'
]

👉 Business logic: This is the cash cow — not many clients, but each is worth 50x more. Sell peace of mind, not just software.

Super Admin / Platform Admin

What: Full-owner of the SaaS platform or multi-tenant operator.

Permissions: Global user/tenant management, billing, system config, emergency access, data export.

SoD risk: Can change logs or disable other admins → extremely high trust.

Tech controls: Restrict to few people, MFA, emergency access logging, time-limited break-glass, immutable audit trail for critical ops.

Tenant Admin / Company Admin

What: Admin for a tenant/org (creates users, sets org-level settings).

Permissions: Manage users/roles for their tenant, view billing, configure integrations.

SoD risk: Can assign themselves elevated roles — require policies.

Tech controls: Tenant-scoped RBAC, admin activity audit, approval for role escalation.

Chief Financial Officer (CFO) / Finance Director

What: Business owner for finance strategy & approvals.

Permissions: Access to all financial reports, high-value approvals, export P&L, budgeting tools.

SoD risk: Approval + reconciliation combined → consider oversight.

Tech controls: Require multi-approver for high-value transactions, read/write separation for sensitive ledgers.

Accounting Manager / Controller

What: Oversees accounting operations, closes books, reconciliations.

Permissions: Journal entries, reconciliations, posting period locks, generate GAAP/IFRS reports.

SoD risk: Posting and approving the same entries.

Tech controls: Enforce approvals for manual journal entries, keep trial balance history, immutable closing events.

Accountant / Bookkeeper

What: Day-to-day bookkeeping — journal entries, reconciliations, VAT/sales tax entries.

Permissions: Create/edit entries, but not final close or export to auditors without approval.

SoD risk: Should not approve own reconciliations for audits.

Tech controls: Field-level change history, required approver field, pre-defined templates.

Accounts Payable (AP) Clerk

What: Enter invoices, schedule supplier payments.

Permissions: Create bills, propose payments, attach receipts. Cannot execute high-value payments unapproved.

SoD risk: Creating and executing payment to related party.

Tech controls: Two-step payment flow (create → approve → execute), payment limits, vendor blacklists, audit trail of uploads.

Accounts Receivable (AR) / Billing Clerk

What: Generate invoices, record receipts, manage customer credits.

Permissions: Create/issue invoices, apply payments, issue refunds (but often refunds need approval).

SoD risk: Issuing false invoices for kickbacks.

Tech controls: Sequential invoice numbering, invoice templates, approval for voids/refunds, reconciliation logs.

Treasury / Cash Manager

What: Manage bank accounts, cash forecasting, fund transfers.

Permissions: Initiate/approve transfers (within limits), view bank reconciliations, manage pooled cash.

SoD risk: Initiating and approving same transfer.

Tech controls: Dual-approval for transfers above thresholds, bank API audit logs, transaction signing keys.

Payroll Manager

What: Payroll runs, tax withholdings, benefits deductions.

Permissions: Run payroll, upload payroll files to bank, view employee pay data.

SoD risk: Manipulating wages or adding ghost employees.

Tech controls: HR/Finance separation, approval for new employees/changes, PII encryption, payroll run immutable snapshots.

Procurement / Purchasing Officer

What: Raises POs, manages suppliers, negotiates contracts.

Permissions: Create requisitions, request POs, approve up to limit (often delegated).

SoD risk: Collusion with suppliers.

Tech controls: PO → GRN → invoice 3-way match, supplier validation, vendor onboarding workflows with checks.

Approver (Approval Workflow Role)

What: A role specific to approving POs, invoices, refunds, or high-value changes.

Permissions: Approve/reject items in queues within delegated limits.

SoD risk: Single approver for high-value items → mitigate with multi-approver.

Tech controls: Escalation rules, time-bound approvals, approval audit trail, enforce delegation rules.

Internal Auditor / Compliance Officer

What: Performs audits, reviews controls, ensures regulatory adherence.

Permissions: Read-most data across tenant (often read-only), access to audit logs, generate compliance reports.

SoD risk: Accessing sensitive PII → limit ability to export.

Tech controls: Read-only scopes, session-recording for sensitive views, fine-grained masking for PII, export approvals.

Finance / Data Analyst (Reporting)

What: Builds dashboards, KPIs (CAC, LTV, burn rate), forecasting models.

Permissions: Access to aggregated data, run reports, sometimes export. Not allowed to change ledgers.

SoD risk: Data export of sensitive info.

Tech controls: Row-level/column-level security, query quotas, audit of exported datasets.

Support / Customer Success Agent

What: Helps customers with billing issues, refunds, subscription changes.

Permissions: Limited read/write on subscriptions, create support escalation, issue limited refunds under scripts.

SoD risk: Issuing refunds or credits without approval.

Tech controls: Scoped impersonation (no password access), action approval for refunds beyond limits, activity logging.

External Auditor / Accountant (Read-only external)

What: Contractors/auditors who need access during audit windows.

Permissions: Time-limited read-only access to financial records and supporting documents.

SoD risk: Long-term access to sensitive data.

Tech controls: Time-limited tokens, IP restrictions, masked PII by default, access reviews.

Integration / Service Account (API role)

What: Non-human account used by integrations (bank sync, ERP connectors, billing service).

Permissions: Narrow API scopes (e.g., read transactions, write invoices) with no UI login.

SoD risk: Compromise equals automated fraud.

Tech controls: OAuth with scoped tokens, rotate keys, rate limits, restrict IP/callback URLs, fine-grained scopes, long-term token review.
