/// <reference types="vite/client" />

/**
 * Type definitions for Vite environment variables
 * All VITE_ prefixed env vars must be declared here for TypeScript support
 */

interface ImportMetaEnv {
  /** Encryption key for PII data */
  readonly VITE_ENCRYPTION_KEY: string
  
  /** Pepper for SSN hashing */
  readonly VITE_SSN_PEPPER: string
  
  /** Firebase API Key */
  readonly VITE_FIREBASE_API_KEY?: string
  
  /** Firebase Auth Domain */
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  
  /** Firebase Project ID */
  readonly VITE_FIREBASE_PROJECT_ID?: string
  
  /** Firebase Storage Bucket */
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string
  
  /** Firebase Messaging Sender ID */
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string
  
  /** Firebase App ID */
  readonly VITE_FIREBASE_APP_ID?: string
  
  /** Stripe Publishable Key */
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string
  
  /** API Base URL */
  readonly VITE_API_BASE_URL?: string
  
  /** Environment name */
  readonly VITE_ENV?: 'development' | 'staging' | 'production'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
