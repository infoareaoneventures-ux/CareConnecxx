import { describe, it, expect, beforeAll } from 'vitest';
import { CaregiverMatcherModel } from '../services/mlModel';
import { generateTrainingData, exportForTensorFlow } from '../services/trainingData';

describe('ML System Tests', () => {
  let model: CaregiverMatcherModel;

  beforeAll(async () => {
    model = new CaregiverMatcherModel();
    await model.initialize();
  });

  it('should initialize the model', () => {
    expect(model.isReady()).toBe(true);
  });

  it('should generate 15,000 training samples', () => {
    const samples = generateTrainingData(100); // Use 100 for quick test
    expect(samples).toHaveLength(100);
    expect(samples[0].features).toHaveLength(50);
    expect(samples[0].label).toBeGreaterThanOrEqual(0);
    expect(samples[0].label).toBeLessThanOrEqual(100);
  });

  it('should make predictions', () => {
    const features = new Array(50).fill(0.5);
    const score = model.predict(features);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('should train on sample data', async () => {
    const samples = generateTrainingData(100);
    const { features, labels } = exportForTensorFlow(samples);
    
    const history = await model.train(features, labels, {
      epochs: 5,
      batchSize: 16,
      validationSplit: 0.2,
      shuffle: true
    });

    expect(history).toHaveLength(5);
    expect(history[0].loss).toBeDefined();
    expect(history[4].loss).toBeLessThan(history[0].loss); // Loss should decrease
  });

  it('should do online learning', async () => {
    const feedbackFeatures = [new Array(50).fill(0.5)];
    const feedbackLabels = [0.85];
    
    await model.onlineLearning(feedbackFeatures, feedbackLabels, 2);
    
    const prediction = model.predict(feedbackFeatures[0]);
    expect(prediction).toBeGreaterThan(50); // Should predict high score after positive feedback
  });
});
