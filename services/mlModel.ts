import * as tf from '@tensorflow/tfjs';

/**
 * Caregiver Matcher Neural Network Model
 * Uses TensorFlow.js for real ML predictions
 * 
 * Model Architecture:
 * - Input: 50 features (senior needs, caregiver skills, context)
 * - Hidden: 128 → 64 → 32 neurons with ReLU activation
 * - Output: 1 neuron (sigmoid) → match score 0-1
 */

export interface ModelConfig {
  inputSize: number;
  hiddenUnits: number[];
  dropoutRate: number;
  learningRate: number;
}

export interface TrainingConfig {
  epochs: number;
  batchSize: number;
  validationSplit: number;
  shuffle: boolean;
}

export interface TrainingMetrics {
  epoch: number;
  loss: number;
  valLoss: number;
  accuracy: number;
  valAccuracy: number;
}

export class CaregiverMatcherModel {
  private model: tf.LayersModel | null = null;
  private config: ModelConfig;
  private trainingHistory: TrainingMetrics[] = [];
  private isInitialized: boolean = false;

  constructor(config: Partial<ModelConfig> = {}) {
    this.config = {
      inputSize: 50,
      hiddenUnits: [128, 64, 32],
      dropoutRate: 0.2,
      learningRate: 0.001,
      ...config
    };
  }

  /**
   * Initialize the neural network model
   */
  async initialize(): Promise<void> {
    if (this.isInitialized && this.model) {
      return;
    }

    this.model = tf.sequential({
      layers: [
        // Input layer + First hidden layer
        tf.layers.dense({
          inputShape: [this.config.inputSize],
          units: this.config.hiddenUnits[0],
          activation: 'relu',
          kernelInitializer: 'heNormal'
        }),
        tf.layers.batchNormalization(),
        tf.layers.dropout({ rate: this.config.dropoutRate }),

        // Second hidden layer
        tf.layers.dense({
          units: this.config.hiddenUnits[1],
          activation: 'relu',
          kernelInitializer: 'heNormal'
        }),
        tf.layers.batchNormalization(),
        tf.layers.dropout({ rate: this.config.dropoutRate * 0.5 }),

        // Third hidden layer
        tf.layers.dense({
          units: this.config.hiddenUnits[2],
          activation: 'relu',
          kernelInitializer: 'heNormal'
        }),

        // Output layer - match score 0-1
        tf.layers.dense({
          units: 1,
          activation: 'sigmoid'
        })
      ]
    });

    // Compile with Adam optimizer and MSE loss
    this.model.compile({
      optimizer: tf.train.adam(this.config.learningRate),
      loss: 'meanSquaredError',
      metrics: ['mse', 'mae']
    });

    this.isInitialized = true;
    console.log('[ML Model] Initialized with architecture:', this.model.summary());
  }

  /**
   * Get model summary as string
   */
  getModelSummary(): string {
    if (!this.model) return 'Model not initialized';
    
    let summary = '';
    (this.model as any).summary({
      printFn: (line: string) => { summary += line + '\n'; }
    });
    return summary;
  }

