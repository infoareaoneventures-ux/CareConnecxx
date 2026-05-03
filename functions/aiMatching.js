const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize if not already done
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

/**
 * Background AI Matching Job
 * Runs every hour to score all open match assignments
 * 
 * Trigger: HTTP (for manual) or Schedule (for automatic)
 */
exports.runAIMatching = functions.https.onRequest(async (req, res) => {
  console.log('[AI Matching Job] Starting background scoring...');
  
  try {
    // Get all open match assignments
    const assignmentsSnapshot = await db.collection('matchAssignments')
      .where('status', 'in', ['pending_review', 'in_review'])
      .get();
    
    console.log(`[AI Matching Job] Found ${assignmentsSnapshot.size} open assignments`);
    
    let processed = 0;
    let errors = 0;
    
    for (const doc of assignmentsSnapshot.docs) {
      try {
        const assignment = { id: doc.id, ...doc.data() };
        
        // Get client intake data
        const intakeDoc = await db.collection('clientIntakes').doc(assignment.clientId).get();
        if (!intakeDoc.exists) {
          console.log(`[AI Matching Job] No intake found for ${assignment.clientId}`);
          continue;
        }
        
        const intakeData = intakeDoc.data();
        
        // Get all approved caregivers
        const caregiversSnapshot = await db.collection('caregivers')
          .where('verified', '==', true)
          .get();
        
        console.log(`[AI Matching Job] Scoring ${caregiversSnapshot.size} caregivers for ${assignment.id}`);
        
        // Score each caregiver
        const scores = [];
        for (const cgDoc of caregiversSnapshot.docs) {
          const caregiver = { id: cgDoc.id, ...cgDoc.data() };
          const score = await scoreCaregiver(caregiver, intakeData, assignment);
          if (score) {
            scores.push(score);
          }
        }
        
        // Sort by score
        scores.sort((a, b) => b.overallScore - a.overallScore);
        
        // Store top 20 scores
        await db.collection('aiMatchScores').doc(assignment.id).set({
          assignmentId: assignment.id,
          clientId: assignment.clientId,
          scores: scores.slice(0, 20),
          totalScored: scores.length,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
          algorithmVersion: '1.0.0'
        });
        
        // Update assignment with AI ready status
        await doc.ref.update({
          aiScoresReady: true,
          aiScoresGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
          topMatchScore: scores.length > 0 ? scores[0].overallScore : 0
        });
        
        processed++;
        console.log(`[AI Matching Job] Completed scoring for ${assignment.id}`);
        
      } catch (error) {
        console.error(`[AI Matching Job] Error processing ${doc.id}:`, error);
        errors++;
      }
    }
    
    console.log(`[AI Matching Job] Complete. Processed: ${processed}, Errors: ${errors}`);
    res.json({ 
      success: true, 
      processed, 
      errors,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[AI Matching Job] Fatal error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * Scheduled version - runs every hour
 */
exports.scheduledAIMatching = functions.pubsub
  .schedule('every 60 minutes')
  .onRun(async (context) => {
    console.log('[AI Matching Scheduled] Starting hourly scoring...');
    
    try {
      // Call the same logic as HTTP version
      const assignmentsSnapshot = await db.collection('matchAssignments')
        .where('status', 'in', ['pending_review', 'in_review'])
        .where('aiScoresReady', '!=', true) // Only process new ones
        .get();
      
      console.log(`[AI Matching Scheduled] Found ${assignmentsSnapshot.size} assignments needing scoring`);
      
      for (const doc of assignmentsSnapshot.docs) {
        try {
          const assignment = { id: doc.id, ...doc.data() };
          
          // Skip if already scored recently
          if (assignment.aiScoresGeneratedAt) {
            const lastScored = assignment.aiScoresGeneratedAt.toDate();
            const hoursSince = (Date.now() - lastScored.getTime()) / (1000 * 60 * 60);
            if (hoursSince < 6) {
              console.log(`[AI Matching Scheduled] Skipping ${doc.id} - scored ${hoursSince.toFixed(1)}h ago`);
              continue;
            }
          }
          
          // Get intake data
          const intakeDoc = await db.collection('clientIntakes').doc(assignment.clientId).get();
          if (!intakeDoc.exists) continue;
          
          const intakeData = intakeDoc.data();
          
          // Get caregivers
          const caregiversSnapshot = await db.collection('caregivers')
            .where('verified', '==', true)
            .get();
          
          // Score caregivers
          const scores = [];
          for (const cgDoc of caregiversSnapshot.docs) {
            const caregiver = { id: cgDoc.id, ...cgDoc.data() };
            const score = await scoreCaregiver(caregiver, intakeData, assignment);
            if (score) {
              scores.push(score);
            }
          }
          
          scores.sort((a, b) => b.overallScore - a.overallScore);
          
          // Store scores
          await db.collection('aiMatchScores').doc(assignment.id).set({
            assignmentId: assignment.id,
            clientId: assignment.clientId,
            scores: scores.slice(0, 20),
            totalScored: scores.length,
            generatedAt: admin.firestore.FieldValue.serverTimestamp(),
            algorithmVersion: '1.0.0'
          });
          
          await doc.ref.update({
            aiScoresReady: true,
            aiScoresGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
            topMatchScore: scores.length > 0 ? scores[0].overallScore : 0
          });
          
          console.log(`[AI Matching Scheduled] Scored ${scores.length} caregivers for ${assignment.id}`);
          
        } catch (error) {
          console.error(`[AI Matching Scheduled] Error on ${doc.id}:`, error);
        }
      }
      
      console.log('[AI Matching Scheduled] Hourly run complete');
      
    } catch (error) {
      console.error('[AI Matching Scheduled] Fatal error:', error);
    }
  });

/**
 * Score a single caregiver against intake data
 * Simplified version of the client-side scoring for Cloud Functions
 */
async function scoreCaregiver(caregiver, intakeData, assignment) {
  try {
    // Hard constraints
    if (!caregiver.verified) return null;
    
    // Calculate distance if we have coordinates
    let distance = caregiver.distance || 999;
    if (intakeData.latitude && intakeData.longitude && caregiver.latitude && caregiver.longitude) {
      distance = calculateDistance(
        intakeData.latitude,
        intakeData.longitude,
        caregiver.latitude,
        caregiver.longitude
      );
    }
    
    // Max distance filter
    if (distance > 30) return null;
    
    // Base score
    let score = 50;
    const reasoning = [];
    const redFlags = [];
    
    // Distance scoring
    if (distance < 5) {
      score += 20;
      reasoning.push(`Only ${distance.toFixed(1)} miles away`);
    } else if (distance < 15) {
      score += 10;
    } else {
      score -= 5;
      redFlags.push(`${distance.toFixed(1)} miles away`);
    }
    
    // Skills matching
    const careTypes = intakeData.careTypes || [];
    const skills = caregiver.skills || [];
    const matchingSkills = careTypes.filter(need =>
      skills.some(skill => skill.toLowerCase().includes(need.toLowerCase()))
    );
    
    if (matchingSkills.length > 0) {
      score += Math.min(matchingSkills.length * 10, 30);
      reasoning.push(`Experience with: ${matchingSkills.slice(0, 2).join(', ')}`);
    }
    
    // Experience
    if (caregiver.experience >= 5) {
      score += 15;
      reasoning.push(`${caregiver.experience} years experience`);
    } else if (caregiver.experience >= 3) {
      score += 10;
    }
    
    // Rating
    if (caregiver.rating >= 4.5) {
      score += 10;
      reasoning.push(`${caregiver.rating.toFixed(1)}★ rating`);
    } else if (caregiver.rating < 4.0) {
      score -= 5;
      redFlags.push(`Lower rating (${caregiver.rating}★)`);
    }
    
    // Verified bonus
    if (caregiver.backgroundCheckStatus === 'clear') {
      score += 5;
    }
    
    // Cap score
    score = Math.max(0, Math.min(100, score));
    
    // Confidence
    let confidence = 'low';
    if (score >= 85 && redFlags.length === 0) {
      confidence = 'high';
    } else if (score >= 70 && redFlags.length <= 1) {
      confidence = 'medium';
    }
    
    return {
      caregiverId: caregiver.id,
      caregiverName: caregiver.name,
      overallScore: Math.round(score),
      breakdown: {
        ruleBasedScore: Math.round(score),
        predictiveScore: Math.round(score),
      },
      reasoning: reasoning.slice(0, 4),
      redFlags,
      confidence,
      factors: {
        distance,
        skillsMatch: careTypes.length > 0 ? matchingSkills.length / careTypes.length : 1,
        availability: 1,
        experience: caregiver.experience || 0,
        rating: caregiver.rating || 0,
        retention: caregiver.retentionRate || 0
      }
    };
    
  } catch (error) {
    console.error(`[AI Matching] Error scoring caregiver ${caregiver.id}:`, error);
    return null;
  }
}

/**
 * Calculate distance between two points
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
