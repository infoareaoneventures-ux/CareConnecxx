# 🎯 BMAD Quick Reference - CareConnex

## Common Commands

### Getting Help
```
/bmad-help          - What's next?
/bmad-help status   - Current project status
/bmad-help done     - Mark task complete, what's next?
```

### Starting Work
```
/bmad-plan          - Plan new feature
/bmad-architect     - Design system changes
/bmad-implement     - Build feature
```

### Problem Solving
```
/bmad-fix           - Debug and fix issues
/bmad-review        - Code/architecture review
/bmad-scale         - Performance optimization
```

### Multi-Agent Mode (Party Mode)
```
@ProductManager + @Architect
"Should we add video calling?"

@HealthcareCompliance + @Architect
"Is this design HIPAA compliant?"
```

---

## Workflow Selection Guide

| What You Need | Command |
|--------------|---------|
| New feature | `/bmad-plan` → `/bmad-architect` → `/bmad-implement` |
| Bug fix | `/bmad-fix` |
| Performance issue | `/bmad-scale` |
| Code review | `/bmad-review` |
| Refactoring | `/bmad-architect` → `/bmad-implement` |
| Emergency hotfix | `/bmad-fix` (critical path) |

---

## Agent Specializations

| Agent | Use For |
|-------|---------|
| **ProductManager** | Requirements, prioritization, roadmap |
| **Architect** | System design, technical decisions |
| **Developer** | Implementation, code patterns |
| **HealthcareCompliance** | HIPAA, security, regulations |
| **UX Designer** | User flows, accessibility for seniors |
| **DevOps** | Deployment, infrastructure, monitoring |
| **CareExpert** | Industry knowledge, care workflows |

---

## CareConnex-Specific Patterns

### Adding a New Feature
1. `/bmad-plan` - Define requirements
2. Check HIPAA compliance (healthcare agent)
3. `/bmad-architect` - Design system
4. `/bmad-implement` - Build it
5. `/bmad-review` - Code review
6. Deploy to Railway/Firebase
7. Monitor metrics

### Fixing Production Issue
1. `/bmad-fix` - Assess severity
2. If Critical: Hotfix immediately
3. If High: Fix within 24h
4. Root cause analysis
5. Prevention measures

### Scaling System
1. `/bmad-scale` - Identify bottlenecks
2. Performance profiling
3. Architecture optimization
4. Load testing
5. Gradual rollout

---

## Important Reminders

✅ **Always consider:**
- HIPAA compliance for any data changes
- Accessibility for senior users
- Performance on mobile devices
- Fallback for caregivers with limited tech

⚠️ **Before deploying:**
- Tests pass
- Security scan clear
- Accessibility check
- Monitoring in place
- Rollback plan ready

🚀 **After deploying:**
- Monitor error rates
- Check user feedback
- Measure success metrics
- Iterate based on data

---

## Project Context

**Current Focus:** Caregiver-family matching experience
**Key Metrics:** Match rate, time to interview, satisfaction
**Tech Stack:** React, Firebase, Railway, Twilio, OpenAI
**Compliance:** HIPAA, WCAG accessibility

---

*Type /bmad-help anytime to get back on track*