  /**
   * Train the model on synthetic data
   */
  async train(
    features: number[][],
    labels: number[],
    config: Partial<TrainingConfig> = {}
  ): Promise<TrainingMetrics[]> {
    if (!this.model) {
      await this.initialize();
    }

    const trainingConfig: TrainingConfig = {
      epochs: 50,
      batchSize: 32,
      validationSplit: 0.2,
      shuffle: true,
      ...config
    };

    // Convert to tensors
    const xs = tf.tensor2d(features);
    const ys = tf.tensor2d(labels.map(l => [l]));

    this.trainingHistory = [];

    // Train with callbacks for progress tracking
    await this.model!.fit(xs, ys, {
      epochs: trainingConfig.epochs,
      batchSize: trainingConfig.batchSize,
      validationSplit: trainingConfig.validationSplit,
      shuffle: trainingConfig.shuffle,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          const metrics: TrainingMetrics = {
            epoch: epoch + 1,
            loss: logs?.loss || 0,
            valLoss: logs?.val_loss || 0,
            accuracy: 1 - (logs?.loss || 0), // Approximation
            valAccuracy: 1 - (logs?.val_loss || 0)
          };
          this.trainingHistory.push(metrics);
          
          if ((epoch + 1) % 10 === 0) {
            console.log(`[ML Training] Epoch ${epoch + 1}/${trainingConfig.epochs} - Loss: ${logs?.loss?.toFixed(4)}, Val Loss: ${logs?.val_loss?.toFixed(4)}`);
          }
        }
      }
    });

    // Cleanup tensors
    xs.dispose();
    ys.dispose();

    return this.trainingHistory;
  }

  /**
   * Online learning - update model with new feedback
   */
  async onlineLearning(
    features: number[][],
    labels: number[],
    epochs: number = 2
  ): Promise<void> {
    if (!this.model) {
      throw new Error('Model not initialized');
    }

    const xs = tf.tensor2d(features);
    const ys = tf.tensor2d(labels.map(l => [l]));

    // Lightweight retraining with lower learning rate
    const originalLR = this.config.learningRate;
    this.model.compile({
      optimizer: tf.train.adam(originalLR * 0.1), // Lower LR for fine-tuning
      loss: 'meanSquaredError',
      metrics: ['mse']
    });

    await this.model.fit(xs, ys, {
      epochs,
      batchSize: 8,
      verbose: 0
    });

    // Restore original learning rate
    this.model.compile({
      optimizer: tf.train.adam(originalLR),
      loss: 'meanSquaredError',
      metrics: ['mse']
    });

    xs.dispose();
    ys.dispose();

    console.log('[ML Model] Online learning completed - model updated with feedback');
  }

  /**
   * Predict match score for a caregiver-senior pair
   */
  predict(features: number[]): number {
    if (!this.model) {
      throw new Error('Model not initialized');
    }

    const input = tf.tensor2d([features]);
    const prediction = this.model.predict(input) as tf.Tensor;
    const score = prediction.dataSync()[0];
    
    input.dispose();
    prediction.dispose();

    return Math.round(score * 100); // Convert to 0-100 score
  }

  /**
   * Batch prediction for multiple pairs
   */
  predictBatch(features: number[][]): number[] {
    if (!this.model) {
      throw new Error('Model not initialized');
    }

    const input = tf.tensor2d(features);
    const predictions = this.model.predict(input) as tf.Tensor;
    const scores = Array.from(predictions.dataSync()).map(s => Math.round(s * 100));
    
    input.dispose();
    predictions.dispose();

    return scores;
  }

  /**
   * Save model to storage
   */
  async saveModel(path: string): Promise<void> {
    if (!this.model) {
      throw new Error('Model not initialized');
    }

    await this.model.save(`localstorage://${path}`);
    console.log(`[ML Model] Saved to ${path}`);
  }

  /**
   * Load model from storage
   */
  async loadModel(path: string): Promise<boolean> {
    try {
      this.model = await tf.loadLayersModel(`localstorage://${path}`);
      this.isInitialized = true;
      console.log(`[ML Model] Loaded from ${path}`);
      return true;
    } catch (error) {
      console.log('[ML Model] No saved model found, will train from scratch');
      return false;
    }
  }

  /**
   * Export model weights for Firebase storage
   */
  exportWeights(): ArrayBuffer {
    if (!this.model) {
      throw new Error('Model not initialized');
    }

    const weights = this.model.getWeights();
    // Convert to serializable format
    const weightData = weights.map(w => ({
      shape: w.shape,
      data: Array.from(w.dataSync())
    }));

    return new TextEncoder().encode(JSON.stringify(weightData)).buffer as ArrayBuffer;
  }

  /**
   * Get training history
   */
  getTrainingHistory(): TrainingMetrics[] {
    return this.trainingHistory;
  }

  /**
   * Get final training metrics
   */
  getFinalMetrics(): TrainingMetrics | null {
    if (this.trainingHistory.length === 0) return null;
    return this.trainingHistory[this.trainingHistory.length - 1];
  }

  /**
   * Check if model is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.model !== null;
  }

  /**
   * Dispose model to free memory
   */
  dispose(): void {
    if (this.model) {
      this.model.dispose();
      this.model = null;
      this.isInitialized = false;
    }
  }
}

// Singleton instance
let modelInstance: CaregiverMatcherModel | null = null;

export function getMLModel(): CaregiverMatcherModel {
  if (!modelInstance) {
    modelInstance = new CaregiverMatcherModel();
  }
  return modelInstance;
}

export function resetMLModel(): void {
  if (modelInstance) {
    modelInstance.dispose();
    modelInstance = null;
  }
}
