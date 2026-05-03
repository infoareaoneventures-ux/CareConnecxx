import { SystemLog } from './types';

// Production-ready constants
// All test/mock data removed for launch

export const INITIAL_LOGS: SystemLog[] = [
    {
        id: 1,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        event: 'System initialized successfully.',
        type: 'success'
    }
];

// Mock caregivers removed for production
// Real caregivers will be loaded from Firebase
export const MOCK_CAREGIVERS: any[] = [];

/**
 * Default avatar SVG as data URI for caregivers without photos
 */
export const DEFAULT_CAREGIVER_AVATAR = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' fill='%23e2e8f0'/%3E%3Ccircle cx='50' cy='40' r='20' fill='%2394a3b8'/%3E%3Cellipse cx='50' cy='95' rx='35' ry='30' fill='%2394a3b8'/%3E%3C/svg%3E`;
