import { useState, useEffect } from 'react';
import { Caregiver } from '../types';
import { dbService } from '../services/api';
import { scoreJobForCaregiver, JobMatch } from '../services/jobMatchService';

export type { JobMatch };

export const useAiJobMatch = (profile: Caregiver | null) => {
  const [matchedJobs, setMatchedJobs] = useState<JobMatch[]>([]);
  const [allJobs, setAllJobs] = useState<ReturnType<typeof dbService.getOpenJobs> extends Promise<infer T> ? T : never[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    const fetchAndMatchJobs = async () => {
      if (!profile) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const jobs = await dbService.getOpenJobs();
        if (!isMounted) return;
        setAllJobs(jobs as any);

        const scoredJobs: JobMatch[] = [];
        for (const job of jobs) {
          const match = await scoreJobForCaregiver(job as any, profile);
          if (match.matchScore > 50) scoredJobs.push(match);
        }

        scoredJobs.sort((a, b) => b.matchScore - a.matchScore);
        if (isMounted) setMatchedJobs(scoredJobs);
      } catch (error) {
        console.error('Job matching failed:', error);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchAndMatchJobs();
    return () => { isMounted = false; };
  }, [profile]);

  return { matchedJobs, allJobs, loading };
};

export default useAiJobMatch;
