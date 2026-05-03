import { dbService } from './api';
import { MatchOutcome } from './aiMatchingService';

/**
 * Match Tracking Service
 * Records outcomes of matches for AI learning
 * Tracks: coordinator picks, client hires, retention, issues
 */

export interface MatchTrackingEvent {
  type: 'coordinator_pick' | 'client_hire' | 'interview_complete' | 'interview_no_hire' | 'issue_reported' | 'retention_check';
  matchAssignmentId: string;
  caregiverId: string;
  clientId: string;
  timestamp: string;
  metadata?: any;
}

class MatchTrackingService {
  /**
   * Track when coordinator picks a caregiver (from AI suggestions or manual)
   */
  async trackCoordinatorPick(
    matchAssignmentId: string,
    caregiverId: string,
    clientId: string,
    aiSuggested: boolean,
    aiRank?: number // 1 = top suggestion, 2 = second, etc.
  ): Promise<void> {
    try {
      await dbService.createMatchTrackingEvent({
        type: 'coordinator_pick',
        matchAssignmentId,
        caregiverId,
        clientId,
        timestamp: new Date().toISOString(),
        metadata: {
          aiSuggested,
          aiRank,
          source: aiSuggested ? 'ai_suggestion' : 'manual_search'
        }
      });

      // Also update the outcome record
      await this.updateOutcome(matchAssignmentId, caregiverId, {
        coordinatorPicked: true,
        coordinatorPickedAt: new Date().toISOString(),
        aiSuggested,
        aiRank
      });

      console.log(`[Match Tracking] Coordinator picked ${caregiverId} (AI suggested: ${aiSuggested})`);
    } catch (error) {
      console.error('[Match Tracking] Error tracking pick:', error);
    }
  }

  /**
   * Track when client hires a caregiver
   */
  async trackClientHire(
    matchAssignmentId: string,
    caregiverId: string,
    clientId: string,
    hireRequestId: string
  ): Promise<void> {
    try {
      await dbService.createMatchTrackingEvent({
        type: 'client_hire',
        matchAssignmentId,
        caregiverId,
        clientId,
        timestamp: new Date().toISOString(),
        metadata: { hireRequestId }
      });

      await this.updateOutcome(matchAssignmentId, caregiverId, {
        clientHired: true,
        clientHiredAt: new Date().toISOString(),
        hireRequestId
      });

      console.log(`[Match Tracking] Client hired ${caregiverId}`);
    } catch (error) {
      console.error('[Match Tracking] Error tracking hire:', error);
    }
  }

  /**
   * Track interview completion
   */
  async trackInterviewComplete(
    matchAssignmentId: string,
    caregiverId: string,
    clientId: string,
    interviewRequestId: string,
    outcome: 'hired' | 'no_hire' | 'pending'
  ): Promise<void> {
    try {
      await dbService.createMatchTrackingEvent({
        type: outcome === 'hired' ? 'interview_complete' : 'interview_no_hire',
        matchAssignmentId,
        caregiverId,
        clientId,
        timestamp: new Date().toISOString(),
        metadata: { interviewRequestId, outcome }
      });

      if (outcome === 'no_hire') {
        await this.updateOutcome(matchAssignmentId, caregiverId, {
          interviewCompleted: true,
          clientHired: false,
          interviewOutcome: 'no_hire'
        });
      }

      console.log(`[Match Tracking] Interview completed for ${caregiverId}: ${outcome}`);
    } catch (error) {
      console.error('[Match Tracking] Error tracking interview:', error);
    }
  }

  /**
   * Track issues reported
   */
  async trackIssue(
    matchAssignmentId: string,
    caregiverId: string,
    clientId: string,
    issueType: string,
    severity: 'low' | 'medium' | 'high'
  ): Promise<void> {
    try {
      await dbService.createMatchTrackingEvent({
        type: 'issue_reported',
        matchAssignmentId,
        caregiverId,
        clientId,
        timestamp: new Date().toISOString(),
        metadata: { issueType, severity }
      });

      await this.updateOutcome(matchAssignmentId, caregiverId, {
        anyIssues: true,
        issueType,
        issueSeverity: severity
      });

      console.log(`[Match Tracking] Issue reported for ${caregiverId}: ${issueType}`);
    } catch (error) {
      console.error('[Match Tracking] Error tracking issue:', error);
    }
  }

  /**
   * Track 30-day retention check
   */
  async trackRetentionCheck(
    matchAssignmentId: string,
    caregiverId: string,
    clientId: string,
    stillActive: boolean
  ): Promise<void> {
    try {
      await dbService.createMatchTrackingEvent({
        type: 'retention_check',
        matchAssignmentId,
        caregiverId,
        clientId,
        timestamp: new Date().toISOString(),
        metadata: { stillActive, daysSinceHire: 30 }
      });

      await this.updateOutcome(matchAssignmentId, caregiverId, {
        retention30Day: stillActive
      });

      console.log(`[Match Tracking] 30-day retention for ${caregiverId}: ${stillActive}`);
    } catch (error) {
      console.error('[Match Tracking] Error tracking retention:', error);
    }
  }

  /**
   * Get outcomes for learning/retraining
   */
  async getOutcomesForTraining(sinceDays: number = 90): Promise<any[]> {
    try {
      const since = new Date();
      since.setDate(since.getDate() - sinceDays);

      return await dbService.getMatchOutcomes(since.toISOString());
    } catch (error) {
      console.error('[Match Tracking] Error getting outcomes:', error);
      return [];
    }
  }

  /**
   * Get coordinator performance stats
   */
  async getCoordinatorStats(coordinatorId: string): Promise<{
    totalMatches: number;
    aiSuggestionsPicked: number;
    manualPicks: number;
    hireRate: number;
    retentionRate: number;
  }> {
    try {
      return await dbService.getCoordinatorStats(coordinatorId);
    } catch (error) {
      console.error('[Match Tracking] Error getting stats:', error);
      return {
        totalMatches: 0,
        aiSuggestionsPicked: 0,
        manualPicks: 0,
        hireRate: 0,
        retentionRate: 0
      };
    }
  }

  /**
   * Get AI suggestion effectiveness
   */
  async getAIEffectiveness(): Promise<{
    totalSuggestions: number;
    pickedByCoordinator: number;
    pickedAndHired: number;
    averageScoreOfPicked: number;
    averageScoreOfNotPicked: number;
  }> {
    try {
      return await dbService.getAIEffectivenessStats();
    } catch (error) {
      console.error('[Match Tracking] Error getting AI effectiveness:', error);
      return {
        totalSuggestions: 0,
        pickedByCoordinator: 0,
        pickedAndHired: 0,
        averageScoreOfPicked: 0,
        averageScoreOfNotPicked: 0
      };
    }
  }

  // Private helper
  private async updateOutcome(
    matchAssignmentId: string,
    caregiverId: string,
    updates: any
  ): Promise<void> {
    try {
      await dbService.updateMatchOutcome(matchAssignmentId, caregiverId, {
        ...updates,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('[Match Tracking] Error updating outcome:', error);
    }
  }
}

// Export singleton
export const matchTrackingService = new MatchTrackingService();
