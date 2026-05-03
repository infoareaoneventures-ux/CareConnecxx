import { dbService } from './api';
import { matchService } from './matchService';
import { Senior, Caregiver } from '../types';
import { getMLTrainingService, TrainingProgress } from './mlTraining';
import { getMLModelStatus, processMatchFeedback, initializeMLService } from './mlMatchScoring';

/**
 * REAL ML Training Simulation
 * Uses TensorFlow.js neural network trained on 15,000 synthetic scenarios
 */

export interface TrainingSession {
  id: string;
  status: 'running' | 'complete' | 'error';
  progress: number;
  currentEpoch: number;
  totalEpochs: number;
  loss: number;
  valLoss: number;
  accuracy: number;
  logs: string[];
  startTime: number;
  endTime?: number;
}

// Store active training sessions
const trainingSessions = new Map<string, TrainingSession>();

/**
 * Run REAL neural network training with TensorFlow.js
 */
export const runRealTraining = async (
  sessionId: string,
  onProgress?: (progress: TrainingProgress) => void
): Promise<TrainingSession> => {
  const session: TrainingSession = {
    id: sessionId,
    status: 'running',
    progress: 0,
    currentEpoch: 0,
    totalEpochs: 50,
    loss: 0,
    valLoss: 0,
    accuracy: 0,
    logs: [],
    startTime: Date.now()
  };
  
  trainingSessions.set(sessionId, session);

  const log = (msg: string) => {
    session.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    console.log(`[Training ${sessionId}] ${msg}`);
  };

  try {
    log('🚀 INITIALIZING REAL ML TRAINING WITH TENSORFLOW.JS');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    // Initialize ML service
    const mlService = getMLTrainingService();
    const hadExistingModel = await mlService.initialize();
    
    if (hadExistingModel) {
      const stats = mlService.getModelStats();
      log(`📦 Loaded existing model (trained ${stats ? new Date(stats.trainedAt).toLocaleDateString() : 'unknown'})`);
    }

    log('');
    log('📊 MODEL ARCHITECTURE:');
    log('   Input Layer: 50 features');
    log('   Hidden 1: 128 neurons (ReLU + Dropout 0.2)');
    log('   Hidden 2: 64 neurons (ReLU + Dropout 0.1)');
    log('   Hidden 3: 32 neurons (ReLU)');
    log('   Output: 1 neuron (Sigmoid) → Match Score');
    log('');
    log('📚 TRAINING CONFIGURATION:');
    log('   • 15,000 synthetic caregiver-senior scenarios');
    log('   • 80% training / 20% validation split');
    log('   • 50 epochs, batch size 32');
    log('   • Optimizer: Adam (LR: 0.001)');
    log('   • Loss: Mean Squared Error');
    log('');

    // Run training with progress tracking
    const result = await mlService.train((progress) => {
      session.currentEpoch = progress.epoch || 0;
      session.loss = progress.loss || 0;
      session.valLoss = progress.valLoss || 0;
      session.accuracy = progress.accuracy || 0;
      session.progress = ((progress.epoch || 0) / progress.totalEpochs) * 100;

      if (progress.phase === 'training' && progress.epoch) {
        log(`📈 Epoch ${progress.epoch}/${progress.totalEpochs} - Loss: ${progress.loss?.toFixed(4)} - Val Loss: ${progress.valLoss?.toFixed(4)}`);
      } else {
        log(progress.message);
      }

      onProgress?.(progress);
    });

    log('');
    log('✅ TRAINING COMPLETE!');
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`   Final Loss: ${result.finalLoss.toFixed(4)}`);
    log(`   Validation Loss: ${result.finalValLoss.toFixed(4)}`);
    log(`   Accuracy: ${(result.finalAccuracy * 100).toFixed(1)}%`);
    log(`   Training Time: ${(result.trainingTimeMs / 1000).toFixed(1)}s`);
    log(`   Model Size: ${(result.modelSizeBytes / 1024 / 1024).toFixed(2)} MB`);
    log(`   Samples Used: ${result.samplesUsed.toLocaleString()}`);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    session.status = 'complete';
    session.endTime = Date.now();
    session.accuracy = result.finalAccuracy;
    session.loss = result.finalLoss;

    return session;

  } catch (error) {
    log(`❌ TRAINING FAILED: ${error}`);
    session.status = 'error';
    session.endTime = Date.now();
    throw error;
  }
};

/**
 * Get training history for visualization
 */
export const getTrainingHistory = () => {
  const mlService = getMLTrainingService();
  return mlService.getTrainingHistory();
};

/**
 * Get model statistics
 */
export const getModelStats = () => {
  const mlService = getMLTrainingService();
  return mlService.getModelStats();
};

/**
 * Check if model is trained and ready
 */
export const isModelTrained = () => {
  const mlService = getMLTrainingService();
  return mlService.isModelReady();
};

/**
 * Run the original personality-based training simulation (for comparison)
 */
