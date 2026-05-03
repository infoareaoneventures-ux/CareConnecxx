# 🔒 CareConnex HIPAA Compliance & Security Checklist

## CRITICAL: DO NOT LAUNCH WITHOUT THESE ITEMS

---

## ✅ 1. Business Associate Agreements (BAAs)

Before handling ANY PHI, you MUST have signed BAAs with:

- [ ] **Google Cloud / Firebase** → Request BAA: https://cloud.google.com/terms/hipaa
- [ ] **Twilio** (Video calls) → Request BAA: https://www.twilio.com/legal/hipaa
- [ ] **Stripe** (Payments) → Request BAA: https://stripe.com/guides/hipaa
- [ ] **Background Check Provider** (Checkr, Sterling, etc.) → Must sign BAA
- [ ] **Insurance Provider** (Bunker, etc.) → Verify BAA status

**Timeline:** 2-4 weeks to process

---

## ✅ 2. Environment Variables (NEVER commit to Git)

Create `.env.production` file (add to `.gitignore`!):

```bash
# Firebase Config
VITE_FIREBASE_API_KEY=your_key
VITE_FIREBASE_AUTH_DOMAIN=your_domain
VITE_FIREBASE_PROJECT_ID=your_project
VITE_FIREBASE_STORAGE_BUCKET=your_bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender
VITE_FIREBASE_APP_ID=your_app_id

# Encryption (CRITICAL - Generate strong key!)
VITE_ENCRYPTION_KEY=your_256_bit_encryption_key_here_min_32_chars
VITE_SSN_PEPPER=another_secret_for_ssn_hashing

# Stripe
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_SECRET_KEY=sk_live_... # Server-side only

# Twilio
VITE_TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=... # Server-side only

# AI
VITE_GEMINI_API_KEY=...
```

**Generate encryption key:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## ✅ 3. Code Changes Required

### Install Dependencies
```bash
npm install crypto-js
npm install --save-dev @types/crypto-js
```

### Update Data Layer

Everywhere you write caregiver data to Firestore, use:

```typescript
import { prepareCaregiverForWrite, logPIIAccess } from '../utils/encryption';

// BEFORE (INSECURE):
await setDoc(doc(db, 'caregivers', uid), caregiverData);

// AFTER (SECURE):
const securedData = prepareCaregiverForWrite(caregiverData);
await setDoc(doc(db, 'caregivers', uid), securedData);
logPIIAccess(auth.currentUser.uid, 'write', 'caregiver_profile', uid);
```

### Update Data Reads

```typescript
import { sanitizeCaregiverPublic } from '../utils/encryption';

// For public profiles:
const caregiverDoc = await getDoc(doc(db, 'caregivers', id));
const publicData = sanitizeCaregiverPublic(caregiverDoc.data());
```

---

## ✅ 4. Firebase Configuration

### Enable Firebase Authentication
- [ ] Email/Password provider enabled
- [ ] Email verification required
- [ ] Strong password policy (min 8 chars, complexity)

### Enable Firebase Security Rules
```bash
firebase deploy --only firestore:rules
```

### Enable Firebase App Check
Prevents abuse:
```bash
firebase appcheck:initialize
```

### Enable Firebase Audit Logging
Go to: Firebase Console → Project Settings → Usage & Billing → Enable audit logs

---

## ✅ 5. Data Structure Changes

### Caregiver Collection
Split into TWO collections:

1. **`caregivers/{id}`** - Public profile (name, bio, skills, rating)
2. **`caregivers/{id}/private/pii`** - Encrypted PII (SSN, DOB, background check)

### Migration Script Needed
```typescript
// Run ONCE before launch to migrate existing data
const migrateToSecureSchema = async () => {
  const caregivers = await getDocs(collection(db, 'caregivers'));
  
  for (const doc of caregivers.docs) {
    const data = doc.data();
    
    // Move PII to subcollection
    await setDoc(
      doc(db, 'caregivers', doc.id, 'private', 'pii'),
      {
        ssnEncrypted: encryptPII(data.backgroundCheckData?.ssn),
        ssnHash: hashSSN(data.backgroundCheckData?.ssn),
        dobEncrypted: encryptPII(data.backgroundCheckData?.dob),
        _migratedAt: new Date().toISOString(),
      }
    );
    
    // Remove PII from main doc
    await updateDoc(doc.ref, {
      'backgroundCheckData.ssn': deleteField(),
      'backgroundCheckData.dob': deleteField(),
      _security: { encrypted: true, version: '1.0' }
    });
  }
};
```

