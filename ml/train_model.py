#!/usr/bin/env python3
"""
CareConnex ML Model Trainer
Generates synthetic data and trains matching model
"""

import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier, GradientBoostingRegressor
from sklearn.preprocessing import StandardScaler, LabelEncoder
import json
import random
from datetime import datetime, timedelta

# Constants
CARE_TYPES = [
    'dementia', 'mobility', 'medication', 'meal_prep', 'transportation',
    'housekeeping', 'bathing', 'companionship', 'overnight'
]

PERSONALITIES = ['introvert', 'extrovert', 'ambivert']
SCHEDULES = ['mornings', 'afternoons', 'evenings', 'overnight', 'weekends']
LOCATIONS = [
    {'name': 'Downtown', 'lat': 37.7749, 'lng': -122.4194},
    {'name': 'Suburb North', 'lat': 37.8049, 'lng': -122.4294},
    {'name': 'Suburb South', 'lat': 37.7449, 'lng': -122.4094},
    {'name': 'East Bay', 'lat': 37.8044, 'lng': -122.2711},
    {'name': 'Peninsula', 'lat': 37.4849, 'lng': -122.2281}
]

class SyntheticDataGenerator:
    """Generates realistic synthetic care scenarios"""
    
    def __init__(self, seed=42):
        np.random.seed(seed)
        random.seed(seed)
        
    def generate_senior(self, senior_id):
        """Generate a realistic senior profile"""
        needs_count = np.random.randint(1, 4)
        needs = np.random.choice(CARE_TYPES, needs_count, replace=False).tolist()
        
        location = random.choice(LOCATIONS)
        # Add some randomness to location
        lat = location['lat'] + np.random.normal(0, 0.02)
        lng = location['lng'] + np.random.normal(0, 0.02)
        
        schedules = np.random.choice(SCHEDULES, np.random.randint(1, 4), replace=False).tolist()
        
        return {
            'id': f'senior_{senior_id}',
            'age': int(np.random.normal(78, 8)),
            'needs': needs,
            'needs_count': len(needs),
            'has_dementia': 'dementia' in needs,
            'has_mobility': 'mobility' in needs,
            'needs_medication': 'medication' in needs,
            'personality': random.choice(PERSONALITIES),
            'location_lat': lat,
            'location_lng': lng,
            'location_name': location['name'],
            'schedules': schedules,
            'prefers_same_gender': np.random.random() > 0.7,
            'has_pets': np.random.random() > 0.6,
            'language_preference': np.random.choice(['english', 'spanish', 'chinese', 'english'], p=[0.7, 0.15, 0.1, 0.05]),
            'care_hours_per_week': int(np.random.normal(20, 10))
        }
    
    def generate_caregiver(self, caregiver_id):
        """Generate a realistic caregiver profile"""
        skills_count = np.random.randint(2, 6)
        skills = np.random.choice(CARE_TYPES, skills_count, replace=False).tolist()
        
        location = random.choice(LOCATIONS)
        lat = location['lat'] + np.random.normal(0, 0.03)
        lng = location['lng'] + np.random.normal(0, 0.03)
        
        schedules = np.random.choice(SCHEDULES, np.random.randint(2, 5), replace=False).tolist()
        
        # Experience correlates with skills
        experience = max(0, int(np.random.normal(5, 3)))
        
        # Rating based on experience (with noise)
        base_rating = 3.5 + (experience / 10)
        rating = min(5.0, max(1.0, base_rating + np.random.normal(0, 0.3)))
        
        # Hourly rate based on experience and skills
        base_rate = 18 + (experience * 0.8) + (len(skills) * 0.5)
        hourly_rate = int(base_rate + np.random.normal(0, 2))
        
        return {
            'id': f'caregiver_{caregiver_id}',
            'age': int(np.random.normal(42, 12)),
            'skills': skills,
            'skills_count': len(skills),
            'has_dementia_care': 'dementia' in skills,
            'has_medical_training': any(s in skills for s in ['medication', 'bathing']),
            'experience_years': experience,
            'rating': round(rating, 2),
            'rating_count': int(np.random.exponential(15)),
            'hourly_rate': hourly_rate,
            'location_lat': lat,
            'location_lng': lng,
            'availability': schedules,
            'languages': np.random.choice(['english', 'spanish', 'chinese', 'english'], 
                                         size=np.random.randint(1, 3), replace=False).tolist(),
            'pet_friendly': np.random.random() > 0.3,
            'has_car': np.random.random() > 0.4,
            'certified': np.random.random() > 0.5
        }
    
    def calculate_match_score(self, senior, caregiver):
        """
        Calculate theoretical match quality based on logical rules.
        This simulates what we expect the ML to learn.
        """
        score = 50.0  # Base score
        
        # Skills match (most important)
        senior_needs = set(senior['needs'])
        caregiver_skills = set(caregiver['skills'])
        skills_matched = len(senior_needs & caregiver_skills)
        skills_match_ratio = skills_matched / len(senior_needs) if senior_needs else 0
        score += skills_match_ratio * 30
        
        # Distance (closer is better)
        distance = self.haversine_distance(
            senior['location_lat'], senior['location_lng'],
            caregiver['location_lat'], caregiver['location_lng']
        )
        if distance < 5:
            score += 15
        elif distance < 15:
            score += 8
        elif distance < 30:
            score += 3
        
        # Rating quality
        score += (caregiver['rating'] - 3) * 5
        
        # Experience for complex needs
        if senior['needs_count'] > 2 and caregiver['experience_years'] > 3:
            score += 10
        
        # Schedule overlap
        schedule_overlap = len(set(senior['schedules']) & set(caregiver['availability']))
        score += schedule_overlap * 3
        
        # Pet compatibility
        if senior['has_pets'] and caregiver['pet_friendly']:
            score += 5
        
        # Language match
        if senior['language_preference'] in caregiver['languages']:
            score += 10
        
        # Personality (weaker signal)
        if senior['personality'] == caregiver.get('personality', 'ambivert'):
            score += 3
        
        # Price sensitivity (seniors with fewer hours may prefer lower rates)
        if senior['care_hours_per_week'] < 10 and caregiver['hourly_rate'] < 22:
            score += 5
        
        return min(100, max(0, score))
    
    @staticmethod
    def haversine_distance(lat1, lng1, lat2, lng2):
        """Calculate distance in miles"""
        R = 3959
        lat1, lng1, lat2, lng2 = map(np.radians, [lat1, lng1, lat2, lng2])
        dlat = lat2 - lat1
        dlng = lng2 - lng1
        a = np.sin(dlat/2)**2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlng/2)**2
        return 2 * R * np.arcsin(np.sqrt(a))
    
    def simulate_outcome(self, match_score):
        """Simulate whether this match results in booking and satisfaction"""
        # Higher match score = higher probability of booking
        booking_prob = 0.1 + (match_score / 100) * 0.85
        
        # Add some noise
        booking_prob += np.random.normal(0, 0.05)
        booked = np.random.random() < booking_prob
        
        if not booked:
            return {
                'booked': False,
                'satisfaction': None,
                'completed': False,
                'rating': None,
                'rebooked': False
            }
        
        # If booked, satisfaction correlates with match score
        base_satisfaction = match_score / 100
        satisfaction = min(5, max(1, base_satisfaction * 5 + np.random.normal(0, 0.5)))
        completed = np.random.random() < 0.95  # 95% completion rate
        
        if completed:
            rating = min(5, max(1, satisfaction + np.random.normal(0, 0.3)))
            # Rebooking depends on satisfaction
            rebook_prob = 0.2 + (satisfaction / 5) * 0.7
            rebooked = np.random.random() < rebook_prob
        else:
            rating = None
            rebooked = False
        
        return {
            'booked': True,
            'satisfaction': round(satisfaction, 2),
            'completed': completed,
            'rating': round(rating, 2) if rating else None,
            'rebooked': rebooked
        }
    
    def generate_dataset(self, n_samples=10000, n_seniors=500, n_caregivers=500):
        """Generate complete synthetic dataset"""
        print(f"Generating {n_samples} synthetic care scenarios...")
        
        # Generate pool of seniors and caregivers
        seniors = [self.generate_senior(i) for i in range(n_seniors)]
        caregivers = [self.generate_caregiver(i) for i in range(n_caregivers)]
        
        data = []
        for i in range(n_samples):
            senior = random.choice(seniors)
            caregiver = random.choice(caregivers)
            
            match_score = self.calculate_match_score(senior, caregiver)
            outcome = self.simulate_outcome(match_score)
            
            record = {
                # Senior features
                'senior_age': senior['age'],
                'senior_needs_count': senior['needs_count'],
                'senior_has_dementia': int(senior['has_dementia']),
                'senior_has_mobility': int(senior['has_mobility']),
                'senior_needs_medication': int(senior['needs_medication']),
                'senior_care_hours': senior['care_hours_per_week'],
                'senior_prefers_same_gender': int(senior['prefers_same_gender']),
                'senior_has_pets': int(senior['has_pets']),
                
                # Caregiver features
                'caregiver_age': caregiver['age'],
                'caregiver_skills_count': caregiver['skills_count'],
                'caregiver_has_dementia_care': int(caregiver['has_dementia_care']),
                'caregiver_has_medical_training': int(caregiver['has_medical_training']),
                'caregiver_experience': caregiver['experience_years'],
                'caregiver_rating': caregiver['rating'],
                'caregiver_hourly_rate': caregiver['hourly_rate'],
                'caregiver_pet_friendly': int(caregiver['pet_friendly']),
                'caregiver_has_car': int(caregiver['has_car']),
                
                # Match features
                'skills_match_ratio': len(set(senior['needs']) & set(caregiver['skills'])) / max(len(senior['needs']), 1),
                'distance_miles': self.haversine_distance(
                    senior['location_lat'], senior['location_lng'],
                    caregiver['location_lat'], caregiver['location_lng']
                ),
                'schedule_overlap': len(set(senior['schedules']) & set(caregiver['availability'])),
                'language_match': int(senior['language_preference'] in caregiver['languages']),
                'price_fit': int(caregiver['hourly_rate'] < 25 or senior['care_hours_per_week'] > 15),
                
                # Calculated score
                'calculated_match_score': round(match_score, 2),
                
                # Outcomes (targets)
                'booked': int(outcome['booked']),
                'satisfaction': outcome['satisfaction'] or 0,
                'completed': int(outcome['completed']),
                'rating': outcome['rating'] or 0,
                'rebooked': int(outcome['rebooked'])
            }
            
            data.append(record)
            
            if (i + 1) % 1000 == 0:
                print(f"  Generated {i + 1} samples...")
        
        return pd.DataFrame(data)


