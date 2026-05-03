
import { useState, useEffect } from 'react';
import { Caregiver, Senior, MatchFeedback } from '../types';
import { dbService, authService } from '../services/api';
import { matchService } from '../services/matchService';

interface UseSmartMatchReturn {
  matches: Caregiver[];
  seniorProfile: Senior | undefined;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * Hook for fetching smart caregiver matches for the current senior user
 */
export const useSmartMatch = (): UseSmartMatchReturn => {
  const [matches, setMatches] = useState<Caregiver[]>([]);
  const [seniorProfile, setSeniorProfile] = useState<Senior | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const runMatching = async () => {
      setLoading(true);
      setError(null);
      
      try {
        // 1. Get Current User
        const currentUser = authService.getCurrentUser();
        if (!currentUser?.uid) {
          if (!cancelled) {
            setLoading(false);
            setError('User not authenticated');
          }
          return;
        }

        // 2. Fetch Profile
        const profile = await dbService.getSeniorProfile(currentUser.uid);
        if (cancelled) return;

        if (profile) {
          setSeniorProfile(profile);

          // 3. Get Matches via Server Engine
          const bestMatches = await dbService.getMatches(profile);
          if (cancelled) return;
          
          setMatches(bestMatches);
        } else {
          setError('Profile not found. Please complete your profile.');
        }

      } catch (err) {
        if (cancelled) return;
        const errorMessage = err instanceof Error ? err.message : 'Failed to fetch matches';
        console.error("Match fetch failed", err);
        setError(errorMessage);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    runMatching();

    return () => { cancelled = true; };
  }, [retryCount]);

  const refetch = () => {
    setRetryCount(prev => prev + 1);
  };

  return { matches, loading, seniorProfile, error, refetch };
};


