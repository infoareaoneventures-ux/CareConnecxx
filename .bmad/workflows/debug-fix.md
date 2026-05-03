# BMAD Workflow: Debug and Fix

## Purpose
Systematic debugging and issue resolution for CareConnex

## Trigger
/bmad-fix

## Steps

### 1. PROBLEM DEFINITION
**Agent:** ProductManager

Clarify:
- What is the exact error/symptom?
- Who reported it? (family, caregiver, internal)
- What is the severity? (critical, high, medium, low)
- When did it start?
- What is the impact?

**Output:** Problem statement + severity assessment

---

### 2. REPRODUCTION
**Agent:** Developer

Attempt to reproduce:
- Exact steps to reproduce
- Environment details (browser, device, etc.)
- Frequency (always, sometimes, rare)
- Scope (affects how many users?)

**Output:** Reproduction steps + confirmed/uncertain

---

### 3. ROOT CAUSE ANALYSIS
**Agent:** Architect + Developer

Investigate:
- Review error logs
- Check Firebase logs
- Review Railway logs (Cara)
- Check Twilio logs (WhatsApp)
- Analyze recent changes
- Database state inspection

**Output:** Root cause identified

---

### 4. SOLUTION DESIGN
**Agent:** Architect

Design fix:
- Multiple solution options
- Pros/cons of each
- Risk assessment
- Testing approach
- Rollback plan

**Output:** Solution recommendation

---

### 5. IMPLEMENTATION
**Agent:** Developer

Fix:
- Implement solution
- Add regression tests
- Update documentation if needed
- Security review (if applicable)

**Output:** Fixed code

---

### 6. VERIFICATION
**Agent:** Developer

Verify:
- Reproduction steps now pass
- No regressions
- Tests pass
- Manual QA complete

**Output:** Verification report

---

### 7. DEPLOYMENT
**Agent:** DevOps

Deploy:
- Hotfix to production (if critical)
- Monitor error rates
- Confirm fix works
- Communication to users (if needed)

**Output:** Issue resolved

---

### 8. PREVENTION
**Agent:** Architect

Prevent recurrence:
- Add monitoring/alerting
- Update tests
- Document lesson learned
- Process improvement

**Output:** Prevention measures

---

## Severity Levels

### 🔴 Critical
- System down
- Data loss
- Security breach
- HIPAA violation
**Action:** Stop everything, fix immediately

### 🟠 High
- Core feature broken
- Many users affected
- Workaround exists
**Action:** Fix within 24 hours

### 🟡 Medium
- Non-core feature issue
- Some users affected
- Clear workaround
**Action:** Fix within sprint

### 🟢 Low
- Cosmetic issue
- Edge case
- Minimal impact
**Action:** Fix when convenient

---

## Completion Criteria
- [ ] Root cause identified
- [ ] Fix deployed
- [ ] Issue verified resolved
- [ ] Prevention measures in place
- [ ] Documentation updated

## Next Workflow
If successful: Return to previous workflow  
If systemic: `/bmad-architect` for redesign
