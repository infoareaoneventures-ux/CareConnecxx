import { CaregiverMatcherModel, TrainingMetrics } from './mlModel';
import {
  generateTrainingData,
  splitData,
  exportForTensorFlow,
  TrainingSample,
  FEATURE_INDICES
} from './trainingData';

/**
 * ML Training Service
 * Orchestrates training the neural network on synthetic data
 * and manages model lifecycle
 */

export interface TrainingProgress {
  phase: 'preparing' | 'training' | 'validating' | 'complete';
  epoch?: number;
  totalEpochs: number;
  loss?: number;
  valLoss?: number;
  accuracy?: number;
  message: string;
}

export interface TrainingResult {
  success: boolean;
  finalLoss: number;
  finalValLoss: number;
  finalAccuracy: number;
  epochsCompleted: number;
  trainingTimeMs: number;
  samplesUsed: number;
  modelSizeBytes: number;
}

export interface ModelStats {
  version: string;
  trainedAt: string;
  samples: number;
  accuracy: number;
  loss: number;
  modelSizeMB: number;
  architecture: string;
}

// Storage keys
const STORAGE_KEY_MODEL = 'caregiver-matcher-model-v1';
const STORAGE_KEY_STATS = 'caregiver-matcher-stats-v1';
const STORAGE_KEY_HISTORY = 'caregiver-matcher-history-v1';

class MLTrainingService {
  private model: CaregiverMatcherModel;
  private isTraining: boolean = false;
  private abortController: AbortController | null = null;

  constructor() {
    this.model = new CaregiverMatcherModel({
      inputSize: 50,
      hiddenUnits: [128, 64, 32],
      dropoutRate: 0.2,
      learningRate: 0.001
    });
  }

  /**
   * Initialize and optionally load existing model
   */
  async initialize(): Promise<boolean> {
    try {
      const loaded = await this.model.loadModel(STORAGE_KEY_MODEL);
      if (loaded) {
        console.log('[ML Training] Loaded existing model from storage');
        return true;
      }
    } catch (error) {
      console.log('[ML Training] No existing model found');
    }
    
    await this.model.initialize();
    return false;
  }

  /**
   * Train model on 15,000 synthetic samples
   */
  async train(
    onProgress?: (progress: TrainingProgress) => void
  ): Promise<TrainingResult> {
    if (this.isTraining) {
      throw new Error('Training already in progress');
    }

    this.isTraining = true;
    this.abortController = new AbortController();
    const startTime = performance.now();

    try {
      // Phase 1: Prepare data
      onProgress?.({
        phase: 'preparing',
        totalEpochs: 50,
        message: 'Generating 15,000 synthetic training scenarios...'
      });

      const samples = generateTrainingData(15000);
      const { train, validation } = splitData(samples, 0.8);
      const trainData = exportForTensorFlow(train);
      const valData = exportForTensorFlow(validation);

      onProgress?.({
        phase: 'preparing',
        totalEpochs: 50,
        message: `Data ready: ${train.length} training, ${validation.length} validation samples`
      });

      // Phase 2: Train
      onProgress?.({
        phase: 'training',
        totalEpochs: 50,
        message: 'Starting neural network training...'
      });

      const history = await this.model.train(trainData.features, trainData.labels, {
        epochs: 50,
        batchSize: 32,
        validationSplit: 0.1,
        shuffle: true
      });

      // Phase 3: Validate
      onProgress?.({
        phase: 'validating',
        totalEpochs: 50,
        message: 'Running validation on held-out test set...'
      });

      const valPredictions = this.model.predictBatch(valData.features);
      const valAccuracy = this.calculateAccuracy(valPredictions, valData.labels.map(l => l * 100));

      // Phase 4: Save
      await this.model.saveModel(STORAGE_KEY_MODEL);
      
      const finalMetrics = this.model.getFinalMetrics();
      const trainingTimeMs = performance.now() - startTime;
      
      const stats: ModelStats = {
        version: '1.0.0',
        trainedAt: new Date().toISOString(),
        samples: 15000,
        accuracy: valAccuracy,
        loss: finalMetrics?.loss || 0,
        modelSizeMB: 2.5, // Approximate
        architecture: '128-64-32 Dense Neural Network'
      };

      localStorage.setItem(STORAGE_KEY_STATS, JSON.stringify(stats));
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history));