class MatchPredictionModel:
    """Trains and exports ML model for caregiver matching"""
    
    def __init__(self):
        self.scaler = StandardScaler()
        self.booking_model = None
        self.satisfaction_model = None
        self.rebooking_model = None
        
    def prepare_features(self, df):
        """Extract and scale features"""
        feature_cols = [
            'senior_needs_count', 'senior_has_dementia', 'senior_has_mobility',
            'senior_needs_medication', 'senior_care_hours', 'senior_prefers_same_gender',
            'senior_has_pets', 'caregiver_skills_count', 'caregiver_has_dementia_care',
            'caregiver_has_medical_training', 'caregiver_experience', 'caregiver_rating',
            'caregiver_hourly_rate', 'caregiver_pet_friendly', 'caregiver_has_car',
            'skills_match_ratio', 'distance_miles', 'schedule_overlap',
            'language_match', 'price_fit'
        ]
        
        X = df[feature_cols].fillna(0)
        return X, feature_cols
    
    def train(self, df):
        """Train all prediction models"""
        print("\nTraining ML models...")
        
        X, feature_names = self.prepare_features(df)
        X_scaled = self.scaler.fit_transform(X)
        
        # Model 1: Will they book?
        print("  Training booking prediction model...")
        y_booked = df['booked'].values
        self.booking_model = RandomForestClassifier(
            n_estimators=100,
            max_depth=10,
            random_state=42
        )
        self.booking_model.fit(X_scaled, y_booked)
        
        # Model 2: Satisfaction prediction (only for booked matches)
        print("  Training satisfaction model...")
        booked_mask = df['booked'] == 1
        X_booked = X_scaled[booked_mask]
        y_satisfaction = df[booked_mask]['satisfaction'].values
        
        self.satisfaction_model = GradientBoostingRegressor(
            n_estimators=100,
            max_depth=6,
            random_state=42
        )
        self.satisfaction_model.fit(X_booked, y_satisfaction)
        
        # Model 3: Will they rebook?
        print("  Training rebooking prediction model...")
        completed_mask = (df['booked'] == 1) & (df['completed'] == 1)
        X_completed = X_scaled[completed_mask]
        y_rebooked = df[completed_mask]['rebooked'].values
        
        self.rebooking_model = RandomForestClassifier(
            n_estimators=100,
            max_depth=8,
            random_state=42
        )
        self.rebooking_model.fit(X_completed, y_rebooked)
        
        print("✅ Models trained successfully!")
        
        # Feature importance
        importance = pd.DataFrame({
            'feature': feature_names,
            'importance': self.booking_model.feature_importances_
        }).sort_values('importance', ascending=False)
        
        print("\nTop 10 most important features:")
        print(importance.head(10).to_string(index=False))
        
        return feature_names
    
    def evaluate(self, df):
        """Evaluate model performance"""
        from sklearn.metrics import accuracy_score, classification_report, mean_absolute_error
        
        print("\n📊 Model Evaluation:")
        
        X, _ = self.prepare_features(df)
        X_scaled = self.scaler.transform(X)
        
        # Booking prediction accuracy
        y_booked_pred = self.booking_model.predict(X_scaled)
        y_booked_true = df['booked'].values
        
        print(f"\nBooking Prediction Accuracy: {accuracy_score(y_booked_true, y_booked_pred):.3f}")
        
        # Satisfaction prediction
        booked_mask = df['booked'] == 1
        y_satisfaction_pred = self.satisfaction_model.predict(X_scaled[booked_mask])
        y_satisfaction_true = df[booked_mask]['satisfaction'].values
        
        print(f"Satisfaction MAE: {mean_absolute_error(y_satisfaction_true, y_satisfaction_pred):.3f}")
        
        # Rebooking prediction
        completed_mask = (df['booked'] == 1) & (df['completed'] == 1)
        y_rebooked_pred = self.rebooking_model.predict(X_scaled[completed_mask])
        y_rebooked_true = df[completed_mask]['rebooked'].values
        
        print(f"Rebooking Accuracy: {accuracy_score(y_rebooked_true, y_rebooked_pred):.3f}")
    
    def export_to_json(self, feature_names, output_path='ml_model.json'):
        """Export model parameters for TensorFlow.js conversion"""
        print(f"\nExporting model to {output_path}...")
        
        model_data = {
            'version': '1.0.0',
            'created_at': datetime.now().isoformat(),
            'feature_names': feature_names,
            'scaler': {
                'mean': self.scaler.mean_.tolist(),
                'scale': self.scaler.scale_.tolist()
            },
            'booking_model': {
                'type': 'RandomForestClassifier',
                'n_estimators': self.booking_model.n_estimators,
                'feature_importances': self.booking_model.feature_importances_.tolist(),
                # Note: Full tree export is complex, we'll use a simplified version
                'predict_proba_samples': True  # Flag to use predict_proba
            },
            'satisfaction_model': {
                'type': 'GradientBoostingRegressor',
                'n_estimators': self.satisfaction_model.n_estimators
            },
            'rebooking_model': {
                'type': 'RandomForestClassifier',
                'n_estimators': self.rebooking_model.n_estimators
            },
            'rules': {
                # Simplified rules for JavaScript implementation
                'skills_match_weight': 0.35,
                'distance_weight': 0.15,
                'rating_weight': 0.10,
                'experience_weight': 0.10,
                'schedule_weight': 0.15,
                'other_weight': 0.15
            }
        }
        
        with open(output_path, 'w') as f:
            json.dump(model_data, f, indent=2)
        
        print(f"✅ Model exported to {output_path}")
        
        # Also export as JavaScript module
        js_output = output_path.replace('.json', '.js')
        with open(js_output, 'w') as f:
            f.write(f"// Auto-generated ML Model - {datetime.now().isoformat()}\n")
            f.write("export const mlModelConfig = ")
            json.dump(model_data, f, indent=2)
            f.write(";\n")
        
        print(f"✅ JavaScript model exported to {js_output}")


def main():
    """Main training pipeline"""
    print("=" * 60)
    print("CareConnex ML Model Training Pipeline")
    print("=" * 60)
    
    # Generate synthetic data
    generator = SyntheticDataGenerator(seed=42)
    df = generator.generate_dataset(
        n_samples=15000,
        n_seniors=500,
        n_caregivers=500
    )
    
    # Save raw data
    df.to_csv('synthetic_training_data.csv', index=False)
    print(f"\n✅ Generated {len(df)} training samples")
    print(f"   Booking rate: {df['booked'].mean():.1%}")
    print(f"   Rebooking rate: {df[df['booked']==1]['rebooked'].mean():.1%}")
    print(f"   Avg satisfaction: {df[df['booked']==1]['satisfaction'].mean():.2f}")
    
    # Split data
    train_df, test_df = train_test_split(df, test_size=0.2, random_state=42)
    
    # Train models
    model = MatchPredictionModel()
    feature_names = model.train(train_df)
    
    # Evaluate
    model.evaluate(test_df)
    
    # Export
    model.export_to_json(feature_names, 'ml_model.json')
    
    print("\n" + "=" * 60)
    print("Training Complete!")
    print("=" * 60)


if __name__ == '__main__':
    main()