---

## ✅ 6. HIPAA Required Policies

You MUST create these documents (legal review required):

1. **Privacy Policy**
   - How PHI is collected, used, stored
   - Patient rights (access, amendment, accounting of disclosures)
   - Breach notification procedures

2. **Terms of Service**
   - User responsibilities
   - Acceptable use
   - Liability limitations

3. **Business Associate Agreement Template**
   - For any vendors handling PHI

4. **Data Retention Policy**
   - How long to keep records
   - Secure deletion procedures

5. **Incident Response Plan**
   - Breach detection
   - Notification timeline (60 days max per HIPAA)
   - Mitigation steps

6. **Security Risk Assessment**
   - Document all potential risks
   - Mitigation strategies
   - Review annually

---

## ✅ 7. Technical Safeguards (HIPAA Requirements)

### Access Control
- [ ] Unique user IDs for all users
- [ ] Role-based access (admin, caregiver, client)
- [ ] Automatic session timeout (15 min inactivity)
- [ ] Emergency access procedure

### Audit Controls
- [ ] Log all PHI access (who, what, when)
- [ ] Log all admin actions
- [ ] Logins and failed logins
- [ ] Data exports

### Integrity Controls
- [ ] Data validation on input
- [ ] Checksums or digital signatures
- [ ] Backup and recovery procedures

### Transmission Security
- [ ] TLS 1.3 for all connections
- [ ] End-to-end encryption for video calls (Twilio)
- [ ] Encrypted data at rest

---

## ✅ 8. Pre-Launch Security Checklist

### Penetration Testing
- [ ] Hire third-party security auditor
- [ ] OWASP Top 10 review
- [ ] Firebase security rules audit

### Data Backup
- [ ] Automated daily backups
- [ ] Encrypted backup storage
- [ ] Quarterly recovery testing

### Monitoring
- [ ] Firebase Crashlytics enabled
- [ ] Firebase Performance Monitoring
- [ ] Custom security event alerts

### Documentation
- [ ] API documentation
- [ ] Security architecture diagram
- [ ] Incident response runbook

---

## ✅ 9. Legal Requirements

### Entity Formation
- [ ] LLC or Corporation formed
- [ ] Professional liability insurance
- [ ] Cyber liability insurance ($1M+ recommended)
- [ ] Workers compensation (if hiring W2 caregivers)

### Licensing
- [ ] Home care agency license (state-specific)
- [ ] Business license
- [ ] Tax ID (EIN)

### Background Check Compliance
- [ ] FCRA compliance for background checks
- [ ] State-specific background check laws
- [ ] Ongoing monitoring (not just initial check)

---

## ✅ 10. Launch Day Checklist

- [ ] All BAAs signed and filed
- [ ] Encryption keys generated and secured
- [ ] Firestore rules deployed and tested
- [ ] Environment variables configured
- [ ] Privacy policy and terms live
- [ ] Support email/phone active
- [ ] Incident response team on standby
- [ ] Monitoring dashboards active
- [ ] Backup systems tested
- [ ] Rollback plan documented

---

## 🚨 Post-Launch (Ongoing)

### Monthly
- [ ] Review audit logs
- [ ] Check for unauthorized access attempts
- [ ] Update dependencies (security patches)

### Quarterly
- [ ] Security risk assessment review
- [ ] Access review (remove terminated employees)
- [ ] Backup recovery test
- [ ] Policy updates

### Annually
- [ ] Full security audit
- [ ] HIPAA compliance review
- [ ] Penetration test
- [ ] Staff security training

---

## 📞 Emergency Contacts

| Issue | Contact |
|-------|---------|
| Data Breach | [Your Incident Response Team] |
| Firebase Issues | Firebase Support + your dev team |
| Legal Questions | [Your Healthcare Attorney] |
| Insurance Claims | [Your Cyber Liability Carrier] |

---

## 🎯 Priority: DO NOT SKIP

**Blocks Launch:**
1. BAAs signed
2. Encryption implemented
3. Firestore rules hardened
4. Privacy policy live

**Can Fix Post-Launch:**
- Advanced audit logging
- Automated backup testing
- Performance optimizations

---

**Questions? Review with healthcare compliance attorney before launch.**
