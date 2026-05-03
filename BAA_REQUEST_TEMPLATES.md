# BUSINESS ASSOCIATE AGREEMENT (BAA) REQUEST TEMPLATE

Use these templates to request Business Associate Agreements from vendors who will handle PHI.

---

## TEMPLATE 1: GOOGLE CLOUD (FIREBASE)

**To:** Google Cloud Support  
**Subject:** Business Associate Agreement Request - CareConnex

---

Dear Google Cloud Support,

I am writing to request a Business Associate Agreement (BAA) for our organization.

**Organization Information:**
- Company Name: CareConnex Inc.
- Google Cloud Project ID: [YOUR_FIREBASE_PROJECT_ID]
- Billing Account ID: [YOUR_BILLING_ID]
- Primary Contact: [YOUR_NAME]
- Email: [YOUR_EMAIL]
- Phone: [YOUR_PHONE]

**Services Used:**
- Firebase (Authentication, Firestore, Cloud Functions, Hosting)
- Google Cloud Platform services

**Purpose:**
We operate a healthcare platform that matches seniors with in-home caregivers. We collect, use, and maintain Protected Health Information (PHI) as defined by HIPAA. We need a BAA to ensure compliance with HIPAA requirements for our use of Google Cloud services.

**Request:**
Please provide us with a signed Business Associate Agreement covering our use of Google Cloud services for the storage and processing of PHI.

**Timeline:**
We are preparing for launch and need the BAA executed within 2 weeks.

Please contact me at [YOUR_EMAIL] or [YOUR_PHONE] if you need any additional information.

Thank you for your prompt attention to this matter.

Sincerely,

[YOUR_NAME]  
[YOUR_TITLE]  
CareConnex Inc.

---

## TEMPLATE 2: TWILIO

**To:** Twilio Sales/Support  
**Subject:** HIPAA Business Associate Agreement Request - CareConnex

---

Dear Twilio Team,

We are implementing SMS and voice communication services through Twilio for our healthcare platform and require a Business Associate Agreement (BAA) to ensure HIPAA compliance.

**Organization Information:**
- Company Name: CareConnex Inc.
- Twilio Account SID: [YOUR_ACCOUNT_SID]
- Primary Contact: [YOUR_NAME]
- Email: [YOUR_EMAIL]
- Phone: [YOUR_PHONE]

**Services Used:**
- Twilio Programmable SMS
- Twilio Programmable Voice
- Twilio Verify (for authentication)

**Use Case:**
We use Twilio to:
- Send appointment reminders to clients
- Facilitate communication between clients and caregivers
- Send verification codes for account security
- Notify caregivers of new booking requests

**Data Involved:**
Messages may contain PHI including:
- Client names and appointment times
- Care instructions
- General health status updates

**Request:**
We need a signed BAA covering our use of Twilio services for HIPAA-compliant communication. We also need confirmation that Twilio services can be configured to meet HIPAA requirements (encryption, access controls, audit logging).

**Timeline:**
Please provide the BAA within 10 business days as we are preparing for platform launch.

Please let me know if you need any additional documentation or have questions about our implementation.

Best regards,

[YOUR_NAME]  
[YOUR_TITLE]  
CareConnex Inc.

---

## TEMPLATE 3: STRIPE

**To:** Stripe Support  
**Subject:** Business Associate Agreement Request - CareConnex Healthcare Platform

---

Dear Stripe Support,

We are integrating Stripe for payment processing on our healthcare platform and require a Business Associate Agreement (BAA) for HIPAA compliance.

**Organization Information:**
- Company Name: CareConnex Inc.
- Stripe Account Email: [YOUR_STRIPE_EMAIL]
- Website: www.careconnex.com
- Primary Contact: [YOUR_NAME]
- Email: [YOUR_EMAIL]

**Services Used:**
- Stripe Payments
- Stripe Connect (for caregiver payments)
- Stripe Billing (for recurring payments)

**Use Case:**
Our platform connects seniors with caregivers. We process:
- Client payments for care services
- Caregiver payouts through Stripe Connect
- Subscription billing for premium features

**Data Involved:**
Payment records may be linked to PHI through:
- Client names and care service descriptions
- Payment dates correlating with care appointments
- Caregiver payment history

**Request:**
Please provide:
1. A signed Business Associate Agreement
2. Documentation on Stripe's HIPAA compliance
3. Configuration guidance for HIPAA-compliant payment processing

**Timeline:**
We need the BAA executed within 2 weeks as we approach launch.

Please contact me if you need any additional information about our use case.

Thank you,

[YOUR_NAME]  
[YOUR_TITLE]  
CareConnex Inc.

---

## TEMPLATE 4: SENDGRID / EMAIL SERVICE

**To:** [Email Provider] Support  
**Subject:** HIPAA Business Associate Agreement Request

---

Dear Support Team,

We require a Business Associate Agreement (BAA) for our use of your email services in our healthcare platform.

**Organization Information:**
- Company Name: CareConnex Inc.
- Account ID: [YOUR_ACCOUNT_ID]
- Primary Contact: [YOUR_NAME]
- Email: [YOUR_EMAIL]

**Services Used:**
- Transactional email
- Email templates
- Email analytics

**Use Case:**
We send emails containing:
- Appointment confirmations
- Care plan updates
- Account notifications
- Password resets

**HIPAA Compliance Needs:**
Some emails may contain PHI:
- Client names with appointment details
- Care instructions
- Medical need descriptions

**Request:**
Please provide:
1. Signed BAA
2. HIPAA compliance documentation
3. Security configuration recommendations

Timeline: [YOUR_TIMELINE]

Thank you,

[YOUR_NAME]

---

## CHECKLIST: BEFORE SENDING BAA REQUESTS

- [ ] You have an active account with the vendor
- [ ] You have your account information ready (ID, SID, etc.)
 [ ] You can explain exactly what PHI will be handled
- [ ] You have a business email address
- [ ] You understand which specific services you'll use
- [ ] You have determined which vendors actually need a BAA

---

## VENDORS THAT TYPICALLY REQUIRE BAAs

**Require BAA (if handling PHI):**
- ✅ Google Cloud / Firebase
- ✅ Twilio (if sending PHI via SMS)
- ✅ Stripe (if payment records linked to PHI)
- ✅ Email service providers (SendGrid, Mailgun, etc.)
- ✅ Cloud storage providers
- ✅ Analytics providers (if tracking PHI)
- ✅ Customer support platforms

**Typically DON'T Require BAA:**
- ❌ General web hosting (if no PHI stored)
- ❌ CDN providers (CloudFlare, etc.)
- ❌ Frontend libraries/frameworks
- ❌ Development tools
- ❌ General business tools (Slack, etc. - unless sharing PHI)

---

## AFTER RECEIVING THE BAA

1. **Review** the BAA carefully
2. **Sign** and return to vendor
3. **Save** executed copy in your HIPAA documentation
4. **Configure** services per HIPAA requirements
5. **Document** the BAA in your policies
6. **Review annually** or when services change

---

## QUESTIONS TO ASK VENDORS

1. "Is your BAA HIPAA-compliant and up to date with current regulations?"
2. "Do you provide encryption at rest and in transit by default?"
3. "What audit logging capabilities do you provide?"
4. "How do you handle breach notification?"
5. "Can you provide a SOC 2 Type II report?"
6. "What are your data retention and destruction policies?"
7. "Where is data stored geographically?"

---

**Questions?** Contact your healthcare attorney or compliance consultant.