      onProgress?.({
        phase: 'complete',
        totalEpochs: 50,
        message: `Training complete! Accuracy: ${(valAccuracy * 100).toFixed(1)}%`
      });

      return {
        success: true,
        finalLoss: finalMetrics?.loss || 0,
        finalValLoss: finalMetrics?.valLoss || 0,
        finalAccuracy: valAccuracy,
        epochsCompleted: history.length,
        trainingTimeMs,
        samplesUsed: 15000,
        modelSizeBytes: 2.5 * 1024 * 1024
      };

    } catch (error) {
      console.error('[ML Training] Training failed:', error);
      throw error;
    } finally {
      this.isTraining = false;
      this.abortController = null;
    }
  }

  /**
   * Online learning from admin feedback
   */
  async learnFromFeedback(
    feedback: Array<{
      seniorFeatures: number[];
      caregiverFeatures: number[];
      contextFeatures: number[];
      approved: boolean;
      rating?: number;
    }>
  ): Promise<void> {
    if (!this.model.isReady()) {
      await this.initialize();
    }

    // Convert feedback to training samples
    const features: number[][] = [];
    const labels: number[] = [];

    feedback.forEach(item => {
      const combinedFeatures = [
        ...item.seniorFeatures,
        ...item.caregiverFeatures,
        ...item.contextFeatures
      ];
      
      // Use approval status and rating to determine label
      let label = item.approved ? 85 : 30;
      if (item.rating) {
        label = item.rating * 20; // Convert 1-5 rating to 20-100
      }

      features.push(combinedFeatures);
      labels.push(label / 100); // Normalize
    });

    // Lightweight online learning
    await this.model.onlineLearning(features, labels, 2);
    await this.model.saveModel(STORAGE_KEY_MODEL);

    console.log(`[ML Training] Online learning completed with ${feedback.length} feedback samples`);
  }

  /**
   * Get training history for visualization
   */
  getTrainingHistory(): TrainingMetrics[] {
    const stored = localStorage.getItem(STORAGE_KEY_HISTORY);
    if (stored) {
      return JSON.parse(stored);
    }
    return this.model.getTrainingHistory();
  }

  /**
   * Get model statistics
   */
  getModelStats(): ModelStats | null {
    const stored = localStorage.getItem(STORAGE_KEY_STATS);
    return stored ? JSON.parse(stored) : null;
  }

  /**
   * Predict match score using trained model
   */
  predict(features: number[]): number {
    return this.model.predict(features);
  }

  /**
   * Batch prediction
   */
  predictBatch(features: number[][]): number[] {
    return this.model.predictBatch(features);
  }

  /**
   * Check if model is trained and ready
   */
  isModelReady(): boolean {
    return this.model.isReady();
  }

  /**
   * Get model architecture summary
   */
  getModelSummary(): string {
    return this.model.getModelSummary();
  }

  /**
   * Abort training
   */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Calculate accuracy (within 10% tolerance)
   */
  private calculateAccuracy(predictions: number[], actuals: number[]): number {
    let correct = 0;
    for (let i = 0; i < predictions.length; i++) {
      if (Math.abs(predictions[i] - actuals[i]) <= 10) {
        correct++;
      }
    }
    return correct / predictions.length;
  }

  /**
   * Export features from caregiver-senior pair
   */
  extractFeatures(
    caregiver: Caregiver,
    senior: Senior,
    context?: any
  ): number[] {
    const features: number[] = new Array(50).fill(0);

    // Senior needs encoding
    const seniorNeeds = senior.needs || [];
    features[FEATURE_INDICES.SENIOR_AGE] = ((senior.age || 75) - 65) / 30;
    features[FEATURE_INDICES.SENIOR_HAS_DEMENTIA] = seniorNeeds.some(n => n.toLowerCase().includes('dementia')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_HAS_MOBILITY] = seniorNeeds.some(n => n.toLowerCase().includes('mobility')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_NEEDS_MEDICATION] = seniorNeeds.some(n => n.toLowerCase().includes('medication')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_NEEDS_MEAL_PREP] = seniorNeeds.some(n => n.toLowerCase().includes('meal')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_NEEDS_TRANSPORT] = seniorNeeds.some(n => n.toLowerCase().includes('transport')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_NEEDS_HOUSEKEEPING] = seniorNeeds.some(n => n.toLowerCase().includes('housekeeping')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_NEEDS_COMPANIONSHIP] = seniorNeeds.some(n => n.toLowerCase().includes('companionship')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_NEEDS_BATHING] = seniorNeeds.some(n => n.toLowerCase().includes('bathing')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_NEEDS_OVERNIGHT] = seniorNeeds.some(n => n.toLowerCase().includes('overnight')) ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_CARE_HOURS] = (senior.scheduleNeeded?.length || 20) / 168;
    features[FEATURE_INDICES.SENIOR_PREFERS_SAME_GENDER] = senior.genderPreference && senior.genderPreference !== 'No Preference' ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_HAS_PETS] = 0;
    features[FEATURE_INDICES.SENIOR_PERSONALITY_EXTRAVERT] = senior.personality === 'Extrovert' ? 1 : 0;
    features[FEATURE_INDICES.SENIOR_PERSONALITY_INTROVERT] = senior.personality === 'Introvert' ? 1 : 0;

    // Caregiver features
    const caregiverSkills = caregiver.skills || [];
    features[FEATURE_INDICES.CAREGIVER_AGE] = 0.4; // Default normalized
    features[FEATURE_INDICES.CAREGIVER_EXPERIENCE] = (caregiver.experience || 3) / 20;
    features[FEATURE_INDICES.CAREGIVER_RATING] = (caregiver.rating || 4) / 5;
    features[FEATURE_INDICES.CAREGIVER_HOURLY_RATE] = ((caregiver.hourlyRate || 25) - 18) / 27;
    features[FEATURE_INDICES.CAREGIVER_HAS_DEMENTIA_CARE] = caregiverSkills.some(s => s.toLowerCase().includes('dementia')) ? 1 : 0;
    features[FEATURE_INDICES.CAREGIVER_HAS_MEDICAL_TRAINING] = caregiverSkills.some(s =>
      ['medication', 'cna', 'nurse', 'medical'].some(m => s.toLowerCase().includes(m))
    ) ? 1 : 0;
    features[FEATURE_INDICES.CAREGIVER_PET_FRIENDLY] = caregiver.petFriendly ? 1 : 0;
    features[FEATURE_INDICES.CAREGIVER_HAS_CAR] = caregiver.hasTransportation ? 1 : 0;
    features[FEATURE_INDICES.CAREGIVER_SKILLS_COUNT] = caregiverSkills.length / 16;

    // Context features
    const matchedSkills = seniorNeeds.filter(need =>
      caregiverSkills.some(skill =>
        skill.toLowerCase().includes(need.toLowerCase()) ||
        need.toLowerCase().includes(skill.toLowerCase())
      )
    );
    features[FEATURE_INDICES.SKILLS_MATCH_RATIO] = seniorNeeds.length > 0 ? matchedSkills.length / seniorNeeds.length : 0.5;
    features[FEATURE_INDICES.DISTANCE_MILES] = Math.min((context?.distance || 10) / 50, 1);
    features[FEATURE_INDICES.SCHEDULE_OVERLAP] = (context?.scheduleOverlap || 2) / 5;
    features[FEATURE_INDICES.LANGUAGE_MATCH] = context?.languageMatch ? 1 : 0;
    features[FEATURE_INDICES.PRICE_FIT] = context?.priceFit ? 1 : 0;
    features[FEATURE_INDICES.URGENCY_LEVEL] = context?.urgency === 'high' ? 1 : 0;

    return features;
  }
}

// Import types for extractFeatures
import { Caregiver, Senior } from '../types';

// Singleton instance
let trainingService: MLTrainingService | null = null;

export function getMLTrainingService(): MLTrainingService {
  if (!trainingService) {
    trainingService = new MLTrainingService();
  }
  return trainingService;
}

export function resetMLTrainingService(): void {
  trainingService = null;
}

export { MLTrainingService };
export { FEATURE_INDICES } from './trainingData';
