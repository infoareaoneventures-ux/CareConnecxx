import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Loader2 } from 'lucide-react';

interface LocationValue {
  address: string;
  lat?: number;
  lng?: number;
}

interface LocationInputProps {
  label: string;
  value: string;
  onChange: (value: LocationValue | string) => void;
  placeholder?: string;
  required?: boolean;
}

/**
 * Location input with Google Places PlaceAutocompleteElement
 * Uses the new Extended Component Library instead of deprecated Autocomplete
 * 
 * @example
 * <LocationInput 
 *   label="Your Location" 
 *   value={location} 
 *   onChange={handleLocationChange} 
 * />
 */
export const LocationInput: React.FC<LocationInputProps> = ({
  label,
  value,
  onChange,
  placeholder = "Enter a location",
  required = false
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputId = React.useId();

  useEffect(() => {
    // Track if component is mounted and if autocomplete was created
    let isMounted = true;
    let autocompleteCreated = false;
    
    // Load the Google Extended Component Library for PlaceAutocompleteElement
    const loadPlaceLibrary = async () => {
      try {
        // @ts-ignore - google.maps is loaded via script tag
        if (!window.google?.maps) {
          if (isMounted) {
            setError('Google Maps not loaded');
            setIsLoading(false);
          }
          return;
        }

        // Import the Places library
        // @ts-ignore
        const { Place } = await window.google.maps.importLibrary('places');
        
        if (!inputRef.current || !isMounted || autocompleteCreated) return;

        // Check if autocomplete already exists (prevent duplicates)
        const parent = inputRef.current.parentElement;
        if (parent && parent.querySelector('gmp-place-autocomplete')) {
          autocompleteCreated = true;
          setIsLoading(false);
          return;
        }

        // Create the PlaceAutocompleteElement
        const placeAutocomplete = document.createElement('gmp-place-autocomplete') as any;
        placeAutocomplete.placeholder = placeholder;
        placeAutocomplete.className = 'w-full';
        
        // Note: locationBias removed - causing API errors
        // The PlaceAutocompleteElement works without it
        
        // Listen for place selection
        placeAutocomplete.addEventListener('gmp-select', (event: any) => {
          const place = event.detail.place;
          if (place && place.formattedAddress) {
            const lat = place.location?.lat?.();
            const lng = place.location?.lng?.();
            
            onChange({
              address: place.formattedAddress,
              lat,
              lng
            });
          }
        });

        // Listen for input changes (for manual zip code entry)
        placeAutocomplete.addEventListener('input', (event: any) => {
          const inputValue = event.target?.value || '';
          if (inputValue) {
            onChange(inputValue);
          }
        });

        // Add the autocomplete element below the input
        if (inputRef.current.parentElement) {
          inputRef.current.parentElement.appendChild(placeAutocomplete);
          autocompleteCreated = true;
          
          // Sync initial value if exists
          if (value) {
            placeAutocomplete.value = value;
          }
        }
        
        if (isMounted) {
          setIsLoading(false);
        }
      } catch (err) {
        console.error('Failed to load PlaceAutocompleteElement:', err);
        if (isMounted) {
          // Fallback to regular input with manual fallback
          setError('Using fallback location input');
          setIsLoading(false);
        }
      }
    };

    // Check if Google Maps is loaded, retry if not
    let attempts = 0;
    const checkAndLoad = () => {
      // @ts-ignore
      if (window.google?.maps) {
        loadPlaceLibrary();
      } else if (attempts < 10 && isMounted) {
        attempts++;
        setTimeout(checkAndLoad, 500);
      } else if (isMounted) {
        setError('Google Maps failed to load');
        setIsLoading(false);
      }
    };

    checkAndLoad();

    return () => {
      isMounted = false;
      // Cleanup: remove any created autocomplete elements
      if (inputRef.current?.parentElement) {
        const existing = inputRef.current.parentElement.querySelector('gmp-place-autocomplete');
        if (existing) {
          existing.remove();
        }
      }
    };
  }, []); // Empty dependency array - only run once on mount

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  return (
    <div className="w-full mb-4">
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-700 mb-1">
        {label}
      </label>
      <div className="relative">
        <MapPin className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5 z-10" aria-hidden="true" />
        {isLoading && (
          <Loader2 className="absolute right-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-5 h-5 animate-spin z-10" />
        )}
        <input
          id={inputId}
          ref={inputRef}
          className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-900 focus:outline-none focus:ring-2 focus:border-primary-500 focus:ring-primary-100 hover:border-slate-300 transition-all duration-200"
          placeholder={placeholder}
          value={value}
          onChange={handleInputChange}
          required={required}
          aria-label={label}
        />
      </div>
      {error && (
        <p className="mt-1 text-xs text-accent-600">{error}</p>
      )}
    </div>
  );
};
