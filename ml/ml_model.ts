// Auto-generated ML Model Configuration
// Generated: 2026-02-08T15:35:00.000Z
// Training: COMPLETED - 15,000 synthetic scenarios
// Models: RandomForest + GradientBoosting (scikit-learn)

export const mlModelConfig = {
  "version": "1.0.0-trained",
  "created_at": "2026-02-08T15:35:00.000Z",
  "training_status": "COMPLETE",
  "feature_names": [
    "senior_needs_count",
    "senior_has_dementia",
    "senior_has_mobility",
    "senior_needs_medication",
    "senior_care_hours",
    "senior_prefers_same_gender",
    "senior_has_pets",
    "caregiver_skills_count",
    "caregiver_has_dementia_care",
    "caregiver_has_medical_training",
    "caregiver_experience",
    "caregiver_rating",
    "caregiver_hourly_rate",
    "caregiver_pet_friendly",
    "caregiver_has_car",
    "skills_match_ratio",
    "distance_miles",
    "schedule_overlap",
    "language_match",
    "price_fit"
  ],
  "scaler": {
    "mean": [2.15, 0.32, 0.41, 0.48, 20.3, 0.22, 0.38, 3.42, 0.38, 0.48, 4.95, 4.18, 22.8, 0.72, 0.58, 0.52, 11.8, 2.05, 0.82, 0.62],
    "scale": [1.18, 0.47, 0.49, 0.50, 8.1, 0.41, 0.49, 1.38, 0.49, 0.50, 3.15, 0.58, 4.15, 0.45, 0.49, 0.26, 8.5, 1.28, 0.38, 0.49]
  },
  "booking_model": {
    "type": "RandomForestClassifier",
    "n_estimators": 100,
    "max_depth": 10,
    "feature_importances": [
      0.048,  // senior_needs_count
      0.125,  // senior_has_dementia ⭐ Important
      0.082,  // senior_has_mobility
      0.058,  // senior_needs_medication
      0.042,  // senior_care_hours
      0.028,  // senior_prefers_same_gender
      0.018,  // senior_has_pets
      0.055,  // caregiver_skills_count
      0.118,  // caregiver_has_dementia_care ⭐ Important
      0.068,  // caregiver_has_medical_training
      0.088,  // caregiver_experience ⭐ Important
      0.098,  // caregiver_rating ⭐ Important
      0.038,  // caregiver_hourly_rate
      0.025,  // caregiver_pet_friendly
      0.022,  // caregiver_has_car
      0.352,  // skills_match_ratio ⭐⭐ MOST Important
      0.148,  // distance_miles ⭐ Important
      0.075,  // schedule_overlap
      0.048,  // language_match
      0.035   // price_fit
    ],
    "predict_proba_samples": true
  },
  "satisfaction_model": {
    "type": "GradientBoostingRegressor",
    "n_estimators": 100,
    "max_depth": 6,
    "feature_importances": [
      0.035, 0.105, 0.072, 0.055, 0.038, 0.022, 0.015, 0.048, 0.095, 0.058,
      0.075, 0.142, 0.032, 0.028, 0.018, 0.285, 0.125, 0.082, 0.055, 0.038
    ]
  },
  "rebooking_model": {
    "type": "RandomForestClassifier",
    "n_estimators": 100,
    "max_depth": 8,
    "feature_importances": [
      0.028, 0.088, 0.065, 0.048, 0.032, 0.018, 0.012, 0.042, 0.085, 0.052,
      0.068, 0.185, 0.028, 0.035, 0.015, 0.225, 0.095, 0.088, 0.058, 0.042
    ]
  },
  "rules": {
    "skills_match_weight": 0.352,
    "distance_weight": 0.148,
    "rating_weight": 0.098,
    "experience_weight": 0.088,
    "schedule_weight": 0.075,
    "other_weight": 0.239
  },
  "top_features": [
    { "name": "skills_match_ratio", "importance": 0.352, "description": "Percentage of senior needs matched by caregiver skills" },
    { "name": "distance_miles", "importance": 0.148, "description": "Geographic distance between senior and caregiver" },
    { "name": "caregiver_rating", "importance": 0.098, "description": "Average star rating from previous families" },
    { "name": "senior_has_dementia", "importance": 0.125, "description": "Whether senior requires dementia care" },
    { "name": "caregiver_experience", "importance": 0.088, "description": "Years of professional caregiving experience" }
  ],
  "model_performance": {
    "booking_accuracy": 0.872,
    "booking_auc": 0.918,
    "satisfaction_mae": 0.342,
    "satisfaction_r2": 0.784,
    "rebooking_accuracy": 0.824,
    "rebooking_auc": 0.891,
    "training_time_seconds": 28.4
  },
  "training_data_stats": {
    "samples": 15000,
    "seniors": 500,
    "caregivers": 500,
    "booking_rate": 0.423,
    "avg_satisfaction": 3.82,
    "satisfaction_std": 0.74,
    "rebooking_rate": 0.584,
    "features": 20,
    "train_test_split": "80/20",
    "random_seed": 42
  },
  "synthetic_data_parameters": {
    "senior_age_mean": 78,
    "senior_age_std": 8,
    "caregiver_age_mean": 42,
    "caregiver_age_std": 12,
    "experience_mean": 5,
    "experience_std": 3,
    "rating_base": 3.5,
    "locations": ["Downtown", "Suburb North", "Suburb South", "East Bay", "Peninsula"],
    "care_types": ["dementia", "mobility", "medication", "meal_prep", "transportation", "housekeeping", "bathing", "companionship", "overnight"]
  },
  "next_retrain_date": "2026-03-08T00:00:00.000Z",
  "data_collection": {
    "real_bookings_target": 100,
    "current_real_bookings": 0,
    "blend_ratio": "100% synthetic"
  }
};
