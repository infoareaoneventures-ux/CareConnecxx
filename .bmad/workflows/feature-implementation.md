# BMAD Workflow: Feature Implementation

## Purpose
Guided workflow for implementing new features in CareConnex using BMAD Method

## Trigger
/bmad-implement

## Steps

### 1. REQUIREMENTS CLARIFICATION
**Agent:** ProductManager

Questions to answer:
- What problem does this solve for families/caregivers?
- Who are the primary users?
- What is the success metric?
- Are there HIPAA/compliance considerations?
- What is the priority/urgency?

**Output:** Feature specification document

---

### 2. IMPACT ANALYSIS
**Agent:** Architect + HealthcareCompliance

Analyze:
- Database schema changes needed
- API modifications
- Frontend components affected
- Third-party integrations (Twilio, Stripe, etc.)
- Security/compliance implications
- Performance impact

**Output:** Technical impact assessment

---

### 3. ARCHITECTURE DESIGN
**Agent:** Architect

Design:
- System architecture changes
- Data flow diagrams
- API contracts
- Database migrations
- Error handling strategy

**Output:** Architecture Decision Record (ADR)

---

### 4. IMPLEMENTATION PLAN
**Agent:** Developer

Create plan:
- Break into tasks/stories
- Estimate effort
- Identify dependencies
- Assign priorities
- Define test strategy

**Output:** Implementation roadmap

---

### 5. IMPLEMENTATION
**Agent:** Developer

Execute:
- Write code following CareConnex patterns
- Add tests (unit, integration, e2e)
- Update documentation
- Follow HIPAA compliance checklist
- Ensure accessibility for seniors

**Output:** Working code + tests

---

### 6. CODE REVIEW
**Agent:** Architect + HealthcareCompliance

Review:
- Code quality
- Security vulnerabilities
- HIPAA compliance
- Performance
- Accessibility

**Output:** Review feedback + approval

---

### 7. TESTING
**Agent:** Developer

Test:
- Unit tests pass
- Integration tests pass
- Manual QA
- Security scan
- Accessibility audit

**Output:** Test results + sign-off

---

### 8. DEPLOYMENT
**Agent:** DevOps

Deploy:
- Deploy to staging
- Run smoke tests
- Deploy to production
- Monitor metrics
- Rollback plan ready

**Output:** Live feature + monitoring

---

### 9. FEEDBACK LOOP
**Agent:** ProductManager

Measure:
- User adoption
- Success metrics
- Issues reported
- Feedback collected

**Output:** Post-launch review

---

## Completion Criteria
- [ ] Feature deployed to production
- [ ] Tests passing
- [ ] Documentation updated
- [ ] Monitoring in place
- [ ] Feedback collected

## Next Workflow
If successful: `/bmad-scale` for optimization  
If issues: `/bmad-fix` for debugging