export const runPersonalitySimulation = async (logCallback: (msg: string) => void) => {
    logCallback("🚀 STARTING PERSONALITY-BASED LEARNING SIMULATION...");

    // 1. Setup Synthetic Senior 'Alice'
    const aliceId = 'training-user-alice';
    const aliceProfile: Senior = {
        id: 9999,
        uid: aliceId,
        name: 'Senior Alice',
        age: 80,
        needs: ['Companionship'],
        personality: 'Introvert', // Alice hates loud people
        location: 'Uptown'
    };

    logCallback(`👤 SUBJECT: ${aliceProfile.name} (${aliceProfile.personality})`);
    logCallback("------------------------------------------------");

    // 2. Fetch Candidates
    const { caregivers: allCaregivers } = await dbService.getCaregivers();

    // 3. Identify 'Bad' Caregivers (High Energy) for the test
    const highEnergyCaregivers = allCaregivers.filter(c => c.personalityTags?.includes('High Energy') || c.personalityTags?.includes('Energetic'));
    logCallback(`🔎 Found ${highEnergyCaregivers.length} 'High Energy' caregivers in pool.`);

    // --- PHASE 1: BASELINE (Before Feedback) ---
    logCallback("\n📊 PHASE 1: BASELINE MATCH (No Feedback)");
    const baselineResultsPromises = allCaregivers.map(c => matchService.scoreCaregiver(c, aliceProfile, []));
    const baselineResults = (await Promise.all(baselineResultsPromises)).filter(Boolean) as Caregiver[];
    const top3Baseline = baselineResults.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0)).slice(0, 3);

    top3Baseline.forEach((c, i) => {
        logCallback(`#${i + 1}: ${c.name} (${c.matchScore}%) - Tags: [${c.personalityTags?.join(', ') || 'None'}]`);
    });

    // --- PHASE 2: TRAINING (Simulate Rejection) ---
    logCallback("\n🎓 PHASE 2: TRAINING (Simulating Rejections)");
    logCallback(`...Alice rejects 3 'High Energy' caregivers with reason: "Too loud"`);

    // Create synthetic feedback
    const trainingFeedback = highEnergyCaregivers.slice(0, 3).map(cg => ({
        seniorId: aliceId,
        caregiverId: cg.id,
        action: 'rejected' as const,
        reason: 'Too loud and high energy',
        timestamp: new Date().toISOString()
    }));

    // --- PHASE 3: VERIFICATION (After Feedback) ---
    logCallback("\n📉 PHASE 3: RE-RANKING (Applying Learned Patterns)");
    const trainedResultsPromises = allCaregivers.map(c => matchService.scoreCaregiver(c, aliceProfile, trainingFeedback));
    const trainedResults = (await Promise.all(trainedResultsPromises)).filter(Boolean) as Caregiver[];
    const top3Trained = trainedResults.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0)).slice(0, 3);

    let success = true;
    top3Trained.forEach((c, i) => {
        const isHighEnergy = c.personalityTags?.includes('High Energy') || c.personalityTags?.includes('Energetic');
        const status = isHighEnergy ? "❌ FAIL (Still recommended)" : "✅ OK";
        if (isHighEnergy) success = false;

        logCallback(`#${i + 1}: ${c.name} (${c.matchScore}%) ${status}`);
        if (c.matchReasoning) logCallback(`   Reasoning: "${c.matchReasoning}"`);
    });

    logCallback("------------------------------------------------");
    if (success) {
        logCallback("✨ SUCCESS: AI learned to penalize 'High Energy' traits for Alice.");
    } else {
        logCallback("⚠️ Personality feedback system test complete.");
    }
};

/**
 * Run REAL ML training with live visualization
 */
export const runTrainingSimulation = async (
  logCallback: (msg: string) => void,
  options: { useRealML?: boolean } = {}
) => {
  if (options.useRealML !== false) {
    // Run real TensorFlow training
    const sessionId = `training-${Date.now()}`;
    
    try {
      await runRealTraining(sessionId, (progress) => {
        if (progress.phase === 'training') {
          logCallback(`📈 Epoch ${progress.epoch}/${progress.totalEpochs} | Loss: ${progress.loss?.toFixed(4)} | Val: ${progress.valLoss?.toFixed(4)}`);
        } else {
          logCallback(progress.message);
        }
      });

      // Show model architecture
      const mlService = getMLTrainingService();
      logCallback('');
      logCallback('🧠 Model Architecture Summary:');
      const summary = mlService.getModelSummary();
      logCallback(summary.substring(0, 500) + '...');

    } catch (error) {
      logCallback(`❌ Training error: ${error}`);
      // Fall back to personality simulation
      logCallback('⚠️ Falling back to personality simulation...');
      await runPersonalitySimulation(logCallback);
    }
  } else {
    // Run legacy personality simulation
    await runPersonalitySimulation(logCallback);
  }
};

/**
 * Export training session for admin dashboard
 */
export const getTrainingSession = (sessionId: string): TrainingSession | undefined => {
  return trainingSessions.get(sessionId);
};

/**
 * Get all training sessions
 */
export const getAllTrainingSessions = (): TrainingSession[] => {
  return Array.from(trainingSessions.values());
};

export { getMLModelStatus, processMatchFeedback, initializeMLService };
