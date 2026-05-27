import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

interface Props {
  data: string;
  size?: number;
  light?: string;
  dark?: string;
  className?: string;
}

export const QRCanvas: React.FC<Props> = ({ data, size = 260, light = '#ffffff', dark = '#0a0a0a', className }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, data, {
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark, light },
    })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [data, size, light, dark]);

  if (error) {
    return (
      <div className={className} style={{ width: size, height: size }}>
        <p className="text-xs text-red-500">QR unavailable — use the phone number below.</p>
      </div>
    );
  }

  return <canvas ref={canvasRef} className={className} width={size} height={size} aria-label="QR code to text Cara" />;
};
