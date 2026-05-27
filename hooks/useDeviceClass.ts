import { useEffect, useState } from 'react';

export type DeviceClass = 'desktop' | 'mobile';

function detect(): DeviceClass {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'desktop';
  const ua = navigator.userAgent;
  const isMobileUA = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  const isiPad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
  const hasTouch = (navigator as any).maxTouchPoints > 0;
  const narrowViewport = window.matchMedia('(max-width: 820px)').matches;
  if (isMobileUA || isiPad) return 'mobile';
  if (hasTouch && narrowViewport) return 'mobile';
  return 'desktop';
}

export function useDeviceClass(): DeviceClass {
  const [klass, setKlass] = useState<DeviceClass>(() => detect());
  useEffect(() => {
    const onResize = () => setKlass(detect());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return klass;
}
